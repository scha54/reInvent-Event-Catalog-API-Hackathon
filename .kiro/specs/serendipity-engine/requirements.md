# Requirements Document

## Introduction

Serendipity Engine is an interactive discovery application that reveals **unexpected but defensible** relationships among real AWS event sessions. Instead of recommending only closely related sessions, it finds *semantic bridges* between disciplines, explains why the bridge matters, and assembles cross-disciplinary discovery quests. Its primary differentiator is **constructive surprise**, not randomness.

**Version:** 1.0 | **Status:** Implementation baseline (approved) | **Target:** AWS re:Invent Event Catalog API Hackathon

**North-star user story:** As an attendee interested in serverless systems, I want to discover an unexpectedly relevant session about sustainability, security, or robotics, understand the evidence for that connection, and save a feasible discovery journey.

### Users

- **Curious explorer:** wants surprising recommendations without knowing search terms.
- **Goal-driven learner:** wants cross-disciplinary skills while retaining technical relevance.
- **Conference attendee:** needs real session metadata and schedule-aware discovery.
- **Demo judge:** must immediately see why the product differs from conventional catalog search.

### Outcomes and Success Metrics

| Metric | MVP target | Measurement |
|---|---|---|
| Valid session references | 100% | IDs resolve to current indexed catalog |
| Grounded explanation claims | >=95% in curated evaluation | Human evaluation against cited session fields |
| Meaningful-surprise acceptance | >=70% in 20 curated evaluations | Rater says bridge is both useful and non-obvious |
| Recommendation response time | p95 < 5 seconds for cached/indexed catalog, excluding cold start | CloudWatch latency |
| Explanation response time | p95 < 12 seconds, including Bedrock | CloudWatch latency |
| Discovery journey | 2-4 sessions, with conflicts clearly marked | Automated tests |
| Demo readiness | 3 reproducible scripted journeys and offline fallback | Demo checklist |

Targets are engineering objectives, not guarantees. Benchmark on the deployed AWS region and chosen models.

### Scope

**MVP (P0)**

1. Import and refresh a selected AWS event's session catalog through the official Events REST API.
2. Normalize session metadata and maintain a searchable, versioned index.
3. Accept one or two topics and optional interests, preferred novelty, and session constraints.
4. Return ranked, surprising but relevant session bridges with deterministic evidence references.
5. Generate concise AI explanations constrained to retrieved catalog evidence.
6. Visualize a clickable graph with topic/session nodes and labeled relationships.
7. Generate a 2-4-session cross-pollination quest; flag scheduling conflicts.
8. Offer explicit **No credible bridge found** behavior.
9. Capture opt-in thumbs-up/down feedback and allow anonymous exploration.
10. Deploy a secured, observable, repeatable AWS stack with a reliable demo seed.

**Stretch (P1)**

- Discovery Roulette with bounded randomness and novelty control.
- User profile and saved discoveries via Amazon Cognito.
- Shareable, privacy-safe quest links.
- Compare two discovery paths and show why they differ.
- Schedule/venue-aware quest ordering, subject to catalog field availability.

**Future (P2)**

- Attendee schedule import and reservations **only with explicit OAuth consent and documented API permissions**.
- Opt-in aggregated discovery map with privacy thresholds.
- Cross-event discovery and multilingual exploration.

**Explicit non-goals**

- Inventing or editing official sessions; claiming session attendance or learning completion.
- Booking or reserving sessions in MVP.
- Ingesting attendee identities, schedules, or private information without authorization.
- Guaranteeing physical travel times when venue coordinates are unavailable.
- Fully autonomous agents with unrestricted external tools.

### External API Assumptions and Validation Gate

AWS Builder guidance documents `https://api.awsevents.com`, REST paths under `/v1`, `GET /v1/events`, `GET /v1/events/{eventId}`, `GET /v1/events/{eventId}/sessions`, and `GET /v1/events/{eventId}/sessions/{sessionId}`. The session list is paginated; **continue until `nextToken` is absent, even if a page is short**. The API does not perform search or filtering; index and filter locally. Some event catalogs may require registration or authentication.

**Before implementation:** retrieve `https://api.awsevents.com/v1/openapi.json`; confirm field names, rate limits, pagination semantics, session identifiers, authorization, licensing, and allowed caching. Treat any optional metadata (track, venue, schedule, tags, level, URL) as nullable. Do not hardcode a specific event ID. Do not expose access tokens in browser code.

## Glossary

- **Serendipity_Engine**: The overall system comprising the web UI, API, ingestion, indexer, discovery, and evaluation components.
- **Events_API**: The official AWS Events REST API at `https://api.awsevents.com/v1`, the authoritative source of event and session facts.
- **Ingestion_Service**: The backend component that calls the Events_API adapter, normalizes sessions, and writes snapshots.
- **Events_API_Adapter**: The Ingestion_Service module that performs paginated, retried HTTP calls to the Events_API.
- **Indexer**: The component that computes embeddings and builds the lexical and vector index for a catalog snapshot.
- **Discovery_Engine**: The deterministic component that retrieves, scores, filters, and reranks candidate bridges.
- **Explanation_Service**: The component that produces evidence-grounded explanations via Amazon Bedrock and validates them.
- **Explanation_Validator**: The server-side check that verifies explanation JSON, session IDs, excerpts, and field provenance.
- **Quest_Planner**: The component that builds ordered 2-4-session journeys and detects schedule conflicts.
- **API_Service**: The application-owned API Gateway and Lambda handlers under `/api/v1`.
- **Web_UI**: The React and TypeScript browser application.
- **Session**: A normalized, canonical event session record.
- **Bridge**: A scored, evidence-backed inferred thematic link between topics and one or more Sessions.
- **Catalog_Snapshot**: An immutable, versioned set of normalized Sessions with a manifest.
- **Active_Catalog_Version**: The single published Catalog_Snapshot version served to users.
- **Quarantine**: A store for source records that fail validation, retained with an error reason.
- **Evidence**: A reference of session ID, field, and exact excerpt taken from a Session.
- **No_Match_State**: The truthful result shown when no credible Bridge exists.
- **Operator**: An authenticated, authorized administrator who triggers catalog sync.
- **Novelty_Slider**: A user control in the range 0 to 1 that biases ranking toward interdisciplinary distance among qualified candidates.
- **Hard_Gates**: Minimum thresholds for relevance, bridge strength, and evidence count that candidates must meet.
- **Content_Hash**: A deterministic hash of normalized session content used for idempotency and change detection.
- **Last_Known_Good_Snapshot**: The most recent successfully published Catalog_Snapshot.
- **Roulette**: The P1 seeded weighted sampling mode over qualified candidates.

## Requirements

### Requirement 1: Event Selection and Ingestion (FR-01, P0)

**User Story:** As an operator, I want to select an event and import its full session catalog through the official API, so that discovery runs on real, current data.

#### Acceptance Criteria

1. WHEN an Operator selects an event, THE Ingestion_Service SHALL retrieve the event and all available session pages through the Events_API_Adapter and persist normalized records with source ID, ingestion timestamp, and schema version.
2. WHEN a session list response contains a `nextToken`, THE Events_API_Adapter SHALL request the next page until `nextToken` is absent, including after short intermediate pages.
3. WHEN the same `(eventId, sessionId, contentHash)` is ingested more than once, THE Ingestion_Service SHALL produce the same stored result as a single ingestion.
4. IF a session record is malformed, THEN THE Ingestion_Service SHALL quarantine the record with an error reason and continue importing the remaining sessions.
5. IF the Events_API returns HTTP 429 or a 5xx status, THEN THE Events_API_Adapter SHALL retry with bounded exponential backoff and jitter.
6. IF the Events_API returns a permanent 4xx status, THEN THE Ingestion_Service SHALL surface the failure without retrying.
7. THE Web_UI SHALL display catalog freshness and sync status.

### Requirement 2: Catalog Integrity (FR-02, P0)

**User Story:** As an attendee, I want the indexed catalog to stay consistent with the source, so that I never see stale or missing sessions presented as current.

#### Acceptance Criteria

1. WHEN source sessions change or disappear, THE Ingestion_Service SHALL update or tombstone the indexed records so stale references are not presented as current.
2. THE Serendipity_Engine SHALL keep canonical session IDs stable across catalog versions.
3. THE Serendipity_Engine SHALL record the catalog version on every published Catalog_Snapshot.
4. IF a sync fails, THEN THE Serendipity_Engine SHALL retain the Last_Known_Good_Snapshot as the Active_Catalog_Version.
5. WHEN a Session lacks optional fields, THE Web_UI SHALL render the Session without error.

### Requirement 3: Topic Exploration (FR-03, P0)

**User Story:** As a curious explorer, I want to enter one or two topics, so that I can find sessions related to them without knowing exact search terms.

#### Acceptance Criteria

1. WHEN a user submits one or two topics, THE Discovery_Engine SHALL normalize the input and retrieve matching sessions using combined lexical and semantic retrieval.
2. THE API_Service SHALL accept topics of 2 to 100 characters each.
3. IF a topic is empty, exceeds 100 characters, or contains malicious-looking input, THEN THE API_Service SHALL return a validation error.
4. THE Discovery_Engine SHALL answer queries from the indexed catalog content rather than by scanning the catalog on each query.

### Requirement 4: Semantic Bridge Discovery (FR-04, P0)

**User Story:** As a curious explorer, I want ranked surprising-but-relevant session bridges, so that I discover connections I would not have searched for.

#### Acceptance Criteria

1. WHEN candidate sessions are retrieved, THE Discovery_Engine SHALL score each candidate for relevance, novelty, bridge strength, and diversity.
2. THE Discovery_Engine SHALL return only candidates that meet the configured Hard_Gates.
3. THE Discovery_Engine SHALL include session IDs, relationship labels, score breakdowns, and catalog-derived Evidence in each returned Bridge.
4. THE Discovery_Engine SHALL remove duplicate Bridges from results.
5. WHEN the catalog version, algorithm configuration, and seed are fixed, THE Discovery_Engine SHALL return identical results for identical requests.
6. THE Discovery_Engine SHALL apply the minimum relevance threshold regardless of the novelty setting.

### Requirement 5: Explainable Recommendations (FR-05, P0)

**User Story:** As an attendee, I want each bridge explained using only real session content, so that I can trust and verify the connection.

#### Acceptance Criteria

1. WHEN a Bridge is presented, THE Explanation_Service SHALL explain the conceptual connection using only cited session titles, abstracts, and available metadata.
2. THE Explanation_Validator SHALL require that each explanation references at least two real session IDs, or explicitly explains a single-session relationship to a user topic.
3. IF an explanation contains unsupported claims, THEN THE Explanation_Service SHALL reject it and replace it with a deterministic explanation.
4. THE Explanation_Service SHALL disclose uncertainty in every explanation.
5. THE Explanation_Service SHALL exclude fabricated speakers, dates, venues, and outcomes.

### Requirement 6: Interactive Discovery Graph (FR-06, P0)

**User Story:** As a demo judge, I want an interactive graph of topics and sessions, so that I can see how the bridge connects them.

#### Acceptance Criteria

1. WHEN discovery results arrive, THE Web_UI SHALL render topic and session nodes and edges with relationship labels and evidence inspection.
2. WHEN a user selects a node, THE Web_UI SHALL open the official session details.
3. THE Web_UI SHALL support keyboard operation of the graph and provide a list-view alternative.
4. THE Web_UI SHALL remain usable on mobile viewports and with reduced motion enabled.

### Requirement 7: Cross-Pollination Quests (FR-07, P0)

**User Story:** As a goal-driven learner, I want a 2-4-session cross-domain journey, so that I can build skills across disciplines.

#### Acceptance Criteria

1. WHEN a user requests a quest, THE Quest_Planner SHALL select 2 to 4 real sessions that form a cross-domain progression.
2. THE Quest_Planner SHALL provide a rationale for each step.
3. THE Quest_Planner SHALL exclude repeated sessions from a quest.
4. WHEN start and end times exist for sessions, THE Quest_Planner SHALL detect time conflicts.
5. WHEN start or end time is missing for a session, THE Quest_Planner SHALL mark its schedule status as unknown.
6. THE Quest_Planner SHALL link each step to a catalog session.

### Requirement 8: Discovery Roulette (FR-08, P1)

**User Story:** As a curious explorer, I want a bounded-random discovery, so that I can be surprised while staying relevant.

#### Acceptance Criteria

1. WHERE Roulette is enabled, WHEN a user activates Roulette, THE Discovery_Engine SHALL sample from a prequalified relevant candidate pool using the Novelty_Slider and an optional deterministic seed.
2. WHERE Roulette is enabled, THE Discovery_Engine SHALL sample only candidates that pass the Hard_Gates.
3. WHERE Roulette is enabled, WHEN a user rerolls, THE Web_UI SHALL request a new sample.
4. WHERE Roulette is enabled, THE Discovery_Engine SHALL include the reason for selection in each result.

### Requirement 9: Feedback (FR-09, P0)

**User Story:** As a product owner, I want opt-in feedback on recommendations, so that I can learn quality without compromising privacy.

#### Acceptance Criteria

1. WHEN a user explicitly rates a recommendation, THE API_Service SHALL store a minimal feedback record associated with an anonymous rotating session ID or a consenting user ID.
2. THE API_Service SHALL collect feedback only after an explicit user action.
3. THE API_Service SHALL exclude raw IP addresses and sensitive profile data from application records.
4. THE Web_UI SHALL provide a delete or reset option for saved feedback.

### Requirement 10: Empty, Error, and Fallback States (FR-10, P0)

**User Story:** As an attendee, I want truthful fallbacks, so that the product stays useful and honest when something fails.

#### Acceptance Criteria

1. IF no credible connection exists, THEN THE Web_UI SHALL show a No_Match_State and suggest relaxing constraints.
2. IF Amazon Bedrock is unavailable, THEN THE Explanation_Service SHALL return deterministic evidence-based descriptions.
3. IF the catalog source is temporarily unavailable, THEN THE API_Service SHALL serve the Last_Known_Good_Snapshot clearly labeled as such.

### Requirement 11: Authentication and Authorization (FR-11, P0/P1)

**User Story:** As an operator, I want administrative ingestion protected, so that only authorized people can change the catalog.

#### Acceptance Criteria

1. WHEN a request targets an administrative ingestion operation, THE API_Service SHALL require authenticated, authorized Operator access.
2. THE API_Service SHALL allow anonymous public discovery subject to rate limiting.
3. WHERE saved profiles are enabled (P1), THE API_Service SHALL enforce authenticated ownership checks.

### Requirement 12: Demo Experience (FR-12, P0)

**User Story:** As a demo judge, I want a scripted demo on real data, so that I can evaluate the product in under three minutes.

#### Acceptance Criteria

1. WHEN the demo starts, THE Web_UI SHALL provide three prevalidated topic pairs.
2. THE Web_UI SHALL display a visibly versioned real catalog snapshot.
3. THE Web_UI SHALL provide a scripted path that demonstrates discovery, evidence, graph, and quest in under three minutes.

### Requirement 13: Security (NFR-01)

**User Story:** As a security reviewer, I want defense in depth across transport, identity, input, and AI, so that the system resists misuse.

#### Acceptance Criteria

1. THE Serendipity_Engine SHALL use TLS for all network traffic and encrypt data at rest with KMS keys selected according to the threat model.
2. THE Serendipity_Engine SHALL use least-privilege IAM, short-lived credentials, and Secrets Manager for secrets, with no credentials in the repository or frontend.
3. THE API_Service SHALL enforce throttling, request validation, a strict CORS allowlist, and input limits, and SHALL use WAF where justified.
4. THE Explanation_Service SHALL treat session descriptions as untrusted data and SHALL NOT execute instructions contained in session content.
5. THE Ingestion_Service SHALL call only the allowlisted official Events_API hostname.

### Requirement 14: Reliability (NFR-02)

**User Story:** As an operator, I want resilient processing and fallbacks, so that failures do not corrupt or hide the catalog.

#### Acceptance Criteria

1. THE Serendipity_Engine SHALL route failed processing to an SQS dead-letter queue and process work items with idempotent handlers, bounded retries, and alarms.
2. THE Serendipity_Engine SHALL expose a catalog as complete only after all pages are imported and validated.
3. IF embedding, generation, or vector search is unavailable, THEN THE Serendipity_Engine SHALL apply a defined fallback.

### Requirement 15: Performance and Scale (NFR-03)

**User Story:** As an explorer, I want fast responses at demo scale, so that the experience feels immediate.

#### Acceptance Criteria

1. THE Serendipity_Engine SHALL be designed for approximately 10,000 catalog sessions and 100 concurrent explorers, validated against the real dataset.
2. THE API_Service SHALL paginate result APIs and cap graph size at 40 nodes by default.
3. THE Serendipity_Engine SHALL precompute embeddings and candidate neighbors and cache common discoveries.
4. THE Serendipity_Engine SHALL invoke no model per node or per graph edge.

### Requirement 16: Cost (NFR-04)

**User Story:** As a budget owner, I want bounded spend, so that the hackathon deployment does not produce surprise costs.

#### Acceptance Criteria

1. THE Serendipity_Engine SHALL define budget alarms, bounded Bedrock token limits, ingestion batching, and TTLs for caches.
2. THE Serendipity_Engine SHALL document a comparison of managed vector infrastructure fixed baseline against a low-cost vector approach before a deployment tier is chosen.

### Requirement 17: Observability (NFR-05)

**User Story:** As an operator, I want structured telemetry, so that I can diagnose problems without leaking sensitive data.

#### Acceptance Criteria

1. THE Serendipity_Engine SHALL emit structured JSON logs containing request or correlation IDs.
2. THE Serendipity_Engine SHALL publish CloudWatch metrics and alarms for ingestion freshness, API errors, latency, model failures, throttling, and spend.
3. THE Serendipity_Engine SHALL exclude full prompts, tokens, sensitive data, and credentials from logs by default.

### Requirement 18: Accessibility and Privacy (NFR-06)

**User Story:** As a user with accessibility needs, I want an accessible, privacy-respecting interface, so that I can use the product fully.

#### Acceptance Criteria

1. THE Web_UI SHALL target WCAG 2.2 AA, provide a reduced-motion option, a responsive layout, and keyboard navigation.
2. THE Serendipity_Engine SHALL minimize collected data and apply a retention policy.
3. WHERE aggregated user analytics are enabled, THE Serendipity_Engine SHALL require explicit opt-in.

### Requirement 19: Maintainability (NFR-07)

**User Story:** As a maintainer, I want strict typing and automation, so that changes are safe and repeatable.

#### Acceptance Criteria

1. THE Serendipity_Engine SHALL use TypeScript strict mode and shared runtime schemas.
2. THE Serendipity_Engine SHALL define infrastructure as code, automated CI/CD, contract tests, pinned dependencies, and dependency scanning.

### Requirement 20: AI Quality and Safety

**User Story:** As a judge, I want AI output that is grounded and reproducible, so that I can trust the explanations.

#### Acceptance Criteria

1. THE Explanation_Service SHALL generate explanations only from retrieved evidence and SHALL use a structured JSON schema.
2. THE Discovery_Engine SHALL apply deterministic scoring and filtering before any LLM explanation.
3. THE Web_UI SHALL separate observed Evidence from inferred connection.
4. THE Serendipity_Engine SHALL record the prompt version, model ID, embedding model, scoring configuration, and catalog snapshot for reproducibility.
5. THE Serendipity_Engine SHALL include an offline evaluation set of at least 20 topic pairs covering irrelevant, ambiguous, adversarial, and no-match cases.
6. THE Serendipity_Engine SHALL evaluate relevance, novelty, grounding, diversity, latency, and cost before release.
7. IF the model refuses, returns invalid JSON, times out, or is throttled, THEN THE Explanation_Service SHALL fail gracefully using a deterministic fallback.

## Primary User Journeys

1. **Explore:** choose event, enter topic, view unexpected ranked bridges, inspect source evidence, open official session.
2. **Connect two worlds:** enter two domains, receive a bridge chain or honest no-match, visualize connecting nodes.
3. **Build a quest:** choose bridge, generate 2-4 session sequence, inspect conflicts, save/share (P1).
4. **Discover randomly:** choose novelty, Roulette from qualified candidates (P1).
5. **Operate:** admin triggers sync, monitors progress/errors, activates complete catalog snapshot.

## Delivery Plan and Exit Gates

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 - API spike | Confirm OpenAPI, pagination, auth, data license, metadata | Real catalog import succeeds |
| 1 - Core data | Normalization, snapshotting, embeddings, indexing | Deterministic end-to-end import |
| 2 - Discovery | Hybrid retrieval, bridge scoring, evidence | 20-case evaluation passes quality gates |
| 3 - Experience | Graph, explanation, quests, responsive UI | Three complete demo journeys |
| 4 - Hardening | Security, alarms, cost caps, fallbacks, tests | CI green and demo checklist complete |

### Definition of Done

- All P0 acceptance criteria pass in CI or a documented deployed smoke test.
- No high or critical unresolved security findings.
- Source links, catalog version, and grounded explanations demonstrably work.
- One-click repeatable deployment with documented teardown and bounded costs.
- README includes setup, IAM, required environment variables, demo script, limitations, and cleanup.

## Open Decisions

1. Exact event ID and live API contract and registration requirements.
2. Bedrock model and region availability and quotas.
3. Vector store choice after fixed-cost analysis.
4. Whether venue, times, and official session deep links are present in catalog data.
5. Hackathon judging, data usage, and deployment restrictions (verify from official rules).

## References

- AWS Events API overview: https://builder.aws.com/content/3JjrKKy63DJ80xhHTHd50DUIoxx/how-to-plan-reinvent-2026-with-the-new-aws-events-api-and-mcp-server
- AWS Events API OpenAPI: https://api.awsevents.com/v1/openapi.json
- AWS Well-Architected Framework: https://docs.aws.amazon.com/wellarchitected/latest/framework/
- AWS Generative AI Lens: https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/
