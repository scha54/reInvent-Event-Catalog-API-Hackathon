/**
 * Public, non-secret runtime configuration. The frontend never holds credentials;
 * all privileged calls (Events API, Bedrock) happen server-side.
 */
export interface WebConfig {
  readonly apiBaseUrl: string;
  readonly eventId: string;
}

export function readConfig(env: Record<string, string | undefined> = import.meta.env): WebConfig {
  return {
    apiBaseUrl: (env['VITE_API_BASE_URL'] ?? '').replace(/\/+$/, ''),
    // The event ID is configuration, never hardcoded (see services/ingestion/SPIKE.md).
    eventId: env['VITE_EVENT_ID'] ?? 'default',
  };
}
