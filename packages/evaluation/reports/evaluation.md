# Evaluation report

Thresholds: R_min=0.3, B_min=0.25. Cases: 22.

| Metric | Value |
|---|---|
| Outcome accuracy | 95.5% |
| False-bridge rate (no-match cases) | 0.0% |
| Missed-bridge rate (bridge cases) | 9.1% |
| Relevance (bridge precision) | 98.0% |
| Novelty (mean component) | 0.498 |
| Grounding (evidence excerpts verified) | 100.0% |
| Diversity (distinct sessions) | 63.0% |
| Latency p50 / p95 | 0.11 ms / 0.43 ms |
| Estimated explanation cost (total / per case) | $0.01344 / $0.00061 |

## Cases

| Case | Category | Expected | Result | Bridges | OK |
|---|---|---|---|---|---|
| G01 | relevant | bridge | bridge | 3 | yes |
| G02 | relevant | bridge | bridge | 3 | yes |
| G03 | relevant | bridge | bridge | 2 | yes |
| G04 | relevant | bridge | bridge | 5 | yes |
| G05 | relevant | bridge | bridge | 4 | yes |
| G06 | relevant | bridge | bridge | 2 | yes |
| G07 | relevant | bridge | bridge | 6 | yes |
| G08 | relevant | bridge | bridge | 2 | yes |
| G09 | relevant | bridge | bridge | 4 | yes |
| G10 | relevant | bridge | no-match | 0 | NO |
| G11 | ambiguous | bridge | bridge | 1 | yes |
| G12 | irrelevant | no-match | no-match | 0 | yes |
| G13 | irrelevant | no-match | no-match | 0 | yes |
| G14 | no-match | no-match | no-match | 0 | yes |
| G15 | no-match | no-match | no-match | 0 | yes |
| G16 | no-match | no-match | no-match | 0 | yes |
| G17 | adversarial | no-match | no-match | 0 | yes |
| G18 | adversarial | no-match | no-match | 0 | yes |
| G19 | adversarial | no-match | no-match | 0 | yes |
| G20 | ambiguous | no-match | no-match | 0 | yes |
| G21 | ambiguous | no-match | no-match | 0 | yes |
| G22 | adversarial | no-match | no-match | 0 | yes |

Grounding is verified programmatically against cited session fields. Human grounding and meaningful-surprise ratings are still required before release.
