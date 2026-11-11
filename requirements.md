# Serendipity Engine — Product Requirements

**Version:** 1.0 | **Status:** Implementation baseline | **Target:** AWS re:Invent Event Catalog API Hackathon

## 1. Vision and outcome

Serendipity Engine is an interactive discovery application that reveals **unexpected but defensible** relationships among real AWS event sessions. Instead of recommending only closely related sessions, it finds *semantic bridges* between disciplines, explains why the bridge matters, and assembles cross-disciplinary discovery quests. Its primary differentiator is **constructive surprise**, not randomness.

**North-star user story:** As an attendee interested in serverless systems, I want to discover an unexpectedly relevant session about sustainability, security, or robotics, understand the evidence for that connection, and save a feasible discovery journey.

### 1.1 Users
- **Curious explorer:** wants surprising recommendations without knowing search terms.
- **Goal-driven learner:** wants cross-disciplinary skills while retaining technical relevance.
- **Conference attendee:** needs real session metadata and schedule-aware discovery.
- **Demo judge:** must immediately see why the product differs from conventional catalog search.

### 1.2 Outcomes and success metrics
| Metric | MVP target | Measurement |
|---|---|---|
| Valid session references | 100% | IDs resolve to current indexed catalog |
| Grounded explanation claims | >=95% in curated evaluation | Human evaluation against cited session fields |
| Meaningful-surprise acceptance | >=70% in 20 curated evaluations | Rater says bridge is both useful and non-obvious |
| Recommendation response time | p95 < 5 seconds for cached/indexed catalog, excluding cold start | CloudWatch latency |
| Explanation response time | p95 < 12 seconds, including Bedrock | CloudWatch latency |
| Discovery journey | 2–4 sessions, with conflicts clearly marked | Automated tests |
| Demo readiness | 3 reproducible scripted journeys and offline fallback | Demo checklist |

Targets are engineering objectives, not guarantees. Benchmark on the deployed AWS region and chosen models.

## 2. Scope

### MVP (P0)
1. Import and refresh a selected AWS event's session catalog through the official Events REST API.
2. Normalize session metadata and maintain a searchable, versioned index.
3. Accept one or two topics and optional interests, preferred novelty, and session constraints.
4. Return ranked, surprising but relevant session bridges with deterministic evidence references.
5. Generate concise AI explanations constrained to retrieved catalog evidence.
6. Visualize a clickable graph with topic/session nodes and labeled relationships.
7. Generate a 2–4-session cross-pollination quest; flag scheduling conflicts.
8. Offer explicit **No credible bridge found** behavior.
9. Capture opt-in thumbs-up/down feedback and allow anonymous exploration.
10. Deploy a secured, observable, repeatable AWS stack with a reliable demo seed.

### Stretch (P1)
- Discovery Roulette with bounded randomness and novelty control.
- User profile and saved discoveries via Amazon Cognito.
- Shareable, privacy-safe quest links.
- Compare two discovery paths and show why they differ.
- Schedule/venue-aware quest ordering, subject to catalog field availability.

### Future (P2)
- Attendee schedule import and reservations **only with explicit OAuth consent and documented API permissions**.
- Opt-in aggregated discovery map with privacy thresholds.
- Cross-event discovery and multilingual exploration.

### Explicit non-goals
- Inventing or editing official sessions; claiming session attendance or learning completion.
- Booking/reserving sessions in MVP.
- Ingesting attendee identities, schedules, or private information without authorization.
- Guaranteeing physical travel times when venue coordinates are unavailable.
- Fully autonomous agents with unrestricted external tools.

## 3. External API assumptions and validation gate

AWS Builder guidance documents `https://api.awsevents.com`, REST paths under `/v1`, `GET /v1/events`, `GET /v1/events/{eventId}`, `GET /v1/events/{eventId}/sessions`, and `GET /v1/events/{eventId}/sessions/{sessionId}`. The session list is paginated; **continue until `nextToken` is absent, even if a page is short**. The API does not perform search/filtering; index and filter locally. Some event catalogs may require registration/authentication.

**Before implementation:** retrieve `https://api.awsevents.com/v1/openapi.json`; confirm field names, rate limits, pagination semantics, session identifiers, authorization, licensing, and allowed caching. Treat any optional metadata (track, venue, schedule, tags, level, URL) as nullable. Do not hardcode a specific event ID. Do not expose access tokens in browser code.

## 4. Functional requirements (EARS-style)

### FR-01 — Event selection and ingestion (P0)
**WHEN** an operator selects an event, **THE SYSTEM SHALL** retrieve the event and all available session pages through a backend adapter and persist normalized records with source ID, ingestion timestamp, and schema version.

**Acceptance criteria:**
- Given multi-page responses with short intermediate pages, all pages are retrieved until `nextToken` is absent.
- Repeated ingestion is idempotent by `(eventId, sessionId, contentHash)`.
- Malformed records are quarantined with error reason; one bad session does not fail the entire import.
- API 429/5xx responses are retried with bounded exponential backoff and jitter; permanent 4xx failures are surfaced.
- The UI reports catalog freshness and sync status.

### FR-02 — Catalog integrity (P0)
**WHEN** source sessions change or disappear, **THE SYSTEM SHALL** update or tombstone indexed records and prevent stale references from appearing as current.

**Acceptance criteria:** canonical session IDs remain stable; catalog version is recorded; a failed sync does not overwrite the last successful snapshot; missing optional fields do not crash the UI.

### FR-03 — Topic exploration (P0)
**WHEN** a user submits one or two topics, **THE SYSTEM SHALL** normalize input, enforce length limits, and discover matching sessions with a combined lexical/semantic retrieval strategy.

**Acceptance criteria:** topics are 2–100 characters each; empty, excessive, or malicious-looking input receives safe validation; queries use indexed catalog content rather than direct repeated catalog scans.

### FR-04 — Semantic bridge discovery (P0)
**WHEN** candidate sessions are retrieved, **THE SYSTEM SHALL** score them for relevance, novelty, bridge strength, and diversity, returning only sessions that meet configurable evidence thresholds.

**Acceptance criteria:** results include session IDs, relationship labels, score breakdowns, and catalog-derived evidence; duplicates are removed; results are stable for a fixed catalog version and algorithm seed; novelty never overrides minimum relevance.

### FR-05 — Explainable recommendations (P0)
**WHEN** a bridge is presented, **THE SYSTEM SHALL** explain the conceptual connection using only cited session titles, abstracts, and available metadata.

**Acceptance criteria:** every explanation references at least two real session IDs or explicitly explains a single-session relationship to a user topic; unsupported claims are rejected or replaced by deterministic explanations; uncertainty is disclosed; no fabricated speakers, dates, venues, or outcomes.

### FR-06 — Interactive discovery graph (P0)
**WHEN** discovery results arrive, **THE SYSTEM SHALL** render accessible topic/session nodes and edges with relationship labels and evidence inspection.

**Acceptance criteria:** selecting a node opens the official session details; keyboard access and list-view alternative exist; graph remains usable on mobile and with reduced motion.

### FR-07 — Cross-pollination quests (P0)
**WHEN** the user requests a quest, **THE SYSTEM SHALL** select 2–4 actual sessions that form a coherent cross-domain progression.

**Acceptance criteria:** each step has a rationale; repeated sessions are excluded; time conflicts are detected when start/end data exist; missing times are marked unknown, not assumed conflict-free; links resolve to catalog sessions.

### FR-08 — Discovery Roulette (P1)
**WHEN** a user activates Roulette, **THE SYSTEM SHALL** sample from a prequalified relevant candidate pool, respecting a bounded novelty slider and deterministic optional seed.

**Acceptance criteria:** no random irrelevant sessions; user can reroll; result includes why it was selected.

### FR-09 — Feedback (P0)
**WHEN** a user explicitly rates a recommendation, **THE SYSTEM SHALL** store a minimal feedback record associated with an anonymous rotating session ID or consenting user ID.

**Acceptance criteria:** no feedback is collected without action; no raw IP address or sensitive profile is stored in application records; a delete/reset option is available for saved feedback.

### FR-10 — Empty/error/fallback states (P0)
**IF** no credible connection exists, **THE SYSTEM SHALL** show a truthful no-match state and suggest relaxing constraints; **IF** Bedrock is unavailable, **THE SYSTEM SHALL** show deterministic evidence-based descriptions; **IF** the catalog is temporarily unavailable, **THE SYSTEM SHALL** serve a clearly labeled last-known-good snapshot.

### FR-11 — Authentication and authorization (P0/P1)
**WHEN** accessing administrative ingestion operations, **THE SYSTEM SHALL** require authenticated, authorized operator access. Public discovery may be anonymous with rate limiting. Saved profiles require authenticated ownership checks (P1).

### FR-12 — Demo experience (P0)
**WHEN** the demo starts, **THE SYSTEM SHALL** provide three prevalidated topic pairs, a visibly versioned real catalog snapshot, and a scripted path that demonstrates discovery, evidence, graph, and quest in under three minutes.

## 5. Non-functional requirements

### NFR-01 Security
- TLS for all network traffic; encryption at rest with AWS-managed or customer-managed KMS keys according to threat model.
- IAM least privilege, short-lived credentials, Secrets Manager for secrets, no credentials in repository or frontend.
- API Gateway throttling, request validation, strict CORS allowlist, input limits, and WAF where justified.
- Prompt-injection defenses: source descriptions are untrusted data; models cannot execute instructions from session content.
- No arbitrary outbound URLs from ingestion; use allowlisted official API hostname.

### NFR-02 Reliability
- SQS DLQ for failed processing, idempotent handlers, bounded retries, alarms, last-known-good catalog.
- No partially imported catalog exposed as complete.
- Defined fallback when embedding/generation/vector search is unavailable.

### NFR-03 Performance and scale
- Initial design for ~10k catalog sessions, 100 concurrent explorers; validate against real dataset.
- Paginate result APIs, cap graph size (default <=40 nodes), cache common discoveries, precompute embeddings and candidate neighbors.
- No model invocation per node or per graph edge.

### NFR-04 Cost
- Explicit budget alarms, bounded Bedrock tokens, ingestion batching, short-lived environments, TTL for caches.
- Compare managed vector infrastructure fixed baseline against a smaller low-cost vector approach before choosing deployment tier.

### NFR-05 Observability
- Structured JSON logs with request/correlation IDs; CloudWatch metrics and alarms for ingestion freshness, API errors, latency, model failures, throttling, and spend.
- Avoid logging full prompts, tokens, sensitive data, or credentials by default.

### NFR-06 Accessibility and privacy
- WCAG 2.2 AA as design target, reduced-motion option, responsive UI, keyboard navigation.
- Data minimization, retention policy, explicit opt-in for any aggregated user analytics.

### NFR-07 Maintainability
- TypeScript strict mode, shared runtime schemas, infrastructure as code, automated CI/CD, contract tests, pinned dependencies and dependency scanning.

## 6. AI quality and safety requirements
- Retrieval-grounded generation only; use structured JSON schema for explanations.
- Deterministic scoring and filtering before LLM explanation.
- Separate **observed evidence** from **inferred connection** in UI.
- Version prompt, model ID, embedding model, scoring configuration, and catalog snapshot for reproducibility.
- Offline evaluation set: >=20 topic pairs including irrelevant, ambiguous, adversarial, and no-match cases.
- Evaluate relevance, novelty, grounding, diversity, latency, and cost; inspect regression before release.
- Graceful failure on model refusal, invalid JSON, timeout, or throttling.

## 7. Primary user journeys
1. **Explore:** choose event → enter topic → view unexpected ranked bridges → inspect source evidence → open official session.
2. **Connect two worlds:** enter two domains → receive bridge chain or honest no-match → visualize connecting nodes.
3. **Build a quest:** choose bridge → generate 2–4 session sequence → inspect conflicts → save/share (P1).
4. **Discover randomly:** choose novelty → Roulette from qualified candidates (P1).
5. **Operate:** admin triggers sync → monitors progress/errors → activates complete catalog snapshot.

## 8. Delivery plan and exit gates
| Phase | Scope | Exit criteria |
|---|---|---|
| 0 — API spike | Confirm OpenAPI, pagination, auth, data license, metadata | Real catalog import succeeds |
| 1 — Core data | Normalization, snapshotting, embeddings, indexing | Deterministic end-to-end import |
| 2 — Discovery | Hybrid retrieval, bridge scoring, evidence | 20-case evaluation passes quality gates |
| 3 — Experience | Graph, explanation, quests, responsive UI | Three complete demo journeys |
| 4 — Hardening | Security, alarms, cost caps, fallbacks, tests | CI green and demo checklist complete |

### Definition of done
- All P0 acceptance criteria pass in CI or a documented deployed smoke test.
- No high/critical unresolved security findings.
- Source links, catalog version, and grounded explanations demonstrably work.
- One-click repeatable deployment with documented teardown and bounded costs.
- README includes setup, IAM, required environment variables, demo script, limitations, and cleanup.

## 9. Open decisions
1. Exact event ID and live API contract/registration requirements.
2. Bedrock model and region availability/quotas.
3. Vector store choice after fixed-cost analysis.
4. Whether venue/times/official session deep links are present in catalog data.
5. Hackathon judging, data usage, and deployment restrictions (verify from official rules).

## References
- AWS Events API overview: https://builder.aws.com/content/3JjrKKy63DJ80xhHTHd50DUIoxx/how-to-plan-reinvent-2026-with-the-new-aws-events-api-and-mcp-server
- AWS Events API OpenAPI: https://api.awsevents.com/v1/openapi.json
- AWS Well-Architected Framework: https://docs.aws.amazon.com/wellarchitected/latest/framework/
- AWS Generative AI Lens: https://docs.aws.amazon.com/wellarchitected/latest/generative-ai-lens/
