# Implementation Plan: Serendipity Engine

## Overview

This plan builds Serendipity Engine in TypeScript (strict) as a monorepo following the design's repository structure: `apps/web`, `services/api`, `services/ingestion`, `services/indexer`, `packages/contracts`, `packages/discovery`, `packages/evaluation`, `infra/cdk`, `fixtures`, and `tests`. Work proceeds test-first where practical: shared schemas first, then the Events API adapter, snapshotting, indexing, discovery, explanation, quests, API handlers, UI, infrastructure, and evaluation. Each step wires into the previous one so no code is orphaned.

Requirement references use the form `FR-xx` / `NFR-xx` followed by the numbered requirement in `requirements.md` (for example `FR-01` is Requirement 1 and `NFR-01` is Requirement 13; the AI quality and safety requirement is Requirement 20).

| ID | Req | ID | Req | ID | Req |
|---|---|---|---|---|---|
| FR-01 | 1 | FR-09 | 9 | NFR-03 | 15 |
| FR-02 | 2 | FR-10 | 10 | NFR-04 | 16 |
| FR-03 | 3 | FR-11 | 11 | NFR-05 | 17 |
| FR-04 | 4 | FR-12 | 12 | NFR-06 | 18 |
| FR-05 | 5 | NFR-01 | 13 | NFR-07 | 19 |
| FR-06 | 6 | NFR-02 | 14 | AI | 20 |
| FR-07 | 7 | FR-08 | 8 | | |

## Tasks

- [x] 1. Scaffold the workspace and shared Zod contracts
  - [x] 1.1 Create the monorepo workspace
    - Create npm workspaces with `apps/web`, `services/api`, `services/ingestion`, `services/indexer`, `packages/contracts`, `packages/discovery`, `packages/evaluation`, `infra/cdk`, `fixtures`, `tests/unit`, `tests/integration`, `tests/e2e`, `.github/workflows`
    - Add shared `tsconfig.base.json` with `strict: true`, ESLint, Prettier, Vitest, and `fast-check`; pin dependency versions and commit the lockfile
    - Add root scripts: `format`, `lint`, `typecheck`, `test`
    - _Requirements: NFR-07 (19.1, 19.2)_

  - [x] 1.2 Define shared Zod schemas and types in `packages/contracts`
    - Implement schemas for `Session`, `EventMeta`, `Evidence`, `Bridge`, `ScoreComponents`, `Graph`, `Quest`, `Explanation` (including `insufficient_evidence`), snapshot manifest, quarantine record, feedback, discover request/response, and the error envelope
    - Treat all optional catalog metadata as optional; export inferred TypeScript types
    - _Requirements: NFR-07 (19.1), AI (20.1), FR-04 (4.3), FR-05 (5.2)_

  - [ ]* 1.3 Write property test for contract round trip
    - **Property 8: Contract round trip**
    - **Validates: Requirements 20.1**

  - [x] 1.4 Implement the structured JSON logger with redaction
    - Add a logger in `packages/contracts` (or a small shared module) emitting `requestId`, `eventId`, `catalogVersion`, `operation`, `latencyMs`, `status`
    - Redact prompts, tokens, and credential-like fields by default
    - _Requirements: NFR-05 (17.1, 17.3)_

  - [ ]* 1.5 Write property test for log redaction
    - **Property 20: Logs exclude sensitive content**
    - **Validates: Requirements 17.1, 17.3**

- [x] 2. Events API adapter spike and adapter implementation
  - [x] 2.1 Run the Events API spike and validate the OpenAPI spec
    - Add a script in `services/ingestion` that fetches `https://api.awsevents.com/v1/openapi.json` and records field names, pagination semantics, session identifiers, auth requirements, rate limits, and licensing/caching notes in `services/ingestion/SPIKE.md`
    - Confirm which optional metadata (track, venue, schedule, tags, level, URL) exist; do not hardcode an event ID (read it from configuration)
    - Save sanitized contract fixtures (multi-page responses with short pages) under `fixtures/events-api/`
    - Record open decisions that remain unresolved (event ID, registration, deep links)
    - _Requirements: FR-01 (1.1), FR-12 (12.2), NFR-01 (13.5)_

  - [x] 2.2 Implement retry and backoff utility
    - Bounded exponential backoff with full jitter, honoring `Retry-After`, with a max-attempt cap and request timeouts
    - Retry only 429 and 5xx; fail fast on permanent 4xx
    - _Requirements: FR-01 (1.5, 1.6), NFR-02 (14.1)_

  - [ ]* 2.3 Write property test for retry bounds
    - **Property 2: Retry backoff is bounded**
    - **Validates: Requirements 1.5**

  - [x] 2.4 Implement the Events API adapter with `nextToken` pagination
    - Implement `getEvent` and `listAllSessions` against the allowlisted host `api.awsevents.com`, with keep-alive, bounded concurrency, correlation IDs, and auth via server-side credentials only
    - Follow `nextToken` until absent regardless of page size; store tokens unchanged; add repeated-token detection and a max-page guard
    - Validate responses against the contracts and the spike findings
    - _Requirements: FR-01 (1.1, 1.2, 1.6), NFR-01 (13.5), NFR-02 (14.1)_

  - [ ]* 2.5 Write property test for pagination
    - **Property 1: Pagination exhaustiveness**
    - **Validates: Requirements 1.2**

  - [ ]* 2.6 Write unit tests for adapter edge cases
    - Permanent 4xx not retried, 429 with `Retry-After`, non-allowlisted host rejected, empty final page, auth failure surfaced
    - _Requirements: FR-01 (1.5, 1.6), NFR-01 (13.5)_

- [x] 3. Normalization, content hashing, quarantine, and snapshot/manifest publish
  - [x] 3.1 Implement session normalization
    - Map source records to the canonical `Session`; preserve source session IDs; never fabricate absent fields
    - Build `searchableText` from labeled title, abstract, and available tags; omit empty fields and strip markup safely
    - _Requirements: FR-01 (1.1), FR-02 (2.2, 2.5)_

  - [ ]* 3.2 Write property test for normalization
    - **Property 3: Normalization preserves identity and never fabricates**
    - **Validates: Requirements 1.4, 2.2, 2.5**

  - [x] 3.3 Implement content hashing, idempotent ingestion, and quarantine
    - Deterministic `sourceHash` over normalized content; idempotent writes keyed by `(eventId, sessionId, contentHash)`
    - Quarantine malformed records with an error reason and continue; write raw pages to an S3 staging prefix
    - _Requirements: FR-01 (1.3, 1.4)_

  - [ ]* 3.4 Write property test for ingestion idempotence
    - **Property 4: Ingestion idempotence by content hash**
    - **Validates: Requirements 1.3**

  - [ ]* 3.5 Write property test for quarantine partition
    - **Property 5: Quarantine partition**
    - **Validates: Requirements 1.4**

  - [x] 3.6 Implement snapshot manifest and snapshot diffing
    - Build an immutable manifest (record count, hashes, schema version, catalog version, timestamp)
    - Compute changed, unchanged, and tombstoned sessions between snapshots; return only changed sessions for embedding
    - _Requirements: FR-02 (2.1, 2.3), NFR-04 (16.1)_

  - [ ]* 3.7 Write property test for snapshot diffing
    - **Property 6: Snapshot diff handles changes and removals**
    - **Validates: Requirements 2.1**

  - [x] 3.8 Implement completeness checks and atomic publish gate
    - Referential integrity and completeness checks plus a sample retrieval check hook
    - Atomically update `activeCatalogVersion` with a DynamoDB conditional write; keep the previous snapshot; never activate a partial snapshot; return 409 on version conflict
    - _Requirements: FR-02 (2.3, 2.4), NFR-02 (14.2), FR-10 (10.3)_

  - [ ]* 3.9 Write property test for the publish gate
    - **Property 7: Publish gate never activates a partial snapshot**
    - **Validates: Requirements 2.3, 2.4, 14.2**

- [x] 4. Indexer: embeddings, local BM25, and vector index
  - [x] 4.1 Implement the Bedrock embedding client
    - Read model ID, dimensions, and region from configuration; embed only changed sessions per content hash and model version; handle throttling with backoff
    - _Requirements: FR-04 (4.1), NFR-03 (15.3), NFR-04 (16.1), AI (20.4)_

  - [x] 4.2 Build the local BM25 and vector index
    - Implement BM25 over `searchableText`, an in-memory vector index (brute-force or compact ANN) with top-K neighbor precomputation, and topic clusters
    - Serialize/deserialize the compact index to S3, keyed by catalog version and embedding model version, with a per-container cache
    - _Requirements: FR-03 (3.4), NFR-03 (15.1, 15.3), NFR-04 (16.2)_

  - [ ]* 4.3 Write unit tests for the index
    - Serialize/deserialize round trip, BM25 ranking on a fixture, neighbor precomputation, cache keyed by version
    - _Requirements: FR-03 (3.4), NFR-03 (15.3)_

  - [x] 4.4 Implement the SQS embedding/index worker
    - Idempotent handler consuming work items, with DLQ-friendly failure behavior and a lexical-only fallback flag when embeddings are unavailable
    - _Requirements: NFR-02 (14.1, 14.3), FR-10 (10.2)_

  - [x] 4.5 Wire the sync workflow handlers
    - Implement the Step Functions task handlers: start sync, fetch/stage, normalize, diff/enqueue, build index, run checks, publish
    - Ensure failure at any step leaves the active catalog unchanged and emits metrics
    - _Requirements: FR-01 (1.1), FR-02 (2.4), NFR-02 (14.1, 14.2), NFR-05 (17.2)_

- [x] 5. Discovery: hybrid retrieval, scoring, MMR, hard gates, no-match, novelty slider
  - [x] 5.1 Implement topic validation and normalization
    - Enforce 2-100 characters, trim/normalize, and reject empty, oversized, or unsafe input with a validation error
    - _Requirements: FR-03 (3.2, 3.3)_

  - [ ]* 5.2 Write property test for topic validation
    - **Property 9: Topic validation**
    - **Validates: Requirements 3.2, 3.3**

  - [x] 5.3 Implement hybrid retrieval
    - Combine BM25 and vector-nearest results per topic; merge and deduplicate by session ID; enforce a minimum topical relevance threshold; query the index only
    - _Requirements: FR-03 (3.1, 3.4), FR-04 (4.4)_

  - [ ]* 5.4 Write property test for retrieval
    - **Property 10: Retrieval returns only indexed sessions**
    - **Validates: Requirements 3.1, 3.4, 4.4**

  - [x] 5.5 Implement bridge scoring, hard gates, MMR rerank, no-match, and the novelty slider
    - Configurable weights (0.30 relevance, 0.25 bridge strength, 0.25 novelty, 0.15 diversity, 0.05 quality), components normalized to [0,1]
    - Hard gates `R_min`, `B_min`, `evidenceCount >= 2` for two-session bridges; novelty never overrides the relevance floor; deterministic ordering for fixed catalog version, config, and seed
    - Return `noMatch: true` when no candidate passes; record algorithm version and config in results
    - _Requirements: FR-04 (4.1, 4.2, 4.3, 4.5, 4.6), FR-10 (10.1), AI (20.2, 20.4)_

  - [ ]* 5.6 Write property test for hard gates and result shape
    - **Property 11: Returned bridges satisfy hard gates and shape**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.6**

  - [ ]* 5.7 Write property test for determinism and deduplication
    - **Property 12: Discovery is deterministic and duplicate-free**
    - **Validates: Requirements 4.4, 4.5**

  - [ ]* 5.8 Write property test for no-match
    - **Property 13: No-match for unconnected topics**
    - **Validates: Requirements 10.1**

  - [x] 5.9 Implement the graph builder
    - Build topic/session nodes and `topic-match`, `shared-concept`, `inferred-bridge` edges with weights, supporting session IDs, and evidence spans; cap at 40 nodes and 80 edges by default
    - _Requirements: FR-06 (6.1), NFR-03 (15.2)_

  - [ ]* 5.10 Write property test for graph integrity
    - **Property 14: Graph referential integrity and size cap**
    - **Validates: Requirements 6.1, 15.2**

  - [ ]* 5.11 Implement Discovery Roulette (P1) with its property test
    - Seeded weighted sampling from the qualified candidate pool, reroll support, and a selection reason
    - **Property 19: Roulette samples only qualified candidates (P1)**
    - **Validates: Requirements 8.1, 8.2, 8.4**
    - _Requirements: FR-08 (8.1, 8.2, 8.3, 8.4)_

- [x] 6. Evidence-grounded explanation with validator and deterministic fallback
  - [x] 6.1 Implement the prompt builder and Bedrock text client
    - Build the grounded prompt (untrusted session text, fixed JSON schema, token caps); configurable model ID; timeouts and throttle handling; version the prompt
    - _Requirements: FR-05 (5.1), NFR-01 (13.4), NFR-04 (16.1), AI (20.1, 20.4)_

  - [x] 6.2 Implement the Explanation_Validator and deterministic template fallback
    - Validate JSON schema, cited IDs against the supplied evidence set, excerpt substring match per field, minimum two cited IDs (or declared single-session relationship), and required uncertainty
    - Produce a deterministic evidence-based explanation from catalog fields
    - _Requirements: FR-05 (5.2, 5.3, 5.4, 5.5), FR-10 (10.2)_

  - [x] 6.3 Implement the explanation orchestrator
    - Generate lazily per bridge; at most one retry on validation failure, then fallback; cooldown after repeated failures; cache by `(catalogVersion, bridgeId, promptVersion, modelId)` with TTL; emit grounding-failure and throttle metrics
    - _Requirements: FR-05 (5.1, 5.3), FR-10 (10.2), AI (20.7), NFR-04 (16.1), NFR-05 (17.2)_

  - [ ]* 6.4 Write property test for the validator
    - **Property 15: Explanation validator rejects ungrounded output**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**

  - [ ]* 6.5 Write property test for graceful resolution
    - **Property 16: Explanation always resolves to a valid result**
    - **Validates: Requirements 10.2, 20.7**

- [x] 7. Quest planner with conflict detection
  - [x] 7.1 Implement schedule conflict detection
    - Interval overlap checks for known start/end times; mark steps with missing times as unknown schedule, never conflict-free
    - _Requirements: FR-07 (7.4, 7.5)_

  - [ ]* 7.2 Write property test for conflict detection
    - **Property 18: Conflict detection matches an interval oracle**
    - **Validates: Requirements 7.4, 7.5**

  - [x] 7.3 Implement the quest planner
    - Select 2-4 distinct real sessions from the bridge chain and adjacent concepts, maximizing progression, novelty, and diversity; attach rationale, evidence, schedule status, and official link when present; report conflicts and alternatives without altering source data
    - _Requirements: FR-07 (7.1, 7.2, 7.3, 7.4, 7.5, 7.6)_

  - [ ]* 7.4 Write property test for quest validity
    - **Property 17: Quest validity**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.6**

- [x] 8. API handlers: discover, explain, quests, feedback, status, admin sync
  - [x] 8.1 Build the API handler framework
    - Request ID propagation, schema validation, body size limits, error envelope with correct status codes (400/401/403/404/409/429/503), no stack traces, strict CORS allowlist, structured logging
    - _Requirements: NFR-01 (13.3), NFR-05 (17.1), FR-03 (3.3)_

  - [x] 8.2 Implement events, status, and discover handlers
    - `GET /api/v1/events`, `GET /api/v1/events/{eventId}/status`, `POST /api/v1/discover`; load the index for the active catalog version; return catalog version, freshness, and a labeled last-known-good indicator
    - Use the lexical-only degraded path if the vector index is unavailable
    - _Requirements: FR-01 (1.7), FR-03 (3.1), FR-04 (4.3), FR-10 (10.3), NFR-02 (14.3), NFR-03 (15.2)_

  - [x] 8.3 Implement the explain handler
    - `POST /api/v1/bridges/{bridgeId}/explain` requiring catalog version; return 409 on version mismatch; use the explanation orchestrator
    - _Requirements: FR-05 (5.1), FR-10 (10.2), AI (20.4)_

  - [x] 8.4 Implement the quests handler
    - `POST /api/v1/quests` returning ordered steps, `conflicts[]`, and `unknownSchedule[]`
    - _Requirements: FR-07 (7.1-7.6)_

  - [x] 8.5 Implement feedback handlers
    - `POST /api/v1/feedback` storing minimal records keyed by anonymous rotating ID with TTL, only after explicit action; a delete/reset endpoint; no raw IP or sensitive profile data stored
    - _Requirements: FR-09 (9.1, 9.2, 9.3, 9.4), NFR-06 (18.2)_

  - [x] 8.6 Implement the admin sync handler
    - `POST /api/v1/admin/events/{eventId}/sync` requiring an authenticated operator via IAM authorization; start the Step Functions execution and return the execution ID; write audit logs
    - _Requirements: FR-11 (11.1), NFR-01 (13.2)_

  - [x] 8.7 Wire the route table and rate limiting configuration
    - Register all handlers with request validation, throttling config for public routes, and operator-only protection for admin routes
    - _Requirements: FR-11 (11.1, 11.2), NFR-01 (13.3)_

  - [ ]* 8.8 Write unit and integration tests for handlers
    - Validation errors, 401/403 on admin, 409 version conflict, degraded fallbacks, feedback minimality, error envelope shape
    - _Requirements: FR-09 (9.3), FR-10, FR-11 (11.1), NFR-01 (13.3)_

  - [ ]* 8.9 Implement privacy-safe share links (P1)
    - Generate shareable quest links containing only session IDs and catalog version (no user data); resolve and validate them server-side
    - _Requirements: FR-07 (7.6), NFR-06 (18.2)_

- [x] 9. React UI: landing, bridge cards, accessible graph with list fallback, quest stepper
  - [x] 9.1 Create the app shell, API client, and landing page
    - Vite + React + TypeScript; typed API client using shared contracts; two-topic and one-topic input with client-side validation; novelty slider; three demo example buttons
    - _Requirements: FR-03 (3.2, 3.3), FR-12 (12.1), NFR-06 (18.1)_

  - [x] 9.2 Build bridge result cards and detail drawer
    - Ranked cards with score breakdowns; clearly separated "Observed evidence" and "Inferred connection" sections; uncertainty text; official source link; no-match, loading, stale-catalog, fallback, throttled, and error states
    - _Requirements: FR-05 (5.4), FR-06 (6.2), FR-10 (10.1, 10.2, 10.3), AI (20.3), FR-02 (2.5)_

  - [x] 9.3 Build the accessible graph with list fallback
    - React Flow or Cytoscape graph with clickable nodes, edge labels and tooltips, zoom, keyboard navigation and focus management, color-independent status, reduced-motion support, and an equivalent table/list view
    - _Requirements: FR-06 (6.1, 6.2, 6.3, 6.4), NFR-06 (18.1)_

  - [x] 9.4 Build the quest stepper
    - Timeline with step rationale, conflict and unknown-schedule badges, and official links; save/share controls shown only when supported
    - _Requirements: FR-07 (7.2, 7.4, 7.5, 7.6)_

  - [x] 9.5 Build catalog status and feedback controls
    - Show catalog version, freshness, and sync status; thumbs-up/down feedback with explicit action and a reset option
    - _Requirements: FR-01 (1.7), FR-09 (9.2, 9.4), FR-12 (12.2)_

  - [x] 9.6 Wire pages and the scripted demo path
    - Connect landing, results, graph, detail, and quest views; implement the under-three-minutes demo path with three prevalidated topic pairs including an intentionally unsupported one
    - _Requirements: FR-12 (12.1, 12.2, 12.3), FR-06, FR-07_

  - [ ]* 9.7 Write component and accessibility tests
    - Keyboard-only graph navigation, list fallback parity, reduced motion, mobile viewport, evidence vs inference separation, state rendering with missing optional fields
    - _Requirements: FR-06 (6.3, 6.4), NFR-06 (18.1), FR-02 (2.5)_

  - [ ]* 9.8 Add Roulette and share-link UI (P1)
    - Roulette button with reroll and selection reason; share-link control for quests
    - _Requirements: FR-08 (8.3, 8.4), FR-07 (7.6)_

- [x] 10. CDK stacks with least-privilege IAM, alarms, and budgets
  - [x] 10.1 Create CDK app and data stack
    - CDK v2 app with `dev` and `demo` environments; KMS key, versioned encrypted S3 buckets with lifecycle rules, DynamoDB on-demand table with TTL and conditional-write support, resource tags
    - _Requirements: NFR-01 (13.1), NFR-02, NFR-04 (16.1), NFR-07 (19.2)_

  - [x] 10.2 Create the ingestion stack
    - EventBridge Scheduler, Step Functions Standard workflow, ingestion and indexer Lambdas with separate least-privilege roles, SQS queue with DLQ and redrive, visibility timeout above worker budget, outbound access limited to the official Events API host
    - _Requirements: FR-01, NFR-01 (13.2, 13.5), NFR-02 (14.1)_

  - [x] 10.3 Create the API stack
    - API Gateway HTTP API with request validation, throttling, strict CORS allowlist, IAM authorization on admin routes, optional WAF, Lambda roles scoped to required tables, buckets, and Bedrock model ARNs, Secrets Manager for any credentials
    - _Requirements: FR-11 (11.1, 11.2), NFR-01 (13.2, 13.3)_

  - [x] 10.4 Create the web hosting stack
    - S3 + CloudFront (or Amplify Hosting) with TLS, security headers, and deployment of `apps/web` build output
    - _Requirements: NFR-01 (13.1), NFR-06 (18.1)_

  - [x] 10.5 Add observability, alarms, and budgets, and compose the stacks
    - CloudWatch log retention, dashboards, and alarms for `CatalogSyncAge`, `CatalogSyncFailures`, API errors, latency p95, `GroundingValidationFailures`, `BedrockThrottles`, DLQ depth; AWS Budgets alerts with application-level quotas; compose all stacks in the CDK app
    - _Requirements: NFR-05 (17.2), NFR-04 (16.1), NFR-02 (14.1)_

  - [ ]* 10.6 Write CDK assertion tests
    - Encryption at rest, DLQ and redrive, least-privilege IAM (no wildcard admin), throttling, CORS, alarms and budgets, admin route authorization
    - _Requirements: NFR-01, NFR-02 (14.1), NFR-04 (16.1), NFR-05 (17.2)_

  - [x] 10.7 Add the CI/CD workflow
    - GitHub Actions with OIDC to AWS: format, lint, typecheck, unit, dependency/security scan, CDK synth/diff, integration, deploy, smoke, end-to-end; no static AWS keys
    - _Requirements: NFR-07 (19.2), NFR-01 (13.2)_

  - [ ]* 10.8 Add Cognito for saved profiles (P1)
    - Cognito user pool and authorizer for optional profiles, with ownership checks on saved discoveries
    - _Requirements: FR-11 (11.3), NFR-01 (13.2)_

- [x] 11. Evaluation set, fixtures, demo seed, and README
  - [x] 11.1 Build the evaluation harness and golden cases in `packages/evaluation`
    - At least 20 labeled topic pairs including irrelevant, ambiguous, adversarial, and no-match cases; metrics for relevance, novelty, grounding, diversity, latency, and cost; threshold calibration report for `R_min` and `B_min`
    - _Requirements: AI (20.5, 20.6), FR-04 (4.2), NFR-03 (15.1)_

  - [x] 11.2 Create fixtures and the demo seed
    - Sanitized fixtures under `fixtures/` and a seed script that builds a versioned snapshot and index from a real imported catalog; three prevalidated topic pairs (serverless + sustainability, security + AI, one unsupported); offline fallback snapshot
    - Never present fabricated sessions as live results
    - _Requirements: FR-12 (12.1, 12.2), FR-10 (10.3), NFR-02 (14.3)_

  - [ ]* 11.3 Write end-to-end tests
    - The three demo journeys, keyboard-only and mobile checks, and fault injection (Events API down, Bedrock down, corrupted page, stale snapshot, partial index build)
    - _Requirements: FR-12 (12.3), FR-10, NFR-02 (14.3), NFR-06 (18.1)_

  - [x] 11.4 Write the README
    - Setup, IAM, required environment variables, region and Bedrock model access, demo script, limitations, teardown and cleanup commands, open decisions
    - _Requirements: FR-12, NFR-04 (16.2), NFR-07 (19.2)_

  - [ ]* 11.5 Write unit tests for the evaluation harness
    - Metric computation on known inputs and report generation
    - _Requirements: AI (20.5, 20.6)_

- [x] 12. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; this includes all test-only sub-tasks and all P1 items (Roulette, Cognito, share links).
- Each task references specific requirements for traceability.
- Property tests use `fast-check` with Vitest, at least 100 iterations each, tagged `Feature: serendipity-engine, Property {number}: {property_text}`.
- The spike in task 2.1 gates the adapter types and fixtures; unresolved open decisions are recorded rather than assumed.
- Bedrock model IDs, embedding dimensions, and region come from configuration.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.4"] },
    { "id": 2, "tasks": ["1.3", "1.5", "2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "4.1", "5.1", "6.1", "7.1", "10.1"] },
    { "id": 4, "tasks": ["2.3", "2.4", "3.2", "3.3", "4.2", "5.2", "6.2", "7.2", "7.3", "8.1"] },
    { "id": 5, "tasks": ["2.5", "2.6", "3.4", "3.5", "3.6", "4.3", "4.4", "5.3", "6.3", "6.4", "7.4", "8.5", "9.1", "10.7"] },
    { "id": 6, "tasks": ["3.7", "3.8", "5.4", "5.5", "6.5", "9.2", "9.4", "9.5"] },
    { "id": 7, "tasks": ["3.9", "4.5", "5.6", "5.7", "5.8", "5.9", "5.11", "8.2", "8.3", "8.4"] },
    { "id": 8, "tasks": ["5.10", "8.6", "9.3", "10.2", "11.2"] },
    { "id": 9, "tasks": ["8.7", "9.6", "11.1"] },
    { "id": 10, "tasks": ["8.8", "8.9", "9.7", "10.3", "10.4", "11.5"] },
    { "id": 11, "tasks": ["9.8", "10.5", "10.8"] },
    { "id": 12, "tasks": ["10.6", "11.3", "11.4"] }
  ]
}
```
