# Events API spike (task 2.1)

Re-run: `npm run spike -w @serendipity/services-ingestion` (prints a spec summary; `-- --out file.json` to save). No credentials are used. Only `api.awsevents.com` is contacted.

## What was checked, and how

- Spec fetched live from `https://api.awsevents.com/v1/openapi.json`: HTTP 200, OpenAPI 3.1.0, "AWS Events API" v1.0.0, ETag present, `Cache-Control: no-store, no-cache`.
- Anonymous `GET /v1/events`, `GET /v1/events/{eventId}` and `GET /v1/events/{eventId}/sessions` were each called once to confirm auth behavior.
- NOT verified: any authenticated response. No token was available, so real session payloads were never seen. Session fixtures are synthetic.

## Endpoints relevant to ingestion

| Operation | Path | Notes |
|---|---|---|
| ListEvents | `GET /v1/events` | Anonymous OK. Query `includePast` (bool). Response `{items: Event[]}`, max 1000, no pagination. |
| GetEvent | `GET /v1/events/{eventId}` | Anonymous OK. Response `{event}`. 400/404/500/503. |
| ListSessions | `GET /v1/events/{eventId}/sessions` | Anonymous returns 401 `{"message":"Sign in to continue"}` for the one event observed. |
| GetSession | `GET /v1/events/{eventId}/sessions/{sessionId}` | Query `locale`. |

Out of scope (user-state write endpoints, never called): favorites, reservations, personal-time, `GET .../schedule`. Our product must not call these (see FR-12 deep-link decision below).

## Pagination semantics (ListSessions)

- Query: `nextToken` (opaque string, 1-512 chars), `locale` (BCP-47, falls back to en-US), `includeAbstracts` (bool, default true).
- Response: `{items: Session[] (max 250, ordered by sessionId), totalCount: number, nextToken?: string}`.
- `nextToken` is absent on the last page. Spec says a full walk returns all sessions. Page size is not client-controllable and pages may be shorter than 250, so loop on `nextToken` only. `totalCount` can be used as a cross-check after the walk.
- Response header `Content-Language` reports the locale used after fallback.
- Not specified: whether tokens expire, or behavior if the catalog changes mid-walk. Treat tokens as opaque and unchanged; guard against repeated tokens.

## Identifiers

- `eventId`: string 1-128, stable. Observed value for re:Invent 2026 is `reinvent2026` (data from the live API, not to be hardcoded; read from configuration).
- `sessionId`: string 1-128, stable. `abbreviation` is a separate public code (e.g. "AIM3315").

## Field inventory

Event (required: eventId, name, eventType, startDate, endDate, isOnline, authenticationRequired): optional `timezone`, `timezoneAbbreviation`, `timeFormat`, `address.city`, `supportedLanguageCodes`.

Session (required: only `sessionId`, `title`). All others optional: `abbreviation`, `abstract`, `type`, `level`, `venue`, `room`, `isAllDaySession`, `isReservable`, `seatAvailability` (enum available|limited|veryLimited|unavailable|walkUp; only on reservable sessions), `sessionTime{date,time,length,timezone?}` (strings; length is minutes as a string), `speakers[{name}]`, and string arrays `tracks`, `topics`, `industries`, `areasOfInterest`, `roles`, `services`, `segments`, `features`, `customerPersonas`, `experiences`, `additionalActivities`, `focusAreas`.

## Optional metadata requested by the task

| Wanted | Exists in spec? | Mapping |
|---|---|---|
| track | Yes | `tracks[]` (optional) |
| venue | Yes | `venue`, `room` (optional) |
| schedule | Yes | `sessionTime.{date,time,length,timezone}` (optional; event `timezone` is the fallback) |
| tags | No single field | Closest: `topics`, `areasOfInterest`, `focusAreas`, `services`, `features`, `industries`, `roles`, `segments`, `customerPersonas`. Mapping choice is an open decision. |
| level | Yes | `level` (optional, e.g. "300 - Advanced") |
| URL / deep link | **No** | No URL field on Session or Event. |

Adapter must treat every optional field as possibly absent and never fabricate values.

## Auth

- The spec declares no `securitySchemes` and no per-operation `security`, although operations list 401/403.
- Observed: the event endpoints are anonymous; `ListSessions` returned 401 with a Bearer challenge. `Event.authenticationRequired` is `true` for `reinvent2026` ("deeper content requires attendee login"); the 403 `EventAuthRequiredException` also exists.
- Protected-resource metadata (`/.well-known/oauth-protected-resource/v1`) advertises scope `events/access`, bearer token in the `Authorization` header, and an Amazon Cognito authorization server (us-east-1). How a server-side ingestion job obtains a token (client credentials vs. attendee sign-in) is not documented in the spec.

## Rate limits and errors

- No numeric rate limit is documented and no `X-RateLimit-*` headers were seen.
- 429 `ThrottlingException` documents a `Retry-After` header (seconds). 500 `EventsServiceException` and 503 `EventsUnavailableException`/`OperationUnavailableException` exist. 409 is documented on authenticated endpoints (meaning unspecified for reads).
- Plan for task 2.2: retry only 429/5xx, honor `Retry-After`, fail fast on other 4xx.

## Licensing and caching

- The spec contains no license, terms-of-use, or caching guidance. Responses are `no-store, no-cache`, so there is no HTTP-level caching hint; our snapshot is our own cache. Whether session content may be stored, redistributed in the app, or used with an LLM is **unresolved** and needs confirmation with the API owner. Raw authenticated responses must not be committed.

## Fixtures

`fixtures/events-api/` (see its README). `event.live-observed.json` and `error.401.json` were observed live; everything else is synthetic and labeled `_fixture.provenance: "synthetic"`. Pages are short (2, 2, 1 items) with `nextToken` chaining, plus an empty-final-page case.

## Open decisions

1. Event ID: `reinvent2026` is the only event listed anonymously, but the target must come from configuration, and the owner should confirm it.
2. Credentials: how the ingestion service gets a bearer token (scope `events/access`) is unknown; sessions cannot be fetched without it. Blocks live ingestion in 2.4; fixtures cover development meanwhile.
3. Registration: whether attendee registration/sign-in is required and whether we may use a service identity.
4. Deep links: no URL field exists. Decide whether to construct links from `eventId` + `sessionId` (no documented pattern) or omit links (FR-12).
5. Tags mapping: which of the taxonomy arrays feed `tags`/`searchableText`.
6. Licensing/retention of session content, including LLM use.
7. Token expiry and mid-walk catalog changes during pagination.
8. Real size of the catalog and the actual rate limit (unknowable without authenticated access).
