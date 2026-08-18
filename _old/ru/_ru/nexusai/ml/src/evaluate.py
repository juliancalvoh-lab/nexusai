#!/usr/bin/env python3
"""Scores the holdout set and writes reports/oracle_report.json for the oracle.

Run: python src/evaluate.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
from sklearn.metrics import (accuracy_score, average_precision_score, f1_score,
                             precision_score, recall_score, roc_auc_score)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import features as F  # noqa: E402  (also registers SoftVoteEnsemble for unpickling)

ROOT = Path(__file__).resolve().parent.parent
BPS = 10_000
PSI_EPS = 1e-6


def compute_model_id(model_path: Path, model_name: str) -> str:
    """Deterministic 32-byte id over the artifact bytes + logical model name."""
    h = hashlib.sha256()
    h.update(b"nexusai:model:v1|")
    h.update(model_name.encode())
    h.update(b"|")
    h.update(model_path.read_bytes())
    return "0x" + h.hexdigest()


def population_stability_index(reference_hist: np.ndarray, current: np.ndarray,
                               bins: np.ndarray) -> float:
    """PSI = sum over bins of (cur% - ref%) * ln(cur% / ref%), empty bins floored."""
    cur_hist, _ = np.histogram(current, bins=bins)
    ref_pct = reference_hist / max(1, reference_hist.sum())
    cur_pct = cur_hist / max(1, cur_hist.sum())
    ref_pct = np.clip(ref_pct, PSI_EPS, None)
    cur_pct = np.clip(cur_pct, PSI_EPS, None)
    return float(np.sum((cur_pct - ref_pct) * np.log(cur_pct / ref_pct)))


def measure_latency(model, df, n_samples: int = 200, warmup: int = 10) -> dict[str, float]:
    """p95 single-record latency, feature extraction included."""
    n = min(n_samples, len(df))
    idx = np.linspace(0, len(df) - 1, n).astype(int)
    for j in idx[:warmup]:                      # warm caches / lazy imports
        model.predict_proba(df.iloc[[j]])
    times = []
    for j in idx:
        row = df.iloc[[j]]
        t0 = time.perf_counter()
        model.predict_proba(row)
        times.append((time.perf_counter() - t0) * 1000.0)
    t = np.array(times)
    return {"p50_ms": float(np.percentile(t, 50)), "p95_ms": float(np.percentile(t, 95)),
            "p99_ms": float(np.percentile(t, 99)), "mean_ms": float(t.mean()),
            "n_samples": int(n)}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=str(ROOT / "artifacts" / "model.joblib"))
    ap.add_argument("--meta", default=str(ROOT / "artifacts" / "train_meta.json"))
    ap.add_argument("--holdout", default=str(ROOT / "data" / "holdout.jsonl"))
    ap.add_argument("--manifest", default=str(ROOT / "data" / "holdout_manifest.json"))
    ap.add_argument("--out", default=str(ROOT / "reports" / "oracle_report.json"))
    ap.add_argument("--latency-samples", type=int, default=200)
    ap.add_argument("--model-id", default=None,
                    help="Override the derived modelId with the marketplace's registered "
                         "0x-prefixed 32-byte id. Use this in production: the derived id "
                         "changes whenever the artifact changes, which would otherwise "
                         "report a retrained model as a different asset.")
    args = ap.parse_args(argv)

    model_path = Path(args.model)
    meta_path = Path(args.meta)
    holdout_path = Path(args.holdout)
    manifest_path = Path(args.manifest)

    for p in (model_path, meta_path, holdout_path, manifest_path):
        if not p.exists():
            print(f"[evaluate] ERROR: missing {p}. Run data/build_dataset.py and "
                  f"src/train.py first.", file=sys.stderr)
            return 2

    meta = json.loads(meta_path.read_text())
    model = joblib.load(model_path)
    df = F.load_records(holdout_path)
    y = df["label"].to_numpy()
    print(f"[evaluate] holdout: {len(df)} records, phishing rate {y.mean():.4f}")

    thr = float(meta["threshold"])
    p = model.predict_proba(df)[:, 1]
    yhat = (p >= thr).astype(int)

    acc = accuracy_score(y, yhat)
    prec = precision_score(y, yhat, zero_division=0)
    rec = recall_score(y, yhat, zero_division=0)
    f1 = f1_score(y, yhat, zero_division=0)

    # drift
    bins = np.asarray(meta["reference_score_bins"], dtype=float)
    ref_hist = np.asarray(meta["reference_score_hist"], dtype=float)
    psi = population_stability_index(ref_hist, p, bins)
    drift_bps = int(min(BPS, max(0, round(psi * BPS))))

    # latency
    lat = measure_latency(model, df, args.latency_samples)
    latency_ms = max(1, math.ceil(lat["p95_ms"]))

    # identity
    model_id = args.model_id or compute_model_id(model_path, str(meta["selected_model"]))
    if not model_id.startswith("0x"):
        model_id = "0x" + model_id
    evaluation_commit = sha256_file(manifest_path)

    accuracy_bps = int(min(BPS, max(0, round(acc * BPS))))

    # exact schema scripts/report-oracle.js expects, do not rename these keys
    report = {
        "modelId": model_id,
        "accuracyBps": accuracy_bps,
        "latencyMs": int(latency_ms),
        "driftBps": drift_bps,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "evaluationCommit": evaluation_commit,
    }

    # check what the contract requires before we write anything
    assert isinstance(report["modelId"], str) and report["modelId"].startswith("0x")
    assert len(report["modelId"]) == 66, "modelId must be 0x + 64 hex chars (32 bytes)"
    int(report["modelId"], 16)
    assert 0 <= report["accuracyBps"] <= BPS, "accuracyBps out of range (contract reverts)"
    assert 0 <= report["driftBps"] <= BPS, "driftBps out of range (contract reverts)"
    assert report["latencyMs"] >= 0 and report["latencyMs"] < 2**32
    assert len(report["evaluationCommit"]) == 64
    int(report["evaluationCommit"], 16)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    # readable sidecar, kept separate so the oracle report stays at six keys
    detail = {
        "oracle_report": report,
        "model": {"path": str(model_path), "name": meta["selected_model"],
                  "threshold": thr, "trained_at": meta.get("trained_at")},
        "holdout": {
            "path": str(holdout_path), "n": int(len(df)),
            "phishing": int(y.sum()), "benign": int((1 - y).sum()),
            "unseen_template_records": int(
                (~df["template_id"].isin(
                    set(F.load_records(ROOT / "data" / "corpus.jsonl")["template_id"]))).sum()
            ) if (ROOT / "data" / "corpus.jsonl").exists() else None,
        },
        "metrics": {
            "accuracy": float(acc), "precision": float(prec), "recall": float(rec),
            "f1": float(f1), "roc_auc": float(roc_auc_score(y, p)),
            "pr_auc": float(average_precision_score(y, p)),
            "tp": int(((y == 1) & (yhat == 1)).sum()), "fp": int(((y == 0) & (yhat == 1)).sum()),
            "fn": int(((y == 1) & (yhat == 0)).sum()), "tn": int(((y == 0) & (yhat == 0)).sum()),
        },
        "drift": {
            "psi": psi, "psi_bps": drift_bps,
            "interpretation": ("no material shift (<0.10)" if psi < 0.10 else
                               "moderate shift (0.10-0.25)" if psi < 0.25 else
                               "material shift (>0.25), investigate"),
            "reference_mean_score": meta.get("reference_mean_score"),
            "holdout_mean_score": float(p.mean()),
        },
        "latency": lat,
        "test_set_reference": {"accuracy": meta.get("test_accuracy"), "f1": meta.get("test_f1")},
        "generalisation_gap": {
            "note": "holdout minus test. The holdout is group-disjoint from the whole "
                    "corpus AND 25% of it uses templates the training corpus never "
                    "contained, so a modest drop here is expected and healthy.",
            "accuracy_delta": float(acc - meta.get("test_accuracy", acc)),
            "f1_delta": float(f1 - meta.get("test_f1", f1)),
        },
    }
    (out.parent / "oracle_report_detail.json").write_text(
        json.dumps(detail, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(report, indent=2))
    print(f"[evaluate] holdout accuracy {acc:.4f}  P={prec:.4f} R={rec:.4f} F1={f1:.4f}")
    print(f"[evaluate] PSI {psi:.4f} ({drift_bps} bps): {detail['drift']['interpretation']}")
    print(f"[evaluate] latency p50={lat['p50_ms']:.2f}ms p95={lat['p95_ms']:.2f}ms "
          f"-> reported {latency_ms}ms")
    print(f"[evaluate] wrote {out} and {out.parent / 'oracle_report_detail.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
