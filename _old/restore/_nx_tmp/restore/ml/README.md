# ML: phishing detection

The model that gets listed on the marketplace. Its evaluation output feeds the
on-chain oracle.

## Run it

```bash
pip install -r requirements.txt
python data/build_dataset.py    # writes data/corpus.jsonl and data/holdout.jsonl
python src/train.py             # trains the ladder, writes reports/
python src/evaluate.py          # writes reports/oracle_report.json
```

Or from the repo root: `npm run ml:all`. Takes about 95 seconds. Seed is 6850,
so it reproduces.

The generated corpus is not in the zip, it's 6 MB and `build_dataset.py` rebuilds
it byte for byte from the seed. `data/holdout_manifest.json` holds the hash it
should produce.

## Files

```
data/build_dataset.py   corpus generation (and the real-corpus loaders)
src/features.py         the three feature families
src/train.py            model ladder, threshold selection, plots
src/evaluate.py         final test eval + oracle payload
reports/                metrics, plots, model card, error examples
docs/ml_report.md       the full write-up
```

## Results

Selected model is a soft vote over a HistGradientBoosting model on URL and
header features and a tuned logistic regression on all three families.

Test set: F1 0.960, precision 0.957, recall 0.963, ROC-AUC 0.981, at threshold
0.272.

## Caveat

The corpus is synthetic. The machine this was built on can't reach the public
phishing datasets, so `build_dataset.py` generates 8,000 records from a seeded
RNG. The real loaders (Nazario, SpamAssassin, PhishTank, UCI) are written and
get tried first, but have never run against real files here. Limitations are in
`docs/ml_report.md` section 10.

## Oracle handoff

`src/evaluate.py` writes `reports/oracle_report.json`:

```json
{
  "modelId": "0x1d1a...",
  "accuracyBps": 9742,
  "latencyMs": 11,
  "driftBps": 514,
  "evaluationCommit": "59a6738f..."
}
```

`scripts/report-oracle.js` in the repo root reads that and calls
`AIPerformanceOracle.submitReport`. `evaluationCommit` is the hash of the
holdout manifest, so a third party could in principle reproduce the score.
