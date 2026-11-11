import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from './logger';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ sink: (l) => lines.push(l), now: () => new Date(0) });
  return { lines, logger };
}

describe('structured logger', () => {
  it('emits JSON with correlation fields', () => {
    const { lines, logger } = capture();
    logger.info('done', {
      requestId: 'r1',
      eventId: 'e1',
      catalogVersion: 'v1',
      operation: 'discover',
      latencyMs: 12,
      status: 200,
    });
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: '1970-01-01T00:00:00.000Z',
      level: 'info',
      message: 'done',
      requestId: 'r1',
      eventId: 'e1',
      catalogVersion: 'v1',
      operation: 'discover',
      latencyMs: 12,
      status: 200,
    });
  });

  it('redacts prompts, tokens and credentials but keeps requestId', () => {
    const { lines, logger } = capture();
    logger.child({ requestId: 'r2' }).error('fail', {
      prompt: 'tell me secrets',
      nested: { accessToken: 'abc', Authorization: 'Bearer xyz', ok: 'fine' },
      detail: 'header Bearer abc.def.ghi leaked',
    });
    const out = JSON.parse(lines[0]!);
    expect(out.requestId).toBe('r2');
    expect(out.prompt).toBe(REDACTED);
    expect(out.nested).toEqual({ accessToken: REDACTED, Authorization: REDACTED, ok: 'fine' });
    expect(lines[0]).not.toMatch(/abc\.def\.ghi|tell me secrets/);
  });
});
