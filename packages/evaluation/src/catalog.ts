/**
 * Small synthetic evaluation catalog. Sessions are fictional and exist only to
 * give the golden cases a stable, offline ground truth (AI 20.5).
 */
import type { ScorableSession } from '@serendipity/packages-discovery';

const s = (
  sessionId: string,
  title: string,
  abstract: string,
  track: string,
  topics: string[],
): ScorableSession => ({
  sessionId,
  title,
  abstract,
  track,
  topics,
  level: '300',
  format: 'Breakout session',
  startsAt: '2026-12-01T09:00:00Z',
  venue: 'Venetian',
  officialUrl: `https://example.invalid/sessions/${sessionId}`,
});

export const EVAL_CATALOG_VERSION = 'eval-catalog-2026-01';

export const EVAL_SESSIONS: readonly ScorableSession[] = [
  s(
    'S01',
    'Serverless event-driven architectures with Lambda',
    'Design serverless applications with Lambda and EventBridge. Learn cold start tuning, idempotency, and cost efficiency for event-driven workloads.',
    'Compute',
    ['serverless', 'lambda'],
  ),
  s(
    'S02',
    'Serverless cost efficiency at scale',
    'Right-size serverless functions and reduce idle capacity. Efficiency gains lower both spend and energy consumption for event-driven workloads.',
    'Compute',
    ['serverless', 'cost'],
  ),
  s(
    'S03',
    'Sustainability by design on the cloud',
    'Measure carbon footprint and improve energy efficiency. Sustainability patterns include rightsizing, idle capacity reduction, and efficient scheduling.',
    'Sustainability',
    ['sustainability', 'carbon'],
  ),
  s(
    'S04',
    'Carbon-aware workload scheduling',
    'Shift batch workloads to low-carbon regions and times. Reduce energy consumption and idle capacity with efficient scheduling.',
    'Sustainability',
    ['sustainability', 'carbon'],
  ),
  s(
    'S05',
    'Threat detection with machine learning',
    'Apply machine learning models to security telemetry for anomaly detection. Covers feature pipelines, model drift, and alert triage.',
    'Security',
    ['security', 'threat detection'],
  ),
  s(
    'S06',
    'Securing generative AI applications',
    'Protect generative AI applications against prompt injection and data leakage. Guardrails, anomaly detection, and model access policies.',
    'Security',
    ['security', 'generative ai'],
  ),
  s(
    'S07',
    'Building generative AI agents on Bedrock',
    'Build generative AI agents with foundation models. Covers retrieval augmented generation, tool use, and guardrails for agents.',
    'AI/ML',
    ['generative ai', 'agents'],
  ),
  s(
    'S08',
    'Machine learning pipelines for anomaly detection',
    'Train and deploy machine learning pipelines that detect anomaly patterns in streaming telemetry. Feature pipelines and model drift monitoring.',
    'AI/ML',
    ['machine learning', 'anomaly detection'],
  ),
  s(
    'S09',
    'Data lake governance and lineage',
    'Govern a data lake with fine-grained access, lineage tracking, and data quality checks across analytics pipelines.',
    'Analytics',
    ['data lake', 'governance'],
  ),
  s(
    'S10',
    'Streaming analytics with Kinesis',
    'Process streaming telemetry in real time. Build analytics pipelines with windowing, late data handling, and cost control.',
    'Analytics',
    ['streaming', 'analytics'],
  ),
  s(
    'S11',
    'Kubernetes cost optimization on EKS',
    'Cut container spend with rightsizing, spot capacity, and autoscaling. Reduce idle capacity in Kubernetes clusters.',
    'Containers',
    ['kubernetes', 'cost'],
  ),
  s(
    'S12',
    'Container security and supply chain',
    'Secure container images and the software supply chain. Scan for vulnerabilities, sign artifacts, and enforce admission policies.',
    'Security',
    ['containers', 'security'],
  ),
  s(
    'S13',
    'Quantum computing fundamentals',
    'Introduction to quantum computing with Braket. Qubits, circuits, and hybrid quantum algorithms.',
    'Emerging Tech',
    ['quantum'],
  ),
  s(
    'S14',
    'Healthcare data interoperability',
    'Exchange clinical records using FHIR. Patient privacy, consent management, and interoperability for healthcare providers.',
    'Healthcare',
    ['healthcare', 'fhir'],
  ),
  s(
    'S15',
    'Machine learning for clinical imaging',
    'Train machine learning models on clinical imaging data. Patient privacy, model validation, and regulatory considerations.',
    'Healthcare',
    ['healthcare', 'machine learning'],
  ),
  s(
    'S16',
    'Game server fleets with GameLift',
    'Scale multiplayer game servers globally. Matchmaking, latency optimization, and fleet cost control.',
    'Games',
    ['gaming', 'gamelift'],
  ),
  s(
    'S17',
    'Real-time analytics for live games',
    'Stream player telemetry for live game operations. Anomaly detection on player behavior and streaming analytics pipelines.',
    'Games',
    ['gaming', 'streaming'],
  ),
  s(
    'S18',
    'Network architecture for multi-region resilience',
    'Design resilient multi-region networks with Transit Gateway. Failover, latency, and traffic engineering.',
    'Networking',
    ['networking', 'resilience'],
  ),
  s(
    'S19',
    'Chaos engineering and resilience testing',
    'Practice chaos engineering to validate multi-region failover. Resilience testing for serverless and container workloads.',
    'Architecture',
    ['resilience', 'chaos'],
  ),
  s(
    'S20',
    'Identity and access management deep dive',
    'Least-privilege IAM policy design, permission boundaries, and identity federation for large organizations.',
    'Security',
    ['iam', 'security'],
  ),
  s(
    'S21',
    'Prompt engineering workshop',
    'Hands-on workshop on prompt engineering for foundation models. Evaluation, versioning, and cost control for prompts.',
    'AI/ML',
    ['generative ai', 'prompts'],
  ),
  s(
    'S22',
    'Edge computing for retail',
    'Run inference at the edge in retail stores. Latency, offline operation, and fleet management for edge devices.',
    'Edge',
    ['edge', 'retail'],
  ),
];
