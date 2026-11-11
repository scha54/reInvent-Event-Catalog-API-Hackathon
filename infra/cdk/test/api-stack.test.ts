import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ROUTE_POLICIES } from '@serendipity/services-api';
import { ApiStack, validateAllowedOrigins } from '../src/api-stack.js';
import { resolveEnvironmentConfig } from '../src/config.js';
import { DataStack } from '../src/data-stack.js';
import { IngestionStack } from '../src/ingestion-stack.js';

const environments = {
  dev: {
    noncurrentVersionRetentionDays: 7,
    stagingRetentionDays: 7,
    snapshotInfrequentAccessAfterDays: 30,
    destroyOnDelete: true,
  },
};

function synth(origins: string[] = ['https://app.example.com']): Template {
  const app = new App();
  const config = resolveEnvironmentConfig('dev', environments);
  const data = new DataStack(app, 'D', { config });
  const ingestion = new IngestionStack(app, 'I', { config, data });
  const stack = new ApiStack(app, 'A', {
    config,
    data,
    ingestion,
    allowedOrigins: origins,
    operatorPrincipals: ['arn:aws:iam::123456789012:role/operator'],
  });
  return Template.fromStack(stack);
}

describe('ApiStack', () => {
  const t = synth();

  it('creates one route per policy with IAM auth only on operator routes', () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route'));
    expect(routes).toHaveLength(Object.keys(ROUTE_POLICIES).length);
    for (const r of routes) {
      const key = r.Properties.RouteKey as string;
      const expected = ROUTE_POLICIES[key]?.authorization;
      expect(r.Properties.AuthorizationType).toBe(expected);
    }
  });

  it('has no catch-all route', () => {
    const keys = Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map(
      (r) => r.Properties.RouteKey as string,
    );
    expect(keys.some((k) => k.includes('$default') || k.startsWith('ANY'))).toBe(false);
  });

  it('applies strict CORS and per-route throttling', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: ['https://app.example.com'],
        AllowCredentials: false,
      }),
    });
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      RouteSettings: Match.objectLike({
        'POST /api/v1/admin/events/{eventId}/sync': {
          ThrottlingRateLimit: 1,
          ThrottlingBurstLimit: 2,
        },
      }),
      DefaultRouteSettings: Match.objectLike({ ThrottlingRateLimit: 10 }),
    });
  });

  it('scopes the role: no wildcard actions or resources on Bedrock/StartExecution', () => {
    const policies = Object.values(t.findResources('AWS::IAM::Policy'));
    const statements = policies.flatMap(
      (p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[],
    );
    for (const s of statements) {
      const actions = ([] as string[]).concat(s.Action as string | string[]);
      expect(actions.some((a) => a === '*' || a.endsWith(':*'))).toBe(false);
    }
    const bedrock = statements.find((s) => s.Sid === 'InvokeConfiguredModels');
    expect(JSON.stringify(bedrock?.Resource)).not.toBe('"*"');
    const start = statements.find((s) => s.Sid === 'StartCatalogSync');
    expect(start?.Action).toEqual('states:StartExecution');
  });
});

describe('validateAllowedOrigins', () => {
  it('rejects wildcards, empty lists, paths and plain http', () => {
    expect(() => validateAllowedOrigins([])).toThrow();
    expect(() => validateAllowedOrigins(['*'])).toThrow();
    expect(() => validateAllowedOrigins(['https://*.example.com'])).toThrow();
    expect(() => validateAllowedOrigins(['https://a.example.com/x'])).toThrow();
    expect(() => validateAllowedOrigins(['http://a.example.com'])).toThrow();
  });
  it('accepts https and localhost origins', () => {
    expect(() =>
      validateAllowedOrigins(['https://a.example.com', 'http://localhost:5173']),
    ).not.toThrow();
  });
});
