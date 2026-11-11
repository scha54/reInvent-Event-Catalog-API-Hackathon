import { describe, expect, it } from 'vitest';
import { createLogger } from '@serendipity/packages-contracts';
import {
  createAdminSyncRoutes,
  createApiHandler,
  type ApiEvent,
  type SyncExecutionInput,
  type SyncExecutionStarter,
} from './index.js';

const OPERATOR = 'arn:aws:iam::123456789012:role/OperatorRole';

function setup(opts: { fail?: boolean; operators?: readonly string[] } = {}) {
  const started: Array<{ name: string; input: SyncExecutionInput }> = [];
  const lines: Array<Record<string, unknown>> = [];
  const starter: SyncExecutionStarter = {
    async start(name, input) {
      if (opts.fail) throw new Error('boom: states:StartExecution denied');
      started.push({ name, input });
      return { executionArn: `arn:aws:states:::execution:sync:${name}` };
    },
  };
  const handler = createApiHandler(
    {
      allowedOrigins: [],
      logger: createLogger({ sink: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) }),
    },
    createAdminSyncRoutes({
      starter,
      generateExecutionId: () => 'sync-exec1',
      ...(opts.operators ? { operatorPrincipals: opts.operators } : {}),
    }),
  );
  const call = async (path: string, principal?: string) => {
    const event: ApiEvent = {
      rawPath: path,
      headers: {},
      requestContext: {
        http: { method: 'POST' },
        ...(principal
          ? { authorizer: { iam: { userArn: principal, accountId: '123456789012' } } }
          : {}),
      },
    };
    const res = await handler(event);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : undefined };
  };
  const audits = () => lines.filter((l) => l['audit'] === true);
  return { started, call, audits };
}

describe('admin sync', () => {
  it('starts an execution and returns the execution ID, with an audit log', async () => {
    const { started, call, audits } = setup();
    const r = await call('/api/v1/admin/events/reinvent-2025/sync', OPERATOR);
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ eventId: 'reinvent-2025', executionId: 'sync-exec1' });
    expect(started).toEqual([
      { name: 'sync-exec1', input: { eventId: 'reinvent-2025', executionId: 'sync-exec1' } },
    ]);
    expect(audits()).toHaveLength(1);
    expect(audits()[0]).toMatchObject({
      outcome: 'started',
      principal: OPERATOR,
      eventId: 'reinvent-2025',
      executionId: 'sync-exec1',
    });
  });

  it('returns 401 without an IAM principal and does not start a sync', async () => {
    const { started, call, audits } = setup();
    const r = await call('/api/v1/admin/events/e1/sync');
    expect(r.status).toBe(401);
    expect(started).toHaveLength(0);
    expect(audits()[0]).toMatchObject({ outcome: 'denied', principal: 'anonymous' });
  });

  it('returns 403 for a principal outside the operator allowlist', async () => {
    const { started, call, audits } = setup({ operators: [OPERATOR] });
    const r = await call('/api/v1/admin/events/e1/sync', 'arn:aws:iam::123456789012:user/other');
    expect(r.status).toBe(403);
    expect(started).toHaveLength(0);
    expect(audits()[0]).toMatchObject({ outcome: 'denied', reason: 'not-operator' });
  });

  it('supports prefix entries in the operator allowlist', async () => {
    const { call } = setup({ operators: ['arn:aws:iam::123456789012:role/Operator*'] });
    expect((await call('/api/v1/admin/events/e1/sync', OPERATOR)).status).toBe(202);
  });

  it('rejects invalid event IDs with 400', async () => {
    const { started, call } = setup();
    const r = await call('/api/v1/admin/events/bad%20id/sync', OPERATOR);
    expect(r.status).toBe(400);
    expect(started).toHaveLength(0);
  });

  it('returns 503 without leaking internals when the execution cannot start', async () => {
    const { call, audits } = setup({ fail: true });
    const r = await call('/api/v1/admin/events/e1/sync', OPERATOR);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).not.toContain('boom');
    expect(audits()[0]).toMatchObject({ outcome: 'failed', executionId: 'sync-exec1' });
  });
});
