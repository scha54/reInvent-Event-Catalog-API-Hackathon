import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { resolveEnvironmentConfig } from '../src/config.js';
import { DataStack } from '../src/data-stack.js';
import {
  IngestionStack,
  QUEUE_VISIBILITY_TIMEOUT,
  WORKER_TIMEOUT,
} from '../src/ingestion-stack.js';

const environments = {
  dev: {
    noncurrentVersionRetentionDays: 7,
    stagingRetentionDays: 7,
    snapshotInfrequentAccessAfterDays: 30,
    destroyOnDelete: true,
  },
};

function synth(eventId?: string): Template {
  const app = new App();
  const config = resolveEnvironmentConfig('dev', environments);
  const data = new DataStack(app, 'D', { config });
  const stack = new IngestionStack(app, 'I', { config, data, ...(eventId ? { eventId } : {}) });
  return Template.fromStack(stack);
}

describe('IngestionStack', () => {
  const t = synth('evt-1');

  it('uses a Standard state machine', () => {
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
  });

  it('configures DLQ redrive and visibility above the worker budget', () => {
    t.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: QUEUE_VISIBILITY_TIMEOUT.toSeconds(),
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
    expect(QUEUE_VISIBILITY_TIMEOUT.toSeconds()).toBeGreaterThan(WORKER_TIMEOUT.toSeconds());
  });

  it('gives each Lambda its own role and no wildcard admin', () => {
    const fns = t.findResources('AWS::Lambda::Function');
    const roles = new Set(Object.values(fns).map((f) => JSON.stringify(f.Properties.Role)));
    expect(roles.size).toBe(2);
    expect(JSON.stringify(t.findResources('AWS::IAM::Policy'))).not.toMatch(
      /"Action":"\*"|"Action":\["\*"\]/,
    );
  });

  it('limits Events API egress to the official host and keeps it off the indexer', () => {
    const fns = Object.values(t.findResources('AWS::Lambda::Function')).map(
      (f) => f.Properties.Environment.Variables,
    );
    const withHost = fns.filter((v) => v.EVENTS_API_ALLOWED_HOST === 'api.awsevents.com');
    expect(withHost).toHaveLength(1);
    expect(fns.filter((v) => 'EVENTS_API_BASE_URL' in v)).toHaveLength(1);
  });

  it('enables the schedule only when an event is configured', () => {
    t.hasResourceProperties('AWS::Scheduler::Schedule', { State: 'ENABLED' });
    synth().hasResourceProperties('AWS::Scheduler::Schedule', { State: 'DISABLED' });
  });
});
