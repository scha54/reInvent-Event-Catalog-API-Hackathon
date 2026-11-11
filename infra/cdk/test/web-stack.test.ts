import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { resolveEnvironmentConfig } from '../src/config.js';
import { buildCsp, WebStack } from '../src/web-stack.js';

const environments = {
  dev: {
    noncurrentVersionRetentionDays: 7,
    stagingRetentionDays: 7,
    snapshotInfrequentAccessAfterDays: 30,
    destroyOnDelete: true,
  },
};

const app = new App();
const stack = new WebStack(app, 'W', {
  config: resolveEnvironmentConfig('dev', environments),
  apiUrl: 'https://abc.execute-api.us-east-1.amazonaws.com',
  webAssetPath: '/nonexistent-web-dist',
  domainNames: ['app.example.com'],
  certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc',
});
const t = Template.fromStack(stack);

describe('WebStack', () => {
  it('keeps the bucket private and encrypted', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.anyValue(),
    });
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  });

  it('enforces HTTPS, TLS 1.2+ and SPA fallback', () => {
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' }),
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
  });

  it('sets security headers', () => {
    t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: Match.objectLike({
            ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'"),
          }),
          StrictTransportSecurity: Match.objectLike({ AccessControlMaxAgeSec: 31536000 }),
          ContentTypeOptions: { Override: true },
          FrameOptions: Match.objectLike({ FrameOption: 'DENY' }),
          ReferrerPolicy: Match.objectLike({ ReferrerPolicy: 'strict-origin-when-cross-origin' }),
        }),
      }),
    });
  });

  it('deploys the site and invalidates the distribution', () => {
    t.hasResourceProperties('Custom::CDKBucketDeployment', {
      DistributionPaths: ['/*'],
    });
  });

  it('limits connect-src to self and the API origin', () => {
    expect(buildCsp('https://api.example.com/v1')).toContain(
      "connect-src 'self' https://api.example.com;",
    );
    expect(buildCsp()).toContain("connect-src 'self';");
  });
});
