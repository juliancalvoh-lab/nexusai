# Model card: NexusAI phishing-email detector

## Model details
- **Name / id in marketplace:** NexusAI flagship phishing-detection classifier
- **Selected architecture:** `M6_softvote_M3_M5`
- **Selection criterion:** validation PR-AUC (chosen on validation, never test)
- **Version / seed:** seed 6850, trained 2026-08-18T04:23:57.658957+00:00
- **Feature families:** (A) TF-IDF word 1-2gram + char_wb 3-5gram over subject+body;
  (B) 30 URL & lexical surface features; (C) 22 header/authentication features
- **Operating threshold:** 0.2723, chosen to minimise
  `4.0*FN + 1.0*FP`
  subject to precision >= 0.9
- **License gate:** the accuracy reported here is what `ml/src/evaluate.py` pushes to
  `AIPerformanceOracle`, which gates marketplace sales.

## Intended use
Flagging inbound email as phishing for **human-reviewed quarantine** in an
enterprise mail pipeline. It is a triage aid, not an autonomous delete action.

### Out of scope
- Autonomous deletion of mail, or any irreversible action without review.
- Non-email channels (SMS, voice, chat): no such data was seen in training.
- Languages other than English; the corpus is English-only.
- Attachment//payload analysis: only the *presence* of an attachment is used,
  never its content.

## Training data
- **Provenance: `synthetic`.** 8000 corpus records
  (3356 phishing / 4644 benign) across
  1574 near-duplicate groups; a further 1200-record
  secret holdout, 300 of which use templates the
  corpus never contains.
- 1.5% symmetric label noise is injected on purpose, so the
  Bayes error is non-zero and a perfect score is impossible.
- **The headline numbers are synthetic-data numbers** (the build environment has
  restricted egress). See the ML report for the external-validity discussion
  and the exact procedure to re-run on the Nazario / SpamAssassin / PhishTank corpora.

## Evaluation
Grouped stratified split (4797/1603/1600),
groups disjoint across splits.

| metric | test @ tuned t=0.272 | test @ 0.5 |
|---|---|---|
| precision | 0.9572 | 0.9816 |
| recall | 0.9629 | 0.9510 |
| F1 | 0.9600 | 0.9660 |
| accuracy | 0.9663 | 0.9719 |
| ROC-AUC | 0.9813 | n/a |
| PR-AUC | 0.9740 | n/a |

Confusion matrix at the operating point: TN=898, FP=29, FN=25, TP=648.

## Ethical considerations & limitations
- **False positives (29 on test)** quarantine legitimate mail: missed
  invoices, missed job offers, and erosion of trust in the warning banner. This is
  why a hard precision floor constrains the threshold rather than pure cost
  minimisation.
- **False negatives (25 on test)** reach the user with no warning.
  12 of them pass all three authentication
  checks and 1 contain no URL at all, i.e. the
  residual risk is concentrated in business-email-compromise, exactly the class with
  the highest per-incident loss.
- **Privacy:** email bodies are among the most sensitive data an enterprise holds.
  See the ML report for the hashed-feature / on-device deployment mitigation
  and how it maps to the platform's selective-disclosure compliance design.
- **Adversarial pressure:** every feature here is attacker-observable and the
  lexical ones are cheap to evade. Treat this as one layer, not a control.
- **Bias:** brand and vocabulary coverage reflect the corpus. Mail in other
  languages, or from small senders with imperfect SPF/DKIM, is more likely to be
  falsely flagged.

## Maintenance
`ml/src/evaluate.py` re-scores the secret holdout and publishes
(accuracyBps, p95 latencyMs, driftBps) each epoch. A drift spike or an accuracy
jump beyond `maxDeviationBps` trips the on-chain circuit breaker and closes the
marketplace quality gate until a human clears it.
