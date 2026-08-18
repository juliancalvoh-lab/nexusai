# Submission index

Julian Calvo. AAI6850, Module 15 capstone. August 2026.
Project: NexusAI, a multi-chain AI model marketplace.
Repo: https://github.com/juliancalvoh-lab/nexusai

Start with `README.md`. This file just maps the assignment requirements to files.

## Deliverables

| Required | Where it is |
|---|---|
| Production-ready code, 90%+ coverage | `contracts/`, `test/`, `scripts/`, `ml/`. 195 tests. Run `npm run coverage` for the report, or see `docs/screenshots/coverage_report.png` |
| Security audit report | `pdf/NexusAI_Security_Review.pdf`, source `audit/security_audit_report.md`, raw tool output `audit/slither-report.md` |
| Technical documentation | `pdf/NexusAI_Technical_Documentation.pdf`, source `docs/technical_documentation.md`, diagrams in `docs/diagrams/` |
| Business case and ROI | `pdf/NexusAI_Business_Case_and_ROI.pdf`, source `docs/business_case.md`, model `docs/roi_model.csv` |
| Live multi-testnet demo | **Done.** Hub on Ethereum Sepolia, spoke on Ethereum Hoodi, cross-chain workflow executed across both. Addresses and transaction links in `docs/DEPLOYMENT.md` |
| Portfolio repo | https://github.com/juliancalvoh-lab/nexusai. README with setup steps and screenshots (`docs/screenshots/`), CI, licence, diagrams, demo materials |
| AI usage disclosure | `pdf/AI_Usage_Disclosure.pdf` |

The other two PDFs are `pdf/NexusAI_ML_Report.pdf` and `pdf/NexusAI_Monitoring_and_Runbook.pdf`.

## Required components

| # | Component | Code | Tests |
|---|---|---|---|
| 1 | Multi-chain + cross-chain | `contracts/crosschain/`, 5 networks in `scripts/config.js` | `test/CrossChain.test.js`, 18 tests |
| 2 | Tokenomics, staking, governance (handoff executed, 19/19 roles on the Timelock) | `NexusAIToken`, `StakingVault`, `NexusGovernor`, `NexusTimelock` | `test/StakingVault.test.js` (27), `test/Governance.test.js` (13) |
| 3 | Oracle for real-world AI data | `AIPerformanceOracle`, fed by `ml/src/evaluate.py` via `scripts/report-oracle.js` | `test/AIPerformanceOracle.test.js`, 18 tests |
| 4 | Privacy and compliance | `SealedBidLicenceAuction`, `ComplianceRegistry` | `test/SealedBidLicenceAuction.test.js` (23), `test/ComplianceRegistry.test.js` (15) |
| 5 | Security audit prep | Slither, Solhint, 13 manual findings | `audit/security_audit_report.md`, 13 adversarial tests |
| 6 | DevOps and monitoring | `.github/workflows/ci.yml`, 8 jobs | `docs/monitoring.md` |

## Headline results

- 10 contracts, solc 0.8.24, OpenZeppelin 5.6.1, compiling clean
- 195 tests passing
- Coverage 99.76 / 92.56 / 99.15 / 99.82 (statements / branches / functions / lines)
- Slither 45 results, all triaged. Solhint 0 errors
- 13 security findings, 12 fixed, 8 residual risks documented
- Model test F1 0.960 on a synthetic corpus

## Screenshots

`docs/screenshots/` has the test run, the coverage report, the linter, and the
full cross-chain demo. `demo/Calvo_Julian_AAI6850_Demo.mp4` is the recorded walkthrough. Model
plots are in `ml/reports/`, diagrams in `docs/diagrams/`, slides in `demo/`.

Known limitations are in the caveats section of `README.md`.

