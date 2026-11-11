/**
 * Admin sync handler.
 *
 * - `POST /api/v1/admin/events/{eventId}/sync` starts the catalog sync Step
 *   Functions execution and returns its execution ID.
 *
 * The route is protected by API Gateway IAM (SigV4) authorization, which
 * populates `requestContext.authorizer.iam`. The handler re-checks that an
 * authenticated principal is present (401 otherwise) and, when an operator
 * allowlist is configured, that the principal is a permitted Operator (403
 * otherwise). Every attempt (denied, started, failed) writes an audit log line
 * carrying the principal, event and execution ID.
 *
 * Requirements: FR-11 (11.1), NFR-01 (13.2).
 */
import { randomUUID } from 'node:crypto';
import type { LogFields } from '@serendipity/packages-contracts';
import {
  ApiError,
  forbidden,
  serviceUnavailable,
  unauthorized,
  validationError,
} from './errors.js';
import { defineRoute, type ApiEvent, type RouteDefinition } from './framework.js';

/** Input handed to the state machine; matches `StartSyncInput` in the ingestion workflow. */
export interface SyncExecutionInput {
  readonly eventId: string;
  readonly executionId: string;
}

export interface SyncExecutionStarted {
  /** ARN of the started execution (Step Functions `executionArn`). */
  readonly executionArn?: string | undefined;
  /** ISO timestamp of the start, when the service reports one. */
  readonly startedAt?: string | undefined;
}

/** Starts the sync state machine (Step Functions `StartExecution` in production). */
export interface SyncExecutionStarter {
  /** `name` is a unique, Step Functions-safe execution name equal to `input.executionId`. */
  start(name: string, input: SyncExecutionInput): Promise<SyncExecutionStarted>;
}

export interface AdminSyncHandlerDeps {
  readonly starter: SyncExecutionStarter;
  /**
   * Allowed operator principal ARNs. A trailing `*` matches by prefix
   * (e.g. `arn:aws:iam::123456789012:role/Operator*`). When omitted, any
   * IAM-authenticated principal admitted by API Gateway is accepted.
   */
  readonly operatorPrincipals?: readonly string[];
  readonly generateExecutionId?: () => string;
}

/** Event IDs are opaque path tokens. */
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface OperatorIdentity {
  readonly principal: string;
  readonly accountId?: string | undefined;
}

/** Extracts the IAM-authenticated principal from the API Gateway request context. */
export function getOperatorIdentity(event: ApiEvent): OperatorIdentity | undefined {
  const auth = event.requestContext?.authorizer;
  if (typeof auth !== 'object' || auth === null) return undefined;
  const iam = (auth as { iam?: unknown }).iam;
  if (typeof iam !== 'object' || iam === null) return undefined;
  const { userArn, accountId } = iam as { userArn?: unknown; accountId?: unknown };
  if (typeof userArn !== 'string' || userArn.length === 0) return undefined;
  return {
    principal: userArn,
    ...(typeof accountId === 'string' ? { accountId } : {}),
  };
}

function isPermitted(principal: string, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true;
  return allowed.some((entry) =>
    entry.endsWith('*') ? principal.startsWith(entry.slice(0, -1)) : principal === entry,
  );
}

export function createAdminSyncRoutes(deps: AdminSyncHandlerDeps): RouteDefinition[] {
  const newExecutionId =
    deps.generateExecutionId ?? (() => `sync-${randomUUID().replace(/-/g, '')}`);

  const sync = defineRoute({
    method: 'POST',
    path: '/api/v1/admin/events/{eventId}/sync',
    handler: async (ctx) => {
      const eventId = ctx.pathParams['eventId'] as string;
      const identity = getOperatorIdentity(ctx.event);
      const audit = (outcome: string, extra: LogFields = {}): void => {
        const fields: LogFields = {
          audit: true,
          action: 'admin.sync.start',
          outcome,
          principal: identity?.principal ?? 'anonymous',
          eventId,
          ...extra,
        };
        if (outcome === 'started') ctx.logger.info('audit', fields);
        else ctx.logger.warn('audit', fields);
      };

      if (!identity) {
        audit('denied', { reason: 'unauthenticated' });
        throw unauthorized();
      }
      if (!isPermitted(identity.principal, deps.operatorPrincipals)) {
        audit('denied', { reason: 'not-operator' });
        throw forbidden();
      }
      if (!EVENT_ID_PATTERN.test(eventId)) {
        audit('rejected', { reason: 'invalid-event-id' });
        throw validationError('Invalid eventId');
      }

      const executionId = newExecutionId();
      try {
        const started = await deps.starter.start(executionId, { eventId, executionId });
        ctx.annotate({ eventId });
        audit('started', { executionId });
        return {
          statusCode: 202,
          body: {
            eventId,
            executionId,
            ...(started.executionArn !== undefined ? { executionArn: started.executionArn } : {}),
            ...(started.startedAt !== undefined ? { startedAt: started.startedAt } : {}),
          },
        };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        audit('failed', { executionId, error: err });
        throw serviceUnavailable('Unable to start catalog sync');
      }
    },
  });

  return [sync];
}
