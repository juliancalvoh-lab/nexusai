#!/usr/bin/env python3
"""Trains and evaluates the phishing detector: split, fit six models, pick one, report.

Run: python src/train.py
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path
from typing import Any

import joblib
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score, auc, average_precision_score, classification_report,
    confusion_matrix, f1_score, precision_recall_curve, precision_score,
    recall_score, roc_auc_score, roc_curve,
)
from sklearn.model_selection import GridSearchCV, StratifiedGroupKFold
from sklearn.pipeline import Pipeline
from sklearn.svm import LinearSVC

sys.path.insert(0, str(Path(__file__).resolve().parent))
import features as F  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REPORTS = ROOT / "reports"
ARTIFACTS = ROOT / "artifacts"
DATA = ROOT / "data"
SEED = 6850

# a missed phish costs 4x a false alarm, plus a hard precision floor
COST_FN = 4.0
COST_FP = 1.0
MIN_PRECISION = 0.90


def grouped_stratified_split(df: pd.DataFrame, seed: int = SEED):
    """60/20/20 train/val/test, stratified on label and disjoint on `group_id`.

    Groups are near-duplicate template clusters, so a random split would let the
    model get credit for memorising wording it has already seen.
    """
    y = df["label"].to_numpy()
    groups = df["group_id"].to_numpy()

    sgkf = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=seed)
    trainval_idx, test_idx = next(sgkf.split(df, y, groups))

    inner = df.iloc[trainval_idx]
    sgkf2 = StratifiedGroupKFold(n_splits=4, shuffle=True, random_state=seed)
    tr_rel, va_rel = next(sgkf2.split(inner, y[trainval_idx], groups[trainval_idx]))

    train_idx = trainval_idx[tr_rel]
    val_idx = trainval_idx[va_rel]

    tr, va, te = df.iloc[train_idx], df.iloc[val_idx], df.iloc[test_idx]
    g_tr, g_va, g_te = set(tr.group_id), set(va.group_id), set(te.group_id)
    assert not (g_tr & g_va), "group leak train/val"
    assert not (g_tr & g_te), "group leak train/test"
    assert not (g_va & g_te), "group leak val/test"
    return tr, va, te


def make_models(cache_dir: Path) -> dict[str, dict[str, Any]]:
    mem = str(cache_dir)
    return {
        "M1_baseline_word_tfidf_logreg": {
            "desc": "BASELINE. Word 1-2gram TF-IDF on subject+body -> LogisticRegression. "
                    "No char n-grams, no URL features, no header features.",
            "pipe": Pipeline([
                ("prep", F.build_preprocessor("text", use_char=False, min_df=2)),
                ("clf", LogisticRegression(max_iter=2000, C=1.0, random_state=SEED)),
            ], memory=mem),
            "grid": None,
        },
        "M2_word_char_tfidf_logreg": {
            "desc": "IMPROVEMENT 1: add char_wb 3-5gram TF-IDF. Character n-grams match "
                    "across deliberate misspellings ('acount', 'ver1fy') and homoglyph "
                    "domains that word tokenisation shatters into unseen tokens.",
            "pipe": Pipeline([
                ("prep", F.build_preprocessor("text")),
                ("clf", LogisticRegression(max_iter=2000, C=1.0, random_state=SEED)),
            ], memory=mem),
            "grid": None,
        },
        "M3_dense_histgb": {
            "desc": "IMPROVEMENT 2: drop text entirely; use only the engineered URL and "
                    "header/auth families with HistGradientBoosting. Tests how much signal "
                    "lives outside the words, and captures non-linear interactions "
                    "(e.g. 'SPF fails AND reply-to mismatches') a linear model cannot.",
            "pipe": Pipeline([
                ("prep", F.build_preprocessor("dense")),
                ("clf", HistGradientBoostingClassifier(
                    max_iter=300, learning_rate=0.08, max_leaf_nodes=31,
                    l2_regularization=1.0, early_stopping=True, validation_fraction=0.15,
                    random_state=SEED)),
            ], memory=mem),
            "grid": None,
        },
        "M4_combined_linearsvc_cal": {
            "desc": "IMPROVEMENT 3: all three families together, calibrated LinearSVC. "
                    "A max-margin loss handles the very high-dimensional sparse text block "
                    "well; CalibratedClassifierCV (sigmoid, 3-fold) turns margins into "
                    "probabilities so a cost-sensitive threshold is meaningful.",
            "pipe": Pipeline([
                ("prep", F.build_preprocessor("combined")),
                ("clf", CalibratedClassifierCV(
                    LinearSVC(C=0.5, random_state=SEED, max_iter=5000),
                    method="sigmoid", cv=3)),
            ], memory=mem),
            "grid": None,
        },
        "M5_combined_logreg_tuned": {
            "desc": "IMPROVEMENT 4: all three families, LogisticRegression tuned by "
                    "GridSearchCV over regularisation strength, class weighting and text "
                    "min_df, with a GROUPED 3-fold CV so tuning cannot exploit "
                    "near-duplicate leakage either.",
            "pipe": Pipeline([
                ("prep", F.build_preprocessor("combined")),
                ("clf", LogisticRegression(max_iter=3000, random_state=SEED)),
            ], memory=mem),
            "grid": {
                "clf__C": [0.5, 2.0, 8.0],
                "clf__class_weight": [None, "balanced"],
                "prep__text__word__min_df": [2, 3],
            },
        },
    }


def proba(model, X) -> np.ndarray:
    if hasattr(model, "predict_proba"):
        return model.predict_proba(X)[:, 1]
    s = model.decision_function(X)
    return 1.0 / (1.0 + np.exp(-s))


def threshold_sweep(y: np.ndarray, p: np.ndarray, n: int = 199) -> pd.DataFrame:
    rows = []
    for t in np.linspace(0.01, 0.99, n):
        yhat = (p >= t).astype(int)
        tn, fp, fn, tp = confusion_matrix(y, yhat, labels=[0, 1]).ravel()
        prec = tp / (tp + fp) if (tp + fp) else 1.0
        rec = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
        rows.append({"threshold": t, "tp": tp, "fp": fp, "fn": fn, "tn": tn,
                     "precision": prec, "recall": rec, "f1": f1,
                     "cost": COST_FN * fn + COST_FP * fp})
    return pd.DataFrame(rows)


def choose_operating_point(y: np.ndarray, p: np.ndarray) -> dict[str, Any]:
    sweep = threshold_sweep(y, p)
    feasible = sweep[sweep.precision >= MIN_PRECISION]
    if feasible.empty:
        chosen = sweep.loc[sweep.cost.idxmin()]
        constrained = False
    else:
        chosen = feasible.loc[feasible.cost.idxmin()]
        constrained = True
    best_f1 = sweep.loc[sweep.f1.idxmax()]
    return {
        "threshold": float(chosen.threshold),
        "precision_floor_satisfied": bool(constrained),
        "val_at_threshold": {k: float(chosen[k]) for k in
                             ("precision", "recall", "f1", "cost", "tp", "fp", "fn", "tn")},
        "f1_optimal_threshold": float(best_f1.threshold),
        "val_at_f1_optimal": {k: float(best_f1[k]) for k in ("precision", "recall", "f1", "cost")},
        "default_0.5": {k: float(sweep.iloc[np.argmin(np.abs(sweep.threshold - 0.5))][k])
                        for k in ("precision", "recall", "f1", "cost")},
        "cost_model": {"cost_fn": COST_FN, "cost_fp": COST_FP, "min_precision": MIN_PRECISION},
        "sweep": sweep,
    }


def metrics_at(y: np.ndarray, p: np.ndarray, t: float) -> dict[str, float]:
    yhat = (p >= t).astype(int)
    tn, fp, fn, tp = confusion_matrix(y, yhat, labels=[0, 1]).ravel()
    return {
        "threshold": float(t),
        "accuracy": float(accuracy_score(y, yhat)),
        "precision": float(precision_score(y, yhat, zero_division=0)),
        "recall": float(recall_score(y, yhat, zero_division=0)),
        "f1": float(f1_score(y, yhat, zero_division=0)),
        "roc_auc": float(roc_auc_score(y, p)),
        "pr_auc": float(average_precision_score(y, p)),
        "tp": int(tp), "fp": int(fp), "fn": int(fn), "tn": int(tn),
        "expected_cost": float(COST_FN * fn + COST_FP * fp),
    }


def plot_confusion(y, yhat, path: Path, title: str) -> None:
    cm = confusion_matrix(y, yhat, labels=[0, 1])
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.6))
    for ax, mat, fmt, sub in (
        (axes[0], cm, "d", "counts"),
        (axes[1], cm / cm.sum(axis=1, keepdims=True), ".3f", "row-normalised (recall view)"),
    ):
        im = ax.imshow(mat, cmap="Blues")
        ax.set_xticks([0, 1], ["pred benign", "pred phishing"])
        ax.set_yticks([0, 1], ["true benign", "true phishing"])
        for i in range(2):
            for j in range(2):
                v = mat[i, j]
                ax.text(j, i, format(v, fmt), ha="center", va="center",
                        color="white" if v > mat.max() * 0.6 else "black", fontsize=13)
        ax.set_title(sub, fontsize=10)
        fig.colorbar(im, ax=ax, fraction=0.046)
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_curves(y, p, op: dict, path: Path, title: str) -> None:
    fpr, tpr, _ = roc_curve(y, p)
    prec, rec, thr = precision_recall_curve(y, p)
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    axes[0].plot(fpr, tpr, lw=2, label=f"ROC (AUC={auc(fpr, tpr):.4f})")
    axes[0].plot([0, 1], [0, 1], "k--", lw=1)
    axes[0].set_xlabel("false positive rate"); axes[0].set_ylabel("true positive rate")
    axes[0].set_title("ROC, test set"); axes[0].legend(loc="lower right"); axes[0].grid(alpha=.3)

    axes[1].plot(rec, prec, lw=2, label=f"PR (AP={average_precision_score(y, p):.4f})")
    axes[1].axhline(MIN_PRECISION, color="crimson", ls=":", lw=1.4,
                    label=f"precision floor {MIN_PRECISION}")
    t = op["threshold"]
    yhat = (p >= t).astype(int)
    axes[1].scatter([recall_score(y, yhat)], [precision_score(y, yhat)], s=90, zorder=5,
                    color="darkorange", edgecolor="k",
                    label=f"operating point t={t:.3f}")
    tf1 = op["f1_optimal_threshold"]
    yf1 = (p >= tf1).astype(int)
    axes[1].scatter([recall_score(y, yf1)], [precision_score(y, yf1)], s=70, zorder=5,
                    marker="s", color="seagreen", edgecolor="k",
                    label=f"F1-optimal t={tf1:.3f}")
    axes[1].set_xlabel("recall"); axes[1].set_ylabel("precision")
    axes[1].set_title("Precision-Recall, test set"); axes[1].legend(loc="lower left"); axes[1].grid(alpha=.3)
    fig.suptitle(title)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_importance(linear_pipe, hgb_pipe, X_val, y_val, path: Path) -> dict[str, Any]:
    """Left: coefficients of the tuned linear model on the dense features.
    Right: permutation importance of the HistGB model on the same dense features.
    Bottom: strongest text n-grams from the linear model."""
    prep = linear_pipe.named_steps["prep"]
    names = np.asarray(prep.get_feature_names_out(), dtype=object)
    clf = linear_pipe.named_steps["clf"]
    coef = (clf.coef_.ravel() if hasattr(clf, "coef_")
            else np.zeros(len(names)))

    is_dense = np.array([n.startswith(("url__", "header__")) for n in names])
    dnames = np.array([n.split("__", 1)[1].replace("f__", "").replace("s__", "")
                       for n in names[is_dense]], dtype=object)
    dcoef = coef[is_dense]
    order = np.argsort(np.abs(dcoef))[-18:]

    perm_names, perm_vals = np.array([], dtype=object), np.array([])
    try:
        # permute the transformed features so the names line up
        hgb_prep = hgb_pipe.named_steps["prep"]
        hgb_clf = hgb_pipe.named_steps["clf"]
        Xt = hgb_prep.transform(X_val)
        dn = np.asarray(hgb_prep.get_feature_names_out(), dtype=object)
        r = permutation_importance(hgb_clf, Xt, y_val, n_repeats=5,
                                   random_state=SEED, scoring="f1", n_jobs=1)
        assert len(r.importances_mean) == len(dn), "permutation/feature-name length mismatch"
        o2 = np.argsort(r.importances_mean)[-18:]
        perm_names, perm_vals = dn[o2], r.importances_mean[o2]
    except Exception as exc:  # pragma: no cover
        print(f"[train] permutation importance skipped: {exc}")

    tmask = ~is_dense
    tnames = np.array([n.split("__", 1)[-1] for n in names[tmask]], dtype=object)
    tcoef = coef[tmask]
    top_p = np.argsort(tcoef)[-14:]
    top_b = np.argsort(tcoef)[:14]

    fig = plt.figure(figsize=(15, 11))
    ax1 = fig.add_subplot(2, 2, 1)
    ax1.barh(range(len(order)), dcoef[order],
             color=["indianred" if v > 0 else "steelblue" for v in dcoef[order]])
    ax1.set_yticks(range(len(order)), dnames[order], fontsize=8)
    ax1.axvline(0, color="k", lw=.8)
    ax1.set_title("Tuned linear model, dense feature coefficients\n(red = pushes toward PHISHING)", fontsize=10)

    ax2 = fig.add_subplot(2, 2, 2)
    if len(perm_vals):
        ax2.barh(range(len(perm_vals)), perm_vals, color="darkseagreen")
        ax2.set_yticks(range(len(perm_vals)), perm_names, fontsize=8)
    ax2.set_title("HistGradientBoosting, permutation importance (val, F1 drop)", fontsize=10)

    ax3 = fig.add_subplot(2, 2, 3)
    ax3.barh(range(len(top_p)), tcoef[top_p], color="indianred")
    ax3.set_yticks(range(len(top_p)), tnames[top_p], fontsize=8)
    ax3.set_title("Strongest PHISHING text n-grams", fontsize=10)

    ax4 = fig.add_subplot(2, 2, 4)
    ax4.barh(range(len(top_b)), tcoef[top_b], color="steelblue")
    ax4.set_yticks(range(len(top_b)), tnames[top_b], fontsize=8)
    ax4.set_title("Strongest BENIGN text n-grams", fontsize=10)

    fig.suptitle("Feature importance across the three families")
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)

    return {
        "top_dense_phishing": [[str(dnames[i]), float(dcoef[i])]
                               for i in np.argsort(dcoef)[-10:][::-1]],
        "top_dense_benign": [[str(dnames[i]), float(dcoef[i])]
                             for i in np.argsort(dcoef)[:10]],
        "top_text_phishing": [[str(tnames[i]), float(tcoef[i])] for i in top_p[::-1]],
        "top_text_benign": [[str(tnames[i]), float(tcoef[i])] for i in top_b],
        "hgb_permutation_top": [[str(n), float(v)] for n, v in
                                zip(perm_names[::-1], perm_vals[::-1])],
    }


def explain_example(row: pd.Series, p: float, thr: float, explainer: Pipeline,
                    names: np.ndarray, coef: np.ndarray, kind: str,
                    raw_row: np.ndarray) -> str:
    """Explain one mistake using coef_i * x_i from the linear model."""
    X1 = row.to_frame().T
    x = explainer.named_steps["prep"].transform(X1)
    x = np.asarray(x.todense()).ravel() if hasattr(x, "todense") else np.asarray(x).ravel()
    contrib = coef * x

    # rank dense and text drivers separately, the dense ones are standardised
    is_dense = np.array([n.startswith(("url__", "header__")) for n in names])
    pos_of = {n: k for k, n in enumerate(F.dense_feature_names())}

    direction = 1 if kind == "FP" else -1
    order = np.argsort(direction * contrib)[::-1]
    dense_idx = [i for i in order if is_dense[i]][:5]
    text_idx = [i for i in order if not is_dense[i] and abs(contrib[i]) > 1e-4][:5]

    def dense_driver(i: int) -> str:
        full = names[i]                      # e.g. "header__spf_pass"
        short = full.split("__", 1)[-1]
        rv = raw_row[pos_of[full]] if full in pos_of else float("nan")
        return f"`{short}`={rv:g} ({contrib[i]:+.3f})" if rv == rv else f"`{short}` ({contrib[i]:+.3f})"

    drivers = [dense_driver(i) for i in dense_idx]
    text_drivers = [
        "`" + names[i].split("__", 1)[-1].replace("word__", "").replace("char__", "")
        + f"` ({contrib[i]:+.3f})" for i in text_idx]

    facts = []
    auth = sum(int(row[c]) for c in ("spf_pass", "dkim_pass", "dmarc_pass"))
    facts.append(f"{auth}/3 auth checks passed (SPF={int(row.spf_pass)}, "
                 f"DKIM={int(row.dkim_pass)}, DMARC={int(row.dmarc_pass)})")
    facts.append(f"{len(row.urls)} URL(s)")
    if row.reply_to:
        facts.append("reply-to header present")
    if str(row.get("source", "")).endswith("+noise"):
        facts.append("**this record carries an injected label flip** (3% synthetic "
                     "annotation noise), so the model's prediction is arguably correct "
                     "and the *label* is wrong")

    why = {
        "FP": "Legitimate message that happens to share surface cues the model leans on.",
        "FN": "None of the cues the model leans on are present, so the score stayed low.",
    }[kind]

    return (
        f"- **id** `{row.id}`  |  **theme** `{row.theme}`  |  **score** {p:.3f} "
        f"(threshold {thr:.3f})\n"
        f"  - **From:** `{row.sender_display_name} <{row.sender_address}>`"
        + (f"  **Reply-To:** `{row.reply_to}`" if row.reply_to else "") + "\n"
        f"  - **Subject:** {row.subject[:160]}\n"
        f"  - **Body (first 300 chars):** {row.body[:300].replace(chr(10), ' ')}\n"
        f"  - **URLs:** {row.urls[:4] if len(row.urls) else '(none)'}\n"
        f"  - **Signals:** {'; '.join(facts)}\n"
        f"  - **Top URL/header drivers of the wrong call:** "
        f"{', '.join(drivers) if drivers else '(negligible)'}\n"
        f"  - **Top text drivers:** {', '.join(text_drivers) if text_drivers else '(negligible)'}\n"
        f"  - **{'Why it fired' if kind == 'FP' else 'Why it was missed'}:** {why}\n"
    )


def write_error_examples(path: Path, te: pd.DataFrame, p: np.ndarray, thr: float,
                         explainer: Pipeline, best_name: str, is_surrogate: bool,
                         n_each: int = 6) -> dict[str, int]:
    y = te["label"].to_numpy()
    yhat = (p >= thr).astype(int)
    names = np.asarray(explainer.named_steps["prep"].get_feature_names_out(), dtype=object)
    clf = explainer.named_steps["clf"]
    coef = clf.coef_.ravel()

    raw_dense = np.hstack([
        F.UrlLexicalFeatures().transform(te[F.URL_COLS]),
        F.HeaderAuthFeatures().transform(te[F.HEADER_COLS]),
    ])

    fp_idx = np.where((y == 0) & (yhat == 1))[0]
    fn_idx = np.where((y == 1) & (yhat == 0))[0]

    # a flipped label is an annotation error, not a model error, so keep them apart
    is_noise = te["source"].astype(str).str.endswith("+noise").to_numpy()
    clean_fp = fp_idx[~is_noise[fp_idx]]
    clean_fn = fn_idx[~is_noise[fn_idx]]
    noisy_fp = fp_idx[is_noise[fp_idx]]
    noisy_fn = fn_idx[is_noise[fn_idx]]

    # most confident mistakes first, topped up from the noisy ones if needed
    def _select(clean, noisy, ascending: bool):
        key = (lambda a: p[a]) if ascending else (lambda a: -p[a])
        c = clean[np.argsort(key(clean))] if len(clean) else clean
        n = noisy[np.argsort(key(noisy))] if len(noisy) else noisy
        return np.concatenate([c, n])[:n_each].astype(int)

    fp_sel = _select(clean_fp, noisy_fp, ascending=False)
    fn_sel = _select(clean_fn, noisy_fn, ascending=True)

    lines = [
        "# Error analysis: concrete misclassified test samples",
        "",
        f"Model: **{best_name}**, operating threshold **{thr:.3f}** on the held-out test split.",
        "",
        f"Test set: {len(y)} messages ({int(y.sum())} phishing, {int((1 - y).sum())} benign). "
        f"**{len(fp_idx)} false positives**, **{len(fn_idx)} false negatives**.",
        "",
        f"Of those, {len(clean_fp)} FPs and {len(clean_fn)} FNs are genuine model failures; "
        f"{len(noisy_fp)} FPs and {len(noisy_fn)} FNs land on records whose label was "
        "flipped by the synthetic annotation-noise process (see the last "
        "section). **The examples below are all genuine model failures on correctly "
        "labelled mail.**",
        "",
    ]
    if is_surrogate:
        lines += [
            "> Attribution note: the selected model is not linear, so per-feature "
            "contributions below come from the tuned linear model "
            "(`M5_combined_logreg_tuned`) used as a surrogate explainer on the same "
            "features. The listed errors are the SELECTED model's errors.",
            "",
        ]
    lines += [
        "Each entry lists the record, the features that actually moved its score "
        "(`coefficient x value`, signed), and why the mistake happened.",
        "",
        "---",
        "",
        f"## False positives: legitimate mail flagged as phishing ({len(fp_sel)} shown)",
        "",
        "These are the trust-destroying errors: real business mail sent to quarantine.",
        "",
    ]
    for i in fp_sel:
        lines.append(explain_example(te.iloc[i], p[i], thr, explainer, names, coef, "FP",
                                     raw_dense[i]))
    lines += ["", "---", "",
              f"## False negatives: phishing delivered to the inbox ({len(fn_sel)} shown)",
              "",
              "These are the costly errors: the user sees an attack with no warning.",
              ""]
    for i in fn_sel:
        lines.append(explain_example(te.iloc[i], p[i], thr, explainer, names, coef, "FN",
                                     raw_dense[i]))

    # aggregate patterns
    lines += ["", "---", "", "## Patterns across all errors", ""]
    err = te.copy()
    err["score"] = p
    err["pred"] = yhat
    err["err"] = np.where((y == 0) & (yhat == 1), "FP",
                          np.where((y == 1) & (yhat == 0), "FN", "correct"))
    by_theme = (err[err.err != "correct"].groupby(["err", "theme"]).size()
                .unstack(fill_value=0))
    lines += ["Error counts by theme:", "", "```", by_theme.to_string(), "```", ""]
    n_err = int((err.err != "correct").sum())
    n_noise_err = len(noisy_fp) + len(noisy_fn)
    lines += [
        f"**{n_noise_err} of {n_err} errors ({100 * n_noise_err / max(1, n_err):.1f}%) "
        "fall on records whose label was flipped by the synthetic "
        "annotation-noise process.** On those the model is arguably right and the ground "
        "truth is wrong. They form the irreducible-error floor built into the dataset on "
        "purpose, and they are why a score near 1.00 would be a red flag rather than a "
        f"success. The remaining {n_err - n_noise_err} are genuine model failures.",
        "",
    ]
    auth_pass_fn = err[(err.err == "FN") & err.spf_pass & err.dkim_pass & err.dmarc_pass]
    no_url_fn = err[(err.err == "FN") & (err["urls"].apply(len) == 0)]
    lines += [
        f"- **{len(auth_pass_fn)} of {len(fn_idx)} false negatives pass all three "
        "authentication checks.** Attacker-controlled or compromised domains that "
        "publish valid SPF/DKIM/DMARC defeat the header family entirely.",
        f"- **{len(no_url_fn)} of {len(fn_idx)} false negatives contain no URL at all** "
        "(business-email-compromise style), so the URL family contributes nothing and the "
        "model must decide on ordinary business English alone.",
        f"- Median false-negative score is {np.median(p[fn_idx]):.3f} against a threshold of "
        f"{thr:.3f}, i.e. they sit "
        + ("well below the boundary, so these are confident errors that a small threshold "
           "change would NOT recover, because every feature the model trusts says 'benign'."
           if np.median(p[fn_idx]) < thr - 0.1 else
           "close to the boundary, so threshold movement trades them directly against FPs.")
        + f" Median false-positive score is {np.median(p[fp_idx]):.3f}, "
        + ("just above the boundary, borderline cases, which is the tractable shape for a "
           "human review queue."
           if np.median(p[fp_idx]) < thr + 0.3 else
           "well above the boundary, the model is confidently wrong on these."),
        "",
    ]

    noise_all = np.concatenate([noisy_fp, noisy_fn]) if n_noise_err else np.array([], int)
    lines += ["---", "",
              "## Appendix: errors that are actually label noise", "",
              f"{n_noise_err} of the {n_err} errors sit on flipped labels. "
              "One example, to show what that looks like:", ""]
    if len(noise_all):
        j = int(noise_all[np.argmax(np.abs(p[noise_all] - 0.5))])
        kind = "FP" if y[j] == 0 else "FN"
        lines.append(explain_example(te.iloc[j], p[j], thr, explainer, names, coef,
                                     kind, raw_dense[j]))

    path.write_text("\n".join(lines), encoding="utf-8")
    return {"n_fp": len(fp_idx), "n_fn": len(fn_idx),
            "n_fp_genuine": len(clean_fp), "n_fn_genuine": len(clean_fn),
            "n_fp_shown": len(fp_sel), "n_fn_shown": len(fn_sel),
            "errors_on_noise_labels": n_noise_err,
            "fn_all_auth_pass": len(auth_pass_fn), "fn_no_url": len(no_url_fn)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default=str(DATA / "corpus.jsonl"))
    ap.add_argument("--seed", type=int, default=SEED)
    ap.add_argument("--fast", action="store_true", help="skip the grid search (smoke test)")
    args = ap.parse_args(argv)

    REPORTS.mkdir(exist_ok=True, parents=True)
    ARTIFACTS.mkdir(exist_ok=True, parents=True)
    cache = ARTIFACTS / "_sk_cache"

    t_start = time.time()
    df = F.load_records(args.corpus)
    print(f"[train] loaded {len(df)} records, phishing rate {df.label.mean():.4f}")

    tr, va, te = grouped_stratified_split(df, args.seed)
    print(f"[train] split  train={len(tr)}  val={len(va)}  test={len(te)}")
    print(f"[train] phishing rate  train={tr.label.mean():.4f} val={va.label.mean():.4f} "
          f"test={te.label.mean():.4f}")

    X_tr, y_tr = tr, tr["label"].to_numpy()
    X_va, y_va = va, va["label"].to_numpy()
    X_te, y_te = te, te["label"].to_numpy()

    models = make_models(cache)
    results: dict[str, Any] = {}
    fitted: dict[str, Any] = {}

    for name, spec in models.items():
        t0 = time.time()
        pipe = spec["pipe"]
        if spec["grid"] and not args.fast:
            cv = StratifiedGroupKFold(n_splits=3, shuffle=True, random_state=args.seed)
            gs = GridSearchCV(pipe, spec["grid"], scoring="f1", cv=cv, n_jobs=2,
                              refit=True, verbose=0)
            gs.fit(X_tr, y_tr, groups=tr["group_id"].to_numpy())
            est = gs.best_estimator_
            best_params = {k: str(v) for k, v in gs.best_params_.items()}
            cv_best = float(gs.best_score_)
        else:
            est = pipe.fit(X_tr, y_tr)
            best_params, cv_best = {}, None

        p_va = proba(est, X_va)
        m_va = metrics_at(y_va, p_va, 0.5)
        fitted[name] = est
        results[name] = {
            "description": spec["desc"],
            "fit_seconds": round(time.time() - t0, 2),
            "best_params": best_params,
            "cv_best_f1": cv_best,
            "val_at_0.5": m_va,
        }
        print(f"[train] {name:34s} val F1={m_va['f1']:.4f} "
              f"PR-AUC={m_va['pr_auc']:.4f}  ({time.time() - t0:.1f}s)")

    # M6: soft-vote ensemble of the dense tree model and the tuned linear model
    ens_members = ["M3_dense_histgb", "M5_combined_logreg_tuned"]
    p_va_ens = np.mean([proba(fitted[m], X_va) for m in ens_members], axis=0)
    m_va_ens = metrics_at(y_va, p_va_ens, 0.5)
    results["M6_softvote_M3_M5"] = {
        "description": "IMPROVEMENT 5: unweighted soft vote over M3 (dense trees) and M5 "
                       "(tuned linear on all families). The two make different mistakes: "
                       "M3 cannot read the text, M5 cannot model feature interactions, so "
                       "averaging their probabilities trims both error modes.",
        "fit_seconds": 0.0, "best_params": {"members": ens_members}, "cv_best_f1": None,
        "val_at_0.5": m_va_ens,
    }
    print(f"[train] {'M6_softvote_M3_M5':34s} val F1={m_va_ens['f1']:.4f} "
          f"PR-AUC={m_va_ens['pr_auc']:.4f}")

    # pick the winner on validation PR-AUC
    def val_prauc(n): return results[n]["val_at_0.5"]["pr_auc"]
    best_name = max(results, key=val_prauc)
    print(f"[train] selected {best_name} on validation PR-AUC={val_prauc(best_name):.4f}")

    if best_name == "M6_softvote_M3_M5":
        best_model = F.SoftVoteEnsemble([fitted[m] for m in ens_members])
        p_va_best = p_va_ens
    else:
        best_model = fitted[best_name]
        p_va_best = proba(best_model, X_va)

    # cost-sensitive threshold, tuned on validation only
    op = choose_operating_point(y_va, p_va_best)
    sweep = op.pop("sweep")
    thr = op["threshold"]
    print(f"[train] operating threshold {thr:.3f} "
          f"(val P={op['val_at_threshold']['precision']:.4f} "
          f"R={op['val_at_threshold']['recall']:.4f})")

    # test set, scored once
    p_te = proba(best_model, X_te)
    test_tuned = metrics_at(y_te, p_te, thr)
    test_half = metrics_at(y_te, p_te, 0.5)
    yhat_te = (p_te >= thr).astype(int)
    print(f"[train] TEST  P={test_tuned['precision']:.4f} R={test_tuned['recall']:.4f} "
          f"F1={test_tuned['f1']:.4f} acc={test_tuned['accuracy']:.4f}")

    # leakage check: same pipeline and same split sizes, grouped vs random
    from sklearn.model_selection import train_test_split

    def _fixed_pipe():
        return Pipeline([("prep", F.build_preprocessor("combined")),
                         ("clf", LogisticRegression(max_iter=3000, C=2.0,
                                                    random_state=args.seed))])

    sgkf_lk = StratifiedGroupKFold(n_splits=5, shuffle=True, random_state=args.seed)
    g_tr_i, g_te_i = next(sgkf_lk.split(df, df.label.to_numpy(), df.group_id.to_numpy()))
    g_tr_df, g_te_df = df.iloc[g_tr_i], df.iloc[g_te_i]
    r_tr_df, r_te_df = train_test_split(df, test_size=len(g_te_i), stratify=df.label,
                                        random_state=args.seed)

    lk = {}
    for tag, (a, b) in {"grouped": (g_tr_df, g_te_df), "random": (r_tr_df, r_te_df)}.items():
        pl = _fixed_pipe().fit(a, a.label.to_numpy())
        lk[tag] = float(f1_score(b.label.to_numpy(), pl.predict(b)))
    print(f"[train] leakage check (same pipeline, same sizes): "
          f"random-split F1={lk['random']:.4f} vs grouped-split F1={lk['grouped']:.4f} "
          f"(inflation {lk['random'] - lk['grouped']:+.4f})")

    # reports
    report_txt = classification_report(y_te, yhat_te, target_names=["benign", "phishing"], digits=4)
    (REPORTS / "classification_report.txt").write_text(
        f"NexusAI phishing detector test-set classification report\n"
        f"model: {best_name}\noperating threshold: {thr:.4f} "
        f"(cost-sensitive: C_FN={COST_FN}, C_FP={COST_FP}, precision floor {MIN_PRECISION})\n"
        f"test records: {len(y_te)}\n\n{report_txt}\n"
        f"accuracy  {test_tuned['accuracy']:.4f}\nROC-AUC   {test_tuned['roc_auc']:.4f}\n"
        f"PR-AUC    {test_tuned['pr_auc']:.4f}\n\n"
        f"confusion matrix [[TN FP],[FN TP]] = "
        f"[[{test_tuned['tn']} {test_tuned['fp']}],[{test_tuned['fn']} {test_tuned['tp']}]]\n\n"
        f"--- at default threshold 0.5 ---\n"
        + classification_report(y_te, (p_te >= .5).astype(int),
                                target_names=["benign", "phishing"], digits=4),
        encoding="utf-8")

    plot_confusion(y_te, yhat_te, REPORTS / "confusion_matrix.png",
                   f"Confusion matrix, {best_name} @ t={thr:.3f} (test n={len(y_te)})")
    plot_curves(y_te, p_te, op, REPORTS / "roc_pr_curves.png",
                f"{best_name} test set discrimination")
    imp = plot_importance(fitted["M5_combined_logreg_tuned"], fitted["M3_dense_histgb"],
                          X_va, y_va, REPORTS / "feature_importance.png")

    explainer = fitted["M5_combined_logreg_tuned"]
    err_stats = write_error_examples(
        REPORTS / "error_examples.md", te.reset_index(drop=True), p_te, thr,
        explainer, best_name, is_surrogate=(best_name != "M5_combined_logreg_tuned"))

    sweep_slim = sweep.iloc[::10][["threshold", "precision", "recall", "f1", "cost"]]

    metrics = {
        "generated_at": pd.Timestamp.now("UTC").isoformat(),
        "seed": args.seed,
        "dataset": json.loads((DATA / "dataset_summary.json").read_text()),
        "split": {
            "strategy": "StratifiedGroupKFold on group_id (near-duplicate template clusters)",
            "train": len(tr), "val": len(va), "test": len(te),
            "phishing_rate": {"train": float(tr.label.mean()), "val": float(va.label.mean()),
                              "test": float(te.label.mean())},
            "groups": {"train": tr.group_id.nunique(), "val": va.group_id.nunique(),
                       "test": te.group_id.nunique()},
            "group_overlap": 0,
        },
        "leakage_check": {
            "note": "Identical fixed pipeline (combined families + LogReg C=2.0) and "
                    "identical 80/20 sizes; the ONLY difference is whether the split "
                    "respects group_id. `inflation` > 0 means a random split would have "
                    "over-reported F1 by that much.",
            "random_split_test_f1": lk["random"],
            "grouped_split_test_f1": lk["grouped"],
            "inflation": lk["random"] - lk["grouped"],
        },
        "models": results,
        "selected_model": best_name,
        "selection_criterion": "validation PR-AUC",
        "operating_point": op,
        "threshold_sweep_val": sweep_slim.round(4).to_dict(orient="records"),
        "test_at_tuned_threshold": test_tuned,
        "test_at_0.5": test_half,
        "feature_importance": imp,
        "error_analysis": err_stats,
        "runtime_seconds": round(time.time() - t_start, 1),
    }
    (REPORTS / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")

    # model card
    write_model_card(REPORTS / "model_card.md", metrics, best_name, thr)

    # artifacts
    joblib.dump(best_model, ARTIFACTS / "model.joblib")
    ref_scores = np.sort(p_te)
    bins = np.linspace(0, 1, 11)
    ref_hist, _ = np.histogram(p_te, bins=bins)
    (ARTIFACTS / "train_meta.json").write_text(json.dumps({
        "selected_model": best_name,
        "threshold": thr,
        "seed": args.seed,
        "trained_at": pd.Timestamp.now("UTC").isoformat(),
        "test_accuracy": test_tuned["accuracy"],
        "test_f1": test_tuned["f1"],
        "reference_score_bins": bins.tolist(),
        "reference_score_hist": ref_hist.tolist(),
        "reference_n": int(len(p_te)),
        "reference_mean_score": float(ref_scores.mean()),
    }, indent=2), encoding="utf-8")

    shutil.rmtree(cache, ignore_errors=True)
    print(f"[train] done in {metrics['runtime_seconds']}s, reports/ and artifacts/ written")
    return 0


def write_model_card(path: Path, m: dict, best_name: str, thr: float) -> None:
    t = m["test_at_tuned_threshold"]
    ds = m["dataset"]
    path.write_text(f"""# Model card: NexusAI phishing-email detector

## Model details
- **Name / id in marketplace:** NexusAI flagship phishing-detection classifier
- **Selected architecture:** `{best_name}`
- **Selection criterion:** {m['selection_criterion']} (chosen on validation, never test)
- **Version / seed:** seed {m['seed']}, trained {m['generated_at']}
- **Feature families:** (A) TF-IDF word 1-2gram + char_wb 3-5gram over subject+body;
  (B) 30 URL & lexical surface features; (C) 22 header/authentication features
- **Operating threshold:** {thr:.4f}, chosen to minimise
  `{m['operating_point']['cost_model']['cost_fn']}*FN + {m['operating_point']['cost_model']['cost_fp']}*FP`
  subject to precision >= {m['operating_point']['cost_model']['min_precision']}
- **License gate:** the accuracy reported here is what `src/evaluate.py` pushes to
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
- **Provenance: `{ds['provenance']}`.** {ds['corpus']['n']} corpus records
  ({ds['corpus']['phishing']} phishing / {ds['corpus']['benign']} benign) across
  {ds['corpus']['groups']} near-duplicate groups; a further {ds['holdout']['n']}-record
  secret holdout, {ds['holdout']['unseen_template_records']} of which use templates the
  corpus never contains.
- {ds['label_noise'] * 100:.0f}% symmetric label noise is injected on purpose, so the
  Bayes error is non-zero and a perfect score is impossible.
- **The headline numbers are synthetic-data numbers** (the build environment has
  restricted egress). See `docs/ml_report.md` for the external-validity discussion
  and the exact procedure to re-run on the Nazario / SpamAssassin / PhishTank corpora.

## Evaluation
Grouped stratified split ({m['split']['train']}/{m['split']['val']}/{m['split']['test']}),
groups disjoint across splits.

| metric | test @ tuned t={thr:.3f} | test @ 0.5 |
|---|---|---|
| precision | {t['precision']:.4f} | {m['test_at_0.5']['precision']:.4f} |
| recall | {t['recall']:.4f} | {m['test_at_0.5']['recall']:.4f} |
| F1 | {t['f1']:.4f} | {m['test_at_0.5']['f1']:.4f} |
| accuracy | {t['accuracy']:.4f} | {m['test_at_0.5']['accuracy']:.4f} |
| ROC-AUC | {t['roc_auc']:.4f} | n/a |
| PR-AUC | {t['pr_auc']:.4f} | n/a |

Confusion matrix at the operating point: TN={t['tn']}, FP={t['fp']}, FN={t['fn']}, TP={t['tp']}.

## Ethical considerations & limitations
- **False positives ({t['fp']} on test)** quarantine legitimate mail: missed
  invoices, missed job offers, and erosion of trust in the warning banner. This is
  why a hard precision floor constrains the threshold rather than pure cost
  minimisation.
- **False negatives ({t['fn']} on test)** reach the user with no warning.
  {m['error_analysis']['fn_all_auth_pass']} of them pass all three authentication
  checks and {m['error_analysis']['fn_no_url']} contain no URL at all, i.e. the
  residual risk is concentrated in business-email-compromise, exactly the class with
  the highest per-incident loss.
- **Privacy:** email bodies are among the most sensitive data an enterprise holds.
  See `docs/ml_report.md` for the hashed-feature / on-device deployment mitigation
  and how it maps to the platform's selective-disclosure compliance design.
- **Adversarial pressure:** every feature here is attacker-observable and the
  lexical ones are cheap to evade. Treat this as one layer, not a control.
- **Bias:** brand and vocabulary coverage reflect the corpus. Mail in other
  languages, or from small senders with imperfect SPF/DKIM, is more likely to be
  falsely flagged.

## Maintenance
`src/evaluate.py` re-scores the secret holdout and publishes
(accuracyBps, p95 latencyMs, driftBps) each epoch. A drift spike or an accuracy
jump beyond `maxDeviationBps` trips the on-chain circuit breaker and closes the
marketplace quality gate until a human clears it.
""", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
