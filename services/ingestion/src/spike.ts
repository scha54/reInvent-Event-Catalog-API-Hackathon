/**
 * Events API spike: fetch the OpenAPI spec from the allowlisted host and print
 * a structured summary (paths, parameters, schemas, security, pagination hints).
 *
 * Usage: node --experimental-strip-types src/spike.ts [--out <file>]
 * No credentials are read or sent. Only api.awsevents.com is contacted.
 */
import { writeFileSync } from 'node:fs';

export const ALLOWED_HOST = 'api.awsevents.com';
export const SPEC_URL = `https://${ALLOWED_HOST}/v1/openapi.json`;

type Json = Record<string, unknown>;

export function assertAllowlisted(url: string): void {
  if (new URL(url).hostname !== ALLOWED_HOST) {
    throw new Error(`Host not allowlisted: ${url}`);
  }
}

export function summarizeSpec(spec: Json): Json {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, Json>>;
  const operations = Object.entries(paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m))
      .map(([method, op]) => ({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        parameters: ((op.parameters as Json[]) ?? []).map((p) => ({
          name: p.name,
          in: p.in,
          required: p.required ?? false,
          schema: p.schema,
        })),
        security: op.security,
        responses: Object.keys((op.responses as Json) ?? {}),
      })),
  );
  const components = (spec.components ?? {}) as Json;
  const schemas = (components.schemas ?? {}) as Record<string, Json>;
  return {
    info: spec.info,
    servers: spec.servers,
    security: spec.security,
    securitySchemes: components.securitySchemes,
    operations,
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, s]) => [
        name,
        { required: s.required, properties: s.properties },
      ]),
    ),
  };
}

async function main(): Promise<void> {
  assertAllowlisted(SPEC_URL);
  const res = await fetch(SPEC_URL, { headers: { accept: 'application/json' } });
  const headers = Object.fromEntries(
    [...res.headers.entries()].filter(([k]) =>
      /^(cache-control|etag|last-modified|content-type|x-ratelimit.*|retry-after)$/i.test(k),
    ),
  );
  console.error(`status=${res.status}`, headers);
  if (!res.ok) {
    throw new Error(`Spec fetch failed: ${res.status}`);
  }
  const spec = (await res.json()) as Json;
  const out = JSON.stringify(summarizeSpec(spec), null, 2);
  const idx = process.argv.indexOf('--out');
  if (idx >= 0 && process.argv[idx + 1]) {
    writeFileSync(process.argv[idx + 1]!, out);
  } else {
    console.log(out);
  }
}

if (process.argv[1]?.endsWith('spike.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
