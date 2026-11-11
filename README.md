# Serendipity Engine

Serendipity Engine finds unexpected but defensible connections ("semantic bridges") between real AWS event sessions, explains each one using only cited catalog text, and builds a 2-4 session discovery quest. Ranking, filtering and conflict detection are deterministic. The language model only writes bounded, validated prose, and a deterministic explanation replaces it whenever validation fails or Bedrock is unavailable.

Specs live in `requirements.md`, `design.md` and `.kiro/specs/serendipity-engine/`.

> **Status read this first.** This README describes the repository as it exists today. Items that could not be verified from the repo are marked **(unverified)**. Two gaps matter for deployment, see [Limitations](#limitations): the Lambda handler bundles are not built or wired yet, and live Events API ingestion needs credentials that are not documented.

## Contents

1. [Repository layout](#repository-layout)
2. [Setup](#setup)
3. [Configuration and environment variables](#configuration-and-environment-variables)
4. [IAM](#iam)
5. [Region and Bedrock model access](#region-and-bedrock-model-access)
6. [Deploying](#deploying)
7. [Seeding data](#seeding-data)
8. [Demo script](#demo-script)
9. [Evaluation](#evaluation)
10. [Vector approach and cost comparison](#vector-approach-and-cost-comparison)
11. [Limitations](#limitations)
12. [Teardown and cleanup](#teardown-and-cleanup)
13. [Open decisions](#open-decisions)

## Repository layout

| Path | Purpose |
|---|---|
| `apps/web` | React + Vite UI (landing, bridge cards, graph with list fallback, quest stepper, scripted demo guide) |
| `services/api` | `/api/v1` handlers, route table and throttle policy |
| `services/ingestion` | Events API adapter, normalization, snapshots, publish gate, sync workflow, API spike (`SPIKE.md`) |
| `services/indexer` | Bedrock embedding client, BM25 + vector index, SQS worker |
| `packages/contracts` | Shared Zod schemas, structured logger with redaction |
| `packages/discovery` | Retrieval, scoring, graph, explanation validator/orchestrator, quest planner |
| `packages/evaluation` | Golden cases, metrics, threshold calibration, reports |
| `infra/cdk` | AWS CDK v2 app (Data, Ingestion, Api, Web, Observability stacks) |
| `fixtures` | Sanitized Events API fixtures, demo pairs, offline snapshot, seed CLI |
| `tests` | `unit`, `integration`, `e2e` workspaces (integration and e2e currently contain placeholders only) |
| `.github/workflows/ci-cd.yml` | CI/CD with GitHub OIDC, no static AWS keys |

## Setup

Prerequisites:

- Node.js 22 (the CI workflow uses `NODE_VERSION: '22'`; Lambda runtime is `NODEJS_22_X`). The ingestion spike script uses `node --experimental-strip-types`.
- npm (workspaces). Dependencies are pinned and the lockfile is committed.
- For deployment only: an AWS account, AWS credentials in your shell, and the CDK CLI (installed locally as `aws-cdk` in `infra/cdk`).

```bash
npm ci
npm run format        # prettier --check
npm run lint          # eslint
npm run typecheck     # tsc --noEmit in every workspace
npm test              # vitest run (unit + property tests)
npm run build:web     # type-check and build apps/web into apps/web/dist
npm run synth         # cdk synth (default env: dev), writes infra/cdk/cdk.out
```

Run the UI locally:

```bash
# PowerShell
$env:VITE_API_BASE_URL = "https://<your-api-id>.execute-api.<region>.amazonaws.com"
$env:VITE_EVENT_ID = "<event id>"
npm run dev -w @serendipity/apps-web
```

There is no local API server in the repo. Without a deployed API the UI loads but cannot fetch results.

## Configuration and environment variables

Nothing is hardcoded: the event ID, CORS origins, operators, models and region all come from configuration.

### Web build (Vite, public values only, never put secrets here)

| Variable | Meaning | Default |
|---|---|---|
| `VITE_API_BASE_URL` | Base URL of the deployed HTTP API (trailing slashes trimmed) | empty |
| `VITE_EVENT_ID` | Event ID the UI queries | `default` |

### CDK deploy-time inputs (shell environment and `-c key=value` context)

| Input | Meaning | Default |
|---|---|---|
| `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` | Target account and region, normally set by the CDK CLI from your credentials | from CLI |
| `-c env=dev\|demo` | Environment (retention, tags, destroy-on-delete) | `dev` |
| `-c eventId=<id>` | Event the scheduled sync targets. If absent, the schedule is created **disabled** | none |
| `-c allowedOrigins=https://a,https://b` | Strict CORS allowlist (exact `https` origins or localhost, no wildcards) | `http://localhost:5173` |
| `-c operatorPrincipals=arn1,arn2` | IAM principals allowed on admin routes (trailing `*` matches a prefix) | none |
| `-c apiUrl=https://...` | API URL for the web CSP `connect-src`; set only when supplied | none |
| `-c alertEmail=you@example.com` | Subscriber for alarm and budget notifications | none (alarms exist without a subscriber, the budget is not created) |
| `-c monthlyBudgetUsd=50` | Monthly cost budget, filtered by the `Project=serendipity-engine` tag | `50` |
| `-c bedrockDailyInvocationQuota=5000` | Application-level daily Bedrock invocation alarm | `5000` |

Per-environment retention settings are in `infra/cdk/cdk.json` (`dev` destroys data resources on stack deletion, `demo` retains them).

`textModelId`, `embeddingModelId`, `embeddingDimensions` and `bedrockRegion` are CDK stack props, not CLI context. Defaults are text model `anthropic.claude-3-5-haiku-20241022-v1:0`, embedding model `amazon.titan-embed-text-v2:0`, 1024 dimensions, and the stack region. Change them in `infra/cdk/src/app.ts` if needed.

### Lambda runtime variables (set by CDK, listed for reference)

| Function | Variables |
|---|---|
| Ingestion | `TABLE_NAME`, `STAGING_BUCKET`, `SNAPSHOTS_BUCKET`, `INDEX_BUCKET`, `WORK_QUEUE_URL`, `EVENTS_API_BASE_URL`, `EVENTS_API_ALLOWED_HOST` (`api.awsevents.com`), `EVENTS_API_CREDENTIALS_SECRET_ARN` |
| Indexer | `TABLE_NAME`, `SNAPSHOTS_BUCKET`, `INDEX_BUCKET`, `BEDROCK_EMBEDDING_MODEL_ID`, `BEDROCK_EMBEDDING_DIMENSIONS`, `BEDROCK_REGION` |
| API | `TABLE_NAME`, `SNAPSHOTS_BUCKET`, `INDEX_BUCKET`, `SYNC_STATE_MACHINE_ARN`, `ALLOWED_ORIGINS`, `OPERATOR_PRINCIPALS`, `BEDROCK_TEXT_MODEL_ID`, `BEDROCK_EMBEDDING_MODEL_ID`, `BEDROCK_EMBEDDING_DIMENSIONS`, `BEDROCK_REGION` |

### CI/CD configuration (GitHub)

- Repository variables: `AWS_REGION`, `AWS_DIFF_ROLE_ARN` (optional, read-only role for PR `cdk diff`).
- Environment variables per `dev` and `demo` environment: `AWS_DEPLOY_ROLE_ARN`; optional `CDK_EVENT_ID`, `CDK_ALLOWED_ORIGINS`, `CDK_OPERATOR_PRINCIPALS`, `CDK_ALERT_EMAIL`.
- Configure required reviewers on the `dev` and `demo` GitHub Environments for the approval gate. Deploys run only from `main`.

### Secrets

The Events API credential is stored in a Secrets Manager secret created by the Ingestion stack (`EventsApiCredentials`). CDK creates it empty. An operator sets its value after deploy. Do not commit credentials, and do not commit raw authenticated Events API responses. The format of the secret value the code expects is **(unverified)**, check `services/ingestion` before populating it.

## IAM

Least-privilege roles are defined in `infra/cdk/src`. Summary of what each role can do:

| Role | Allowed |
|---|---|
| Ingestion Lambda | Read/write DynamoDB table, staging and snapshots buckets; read index bucket; send to the work queue; read the Events API secret; write its own log group |
| Indexer Lambda | Read/write table and index bucket; read snapshots bucket; consume the work queue; `bedrock:InvokeModel` on the configured embedding model ARN only |
| API Lambda | Read/write table (feedback and explanation cache); read snapshots and index buckets; `bedrock:InvokeModel` on the configured text and embedding model ARNs (plus inference-profile ARN for `us.`/`eu.`/`apac.` style IDs); `states:StartExecution` on the sync state machine only. No Secrets Manager access |

Access control on the API:

- Public routes (`GET /api/v1/events`, `GET /api/v1/events/{eventId}/status`, `POST /api/v1/discover`, `POST /api/v1/bridges/{bridgeId}/explain`, `POST /api/v1/quests`, `POST /api/v1/feedback`, `DELETE /api/v1/feedback/{anonymousId}`) are anonymous and throttled per route. Explain is throttled hardest (5 rps, burst 10) because it calls Bedrock.
- `POST /api/v1/admin/events/{eventId}/sync` uses `AWS_IAM` authorization. The Api stack outputs `AdminInvokeArnPattern`; grant `execute-api:Invoke` on it to your operator principals, and list them in `operatorPrincipals`.
- AWS WAF is not attached: it cannot be associated with HTTP APIs. Abuse controls are throttling, strict CORS, schema validation, body limits and IAM.

Deployer permissions: the identity running `cdk deploy` needs permission to create the resources above (CloudFormation, IAM roles, KMS, S3, DynamoDB, SQS, Step Functions, EventBridge Scheduler, Lambda, API Gateway, CloudFront, CloudWatch, SNS, Budgets). A minimal deploy policy is **not** provided in the repo **(unverified)**. For CI, use a GitHub OIDC role per environment (`AWS_DEPLOY_ROLE_ARN`).

## Region and Bedrock model access

- The stack region comes from `CDK_DEFAULT_REGION` (your credentials or `AWS_REGION` in CI). Bedrock calls use `bedrockRegion`, which defaults to the stack region.
- Model access: in the Bedrock console for the chosen region, confirm access to the text model and to Titan Text Embeddings V2 (`amazon.titan-embed-text-v2:0`) before syncing or requesting explanations. Whether these models are available in your account, region, and hackathon account type is **(unverified)**; see open decision 2.
- If your region requires a cross-region inference profile for the text model, set `textModelId` to the profile ID (for example one with a `us.` prefix). The API role then gets both the inference-profile ARN and the underlying foundation-model ARN in any region.
- Embeddings: if embeddings are unavailable the system falls back to lexical-only retrieval (BM25). If Bedrock text generation fails, is throttled, or returns output that fails validation, the deterministic explanation is returned.
- The seeded offline snapshot is `lexical-only` and needs no Bedrock access.

## Deploying

```bash
npm ci
npm run build:web
cd infra/cdk
npx cdk bootstrap                      # once per account/region
npx cdk deploy --all -c env=dev \
  -c eventId=<event id> \
  -c allowedOrigins=https://<your-web-origin> \
  -c operatorPrincipals=<operator role arn> \
  -c alertEmail=<you@example.com>
```

Stacks are named `Serendipity-<env>-Data`, `-Ingestion`, `-Api`, `-Web`, `-Observability`. Outputs include `ApiUrl`, `WebUrl`, `DistributionId`, `AlarmTopicArn`, `DashboardName`, bucket names and table name.

Notes:

- The web stack deploys `apps/web/dist` if it exists, otherwise a placeholder page. Run `npm run build:web` first, with `VITE_API_BASE_URL` set if you already know the API URL.
- `allowedOrigins` must include the CloudFront `WebUrl`. That URL is only known after the first deploy, so expect a second deploy with the real origin (and `-c apiUrl=<ApiUrl>` for the CSP). This two-pass flow is inferred from the stack code and has not been exercised end to end **(unverified)**.
- After deploy, set the Events API secret value (see [Secrets](#secrets)), then trigger a sync (see below). A sync can only succeed once live credentials are available (see [Limitations](#limitations)).

Trigger a sync as an operator (SigV4-signed request to the admin route), for example with an IAM-aware client such as `awscurl`:

```bash
awscurl --service execute-api --region <region> -X POST \
  "<ApiUrl>/api/v1/admin/events/<event id>/sync"
```

The scheduled sync runs hourly by default when `eventId` is supplied.

## Seeding data

The seed CLI builds a versioned snapshot and index and checks the three prevalidated demo pairs against it.

```bash
# Rebuild the committed offline fallback snapshot from the sanitized sample catalog
npm run seed:offline -w @serendipity/fixtures

# Build a snapshot from a real imported catalog (staged Events API pages: a JSON file or a directory)
npm run seed -w @serendipity/fixtures -- --input <file|dir> --event-id <id> [--out <dir>]
```

- A live import fails if no valid sessions are found. Demo pairs that behave unexpectedly on a live catalog are reported as warnings.
- Default output for live imports is `fixtures/demo/seed-output/<catalogVersion>`.
- The committed offline snapshot (`fixtures/demo/offline-snapshot`) contains 14 **fictional, sanitized** sessions and is labeled `OFFLINE SAMPLE DATA` (`live: false`). It must never be presented as live catalog data.
- Loading a seeded snapshot into the deployed S3 buckets and DynamoDB active-version pointer is not automated by the seed CLI **(unverified)**; use the sync workflow for deployed environments.

To refresh the Events API contract spike, run `npm run spike -w @serendipity/services-ingestion` (no credentials are used; findings are in `services/ingestion/SPIKE.md`).

## Demo script

Target: under three minutes (`DEMO_BUDGET_SECONDS = 180`). The in-app demo guide follows the same steps and the three topic-pair buttons on the landing page. The pairs are defined in `fixtures/demo/demo-pairs.json` and `apps/web/src/demo-examples.ts`.

| # | Step | Time | What to do and say |
|---|---|---|---|
| 1 | Check the catalog snapshot | 0:15 | Point to the catalog version and freshness in Catalog status. State whether it is live or the labeled offline sample. |
| 2 | Discover | 0:25 | Run **serverless + sustainability**. Ranked connections appear with score breakdowns. |
| 3 | Inspect the evidence | 0:35 | Open the top connection. Contrast "Observed evidence" (catalog text) with "Inferred connection" (interpretation) and the uncertainty note. |
| 4 | Explore the graph | 0:25 | Use the graph or its list view; select a session node to open session details. Show keyboard operation if asked. |
| 5 | Plan a quest | 0:30 | In the details panel choose "Plan a quest". Show 2-4 sessions, rationales, and conflict or unknown-schedule badges. |
| 6 | Second pair | 0:20 | Run **security + AI** to show an independently scored result. |
| 7 | Honest no-match | 0:20 | Run the unsupported pair (**medieval falconry + quantum knitting**). The engine reports no credible bridge instead of forcing one. |

Total: 2:50.

Expectations from the offline sample (from `meta.json`): serverless + sustainability and security + AI each return bridges, and the unsupported pair returns no match. Results on a real catalog are **(unverified)** until a live import has been run; the seed CLI warns if a pair does not behave as expected.

Say plainly in the demo which data you are showing. If it is the offline snapshot, say so.

## Evaluation

`packages/evaluation` holds 22 labeled topic pairs (relevant, ambiguous, irrelevant, no-match, adversarial), metrics for relevance, novelty, grounding, diversity, latency and cost, and a threshold calibration.

```bash
npm run report -w @serendipity/packages-evaluation
```

Committed reports are in `packages/evaluation/reports/`. Current results (22 cases, `R_min=0.3`, `B_min=0.25`): outcome accuracy 95.5%, false-bridge rate 0.0%, missed-bridge rate 9.1%, grounding of evidence excerpts 100% (checked programmatically). The set is small and synthetic, thresholds are not statistically validated, latency is in-memory only, and the cost figure is an estimate from the harness. Human grounding and meaningful-surprise ratings (targets: 95% and 70%) have **not** been collected.

## Vector approach and cost comparison

Requirement NFR-04 (16.2) asks for a documented comparison before a deployment tier is chosen. No dollar figures are quoted here because prices vary by region and change; verify against the AWS pricing pages **(unverified)** and measure with your own catalog.

| | S3-hosted local index (current implementation) | OpenSearch Serverless (not implemented) |
|---|---|---|
| How it works | Precomputed compact index (BM25 + vectors + top-K neighbors) stored in S3 keyed by catalog version and embedding model version; loaded into Lambda memory and cached per warm container | Managed collection with explicit vector index mappings and filtered vector queries |
| Fixed baseline cost | None beyond S3 storage and Lambda invocations | Capacity (OCU) is billed while the collection exists, even with no traffic. Minimum capacity and price: check current pricing |
| Scale-with-traffic | Pay per request, but each cold container pays a load cost | Capacity scales with load; OCU billing continues |
| Query latency | In-memory after load; cold start includes S3 download and deserialize (not benchmarked) | Network hop per query; no cold-load of the index |
| Fit at ~10,000 sessions, 1024-dim vectors | Raw float32 vectors are roughly 40 MB, which is plausible in Lambda memory. Not benchmarked here | Comfortably within scope |
| Limits | Lambda memory, artifact size and cold start grow with the catalog; concurrency multiplies memory use | Needs access/encryption policies and more infra to operate |
| Precomputed neighbors for custom pairwise bridge scoring | Built in at index time | Possible, but would need an extra build step |

Decision for the MVP: S3 local index, as recorded in `design.md` (decision 003), because it avoids a fixed idle baseline for a short-lived demo. Switch triggers: the catalog or concurrency outgrows Lambda memory, or cold-start latency misses the p95 targets in a load test. The real catalog size and the load test (100 concurrent explorers) have not been run **(unverified)**.

Other cost controls in place: embeddings only for changed sessions (content-hash diff), explanation cache keyed by `(catalogVersion, bridgeId, promptVersion, modelId)` with TTL, token caps, strict throttling on the explain route, a monthly AWS Budget (only created when `alertEmail` is set), and a daily Bedrock invocation alarm. AWS Budgets notifications are **not** hard spending caps.

## Limitations

- **Lambda bundles are not built or wired.** `IngestionStack`, `IndexerFunction` and `ApiStack` default to an inline stub that throws "Lambda bundle not provided", and `infra/cdk/src/main.ts` does not pass `apiCode`, `ingestionCode` or `indexerCode`. No `handler` entry point or bundling step exists in `services/*`. A deploy from this repo creates the infrastructure, but the API and sync workflow will fail until bundles are built and passed in. This is deliberate fail-loud behavior, not a silent fallback.
- **Live ingestion is blocked on credentials.** Per the spike, `ListSessions` returned 401 anonymously for the observed event, and how a server-side job obtains a bearer token (scope `events/access`) is not documented. All session fixtures other than `event.live-observed.json` and `error.401.json` are synthetic. No authenticated payload has been seen, so field mappings (for example which taxonomy arrays become tags) are based on the OpenAPI spec only.
- **No official session deep link.** The Events API has no URL field on sessions. The UI only shows an official link if one is present in the data, and links are not constructed.
- Licensing, caching and LLM-use terms for session content are unresolved. Do not publish or commit real catalog data until confirmed.
- No booking, reservation, schedule import or user-state API calls are made.
- Venue, time and schedule fields are optional in the API. Missing times are shown as unknown schedule and never as conflict-free. Travel time is not computed.
- Evaluation is small and synthetic (see above). Surprise and grounding have not been human-rated.
- Integration and end-to-end suites are placeholders (`tests/integration`, `tests/e2e`), and several optional test tasks (for example property tests for some modules, CDK assertion tests, end-to-end journeys and accessibility tests) are not implemented. The CI `integration` and `e2e` jobs therefore pass without exercising much. The e2e job expects `E2E_API_URL` and `E2E_WEB_URL` from the deploy job.
- Accessibility targets WCAG 2.2 AA, but conformance has not been verified. That requires manual testing with assistive technologies and expert review.
- P1 features (Roulette, Cognito profiles, share links) are optional tasks and are not part of this baseline unless noted in `tasks.md`.
- Performance targets (p95 under 5 s for discovery and 12 s for explanation) are objectives, not measured on a deployed stack.
- WAF is not used (HTTP API limitation, see IAM).

## Teardown and cleanup

Teardown is per environment. Review before running: deletion is not reversible for data in destroyed resources.

```bash
cd infra/cdk
npx cdk destroy --all -c env=dev
```

What to expect:

- `dev` sets `destroyOnDelete: true`, so tables, buckets, queues, secrets and log groups use the DESTROY removal policy. The data buckets set `autoDeleteObjects` to follow `destroyOnDelete`, so `dev` buckets are emptied automatically. The `demo` table also has `deletionProtection` enabled, so disable it before deleting the table manually.
- `demo` sets `destroyOnDelete: false`, so data resources (KMS key, buckets, table, queues, secret, logs) are **retained** after `cdk destroy`. Delete them manually when you are finished judging:
  - Empty then delete the buckets listed in the Data stack outputs (`SnapshotsBucketName`, `StagingBucketName`, `IndexBucketName`). Buckets are versioned, so remove all object versions and delete markers.
  - Delete the DynamoDB table (`TableName`), the SQS queue and DLQ, the Events API secret, and the log groups.
  - Schedule deletion of the KMS key (`KmsKeyArn`). Deletion has a mandatory waiting period.
- The AWS Budget and alarms live in the Observability stack and are removed with it. Confirm the SNS topic and email subscription are gone.
- CloudFront takes several minutes to delete.
- Remove the CDK bootstrap stack (`CDKToolkit`) and its staging bucket only if nothing else in the account/region uses it.
- Remove GitHub environment variables and the OIDC role created for deployment if they are no longer needed.
- Local cleanup: `infra/cdk/cdk.out` and `apps/web/dist` are build output and can be deleted. `fixtures/demo/seed-output/` holds generated seed data. Do not leave real catalog data in the repository.
- After teardown, check Cost Explorer and the Billing console for lingering resources (the `Project=serendipity-engine` tag identifies resources created by this app).

## Open decisions

Carried from `requirements.md` and `services/ingestion/SPIKE.md`. None of these are resolved by this repository.

1. **Event ID, live API contract and registration.** `reinvent2026` was the only event listed anonymously and has `authenticationRequired: true`, but it is configuration and the owner should confirm it. Whether registration or attendee sign-in is required, and whether a service identity may be used, is unknown.
2. **Bedrock model and region availability and quotas.** The default models and region are placeholders until access and quotas are confirmed in the target account.
3. **Vector store choice** after fixed-cost analysis and a load test. The S3 local index is the MVP choice.
4. **Presence of venue, times and official deep links in the real catalog.** The OpenAPI spec has venue, room and `sessionTime` as optional and has no URL field. Whether to construct links from `eventId` + `sessionId` or omit them is undecided.
5. **Hackathon judging, data usage and deployment restrictions.** Verify from the official rules.
6. Events API credentials for the ingestion service (how to obtain a bearer token for scope `events/access`).
7. Tags mapping: which taxonomy arrays (`topics`, `areasOfInterest`, `focusAreas`, `services`, and others) feed `tags` and `searchableText`.
8. Licensing and retention of session content, including use with an LLM.
9. Token expiry and catalog changes during pagination; real catalog size and rate limits.
10. How the Lambda bundles will be built and passed to the stacks (see Limitations).
