import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import type { EnvironmentConfig } from './config.js';

/** Default location of the Vite build output (`npm run build -w apps/web`). */
export const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../../apps/web/dist', import.meta.url));

export interface WebStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  /** API origin the browser may call (added to CSP `connect-src`), e.g. the HTTP API endpoint. */
  readonly apiUrl?: string;
  /** Custom domain(s) and an ACM certificate ARN (must be in us-east-1); enables min TLS 1.2. */
  readonly domainNames?: readonly string[];
  readonly certificateArn?: string;
  /** Built web assets directory. Defaults to `apps/web/dist`; a placeholder page is deployed if absent. */
  readonly webAssetPath?: string;
}

const PLACEHOLDER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Serendipity Engine</title></head>' +
  '<body><p>Web build not deployed. Run the web build and redeploy.</p></body></html>';

/** Builds the Content-Security-Policy; only the API origin is allowed for network calls. */
export function buildCsp(apiUrl?: string): string {
  const connect = ["'self'", ...(apiUrl ? [new URL(apiUrl).origin] : [])].join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** Static web hosting: private S3 bucket behind CloudFront (OAC, TLS 1.2+, security headers). */
export class WebStack extends Stack {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.destroyOnDelete ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: config.destroyOnDelete,
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: buildCsp(props.apiUrl), override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
            override: true,
          },
        ],
      },
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Serendipity Engine ${config.name} web`,
      defaultRootObject: 'index.html',
      // Min TLS applies only with a custom certificate; the default *.cloudfront.net cert is fixed by AWS.
      ...(props.certificateArn && props.domainNames?.length
        ? {
            certificate: acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn),
            domainNames: [...props.domainNames],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {}),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(
          this.bucket as unknown as s3.IBucket,
        ),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // SPA fallback: the private bucket answers 403 for missing keys.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });

    const assetPath = props.webAssetPath ?? DEFAULT_WEB_DIST;
    new s3deploy.BucketDeployment(this, 'DeploySite', {
      destinationBucket: this.bucket as unknown as s3.IBucket,
      sources: existsSync(assetPath)
        ? [s3deploy.Source.asset(assetPath)]
        : [s3deploy.Source.data('index.html', PLACEHOLDER_HTML)],
      distribution: this.distribution,
      distributionPaths: ['/*'],
      prune: true,
    });

    Tags.of(this).add('Project', 'serendipity-engine');
    Tags.of(this).add('Environment', config.name);
    Tags.of(this).add('ManagedBy', 'cdk');
    for (const [k, v] of Object.entries(config.tags)) Tags.of(this).add(k, v);

    new CfnOutput(this, 'WebUrl', { value: `https://${this.distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
