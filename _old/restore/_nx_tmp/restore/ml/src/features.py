"""Three feature families for phishing detection: text TF-IDF, URL/lexical, header/auth."""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Iterable

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.compose import ColumnTransformer
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.pipeline import FeatureUnion, Pipeline
from sklearn.preprocessing import StandardScaler

# fixed vocabularies, not learned from the corpus

BRAND_TOKENS = [
    "paypal", "microsoft", "apple", "amazon", "chase", "netflix", "docusign",
    "dropbox", "linkedin", "fedex", "adobe", "wellsfargo", "ups", "okta",
    "zoom", "slack", "google", "office365", "outlook", "icloud", "hsbc",
    "barclays", "citibank", "bankofamerica", "irs", "hmrc",
]
BRAND_OFFICIAL_DOMAIN = {
    "paypal": "paypal.com", "microsoft": "microsoft.com", "apple": "apple.com",
    "amazon": "amazon.com", "chase": "chase.com", "netflix": "netflix.com",
    "docusign": "docusign.com", "dropbox": "dropbox.com", "linkedin": "linkedin.com",
    "fedex": "fedex.com", "adobe": "adobe.com", "wellsfargo": "wellsfargo.com",
    "ups": "ups.com", "okta": "okta.com", "zoom": "zoom.us", "slack": "slack.com",
    "google": "google.com",
}
RISKY_TLDS = {"ru", "cn", "tk", "ml", "ga", "cf", "gq", "xyz", "top", "buzz",
              "click", "zip", "su", "icu", "work", "fit", "loan", "men", "date"}
SHORTENER_HOSTS = {"bit.ly", "tinyurl.com", "t.co", "is.gd", "ow.ly", "buff.ly",
                   "rebrand.ly", "cutt.ly", "goo.gl", "shorturl.at", "tiny.cc"}
FREEMAIL_DOMAINS = {"gmail.com", "outlook.com", "yahoo.com", "icloud.com",
                    "proton.me", "protonmail.com", "hotmail.com", "aol.com",
                    "gmx.com", "mail.com", "yandex.ru"}
ROLE_LOCALPARTS = {"no-reply", "noreply", "support", "service", "admin", "alerts",
                   "billing", "notifications", "security", "info", "help", "postmaster"}
URGENCY_TERMS = [
    "urgent", "immediate", "immediately", "action required", "verify", "suspend",
    "suspended", "expire", "expires", "expiring", "final notice", "within 24 hours",
    "confirm", "failure to", "act now", "do not ignore", "time sensitive",
    "last warning", "unauthorised", "unauthorized", "locked", "restricted",
]
CREDENTIAL_TERMS = ["password", "credential", "login", "sign in", "sign-in",
                    "account", "verify your", "security code", "one-time", "mfa"]
MONEY_TERMS = ["invoice", "payment", "wire", "transfer", "remittance", "bank",
               "refund", "gift card", "purchase order", "iban", "swift"]

_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_IPV4_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def shannon_entropy(s: str) -> float:
    """Character-level Shannon entropy of a string."""
    if not s:
        return 0.0
    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def levenshtein(a: str, b: str, cutoff: int = 4) -> int:
    """Levenshtein distance, capped at `cutoff`."""
    if a == b:
        return 0
    if abs(len(a) - len(b)) > cutoff:
        return cutoff
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        best = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            cur.append(v)
            best = min(best, v)
        if best >= cutoff:
            return cutoff
        prev = cur
    return min(prev[-1], cutoff)


def split_host(url: str) -> str:
    u = re.sub(r"^https?://", "", url, flags=re.I)
    u = u.split("/")[0].split("?")[0]
    if "@" in u:                      # userinfo@host obfuscation
        u = u.split("@")[-1]
    return u.split(":")[0].lower()


def registrable(host: str) -> str:
    """Rough eTLD+1: the last two labels of the host."""
    parts = [p for p in host.split(".") if p]
    if len(parts) <= 2:
        return ".".join(parts)
    return ".".join(parts[-2:])


@lru_cache(maxsize=200_000)
def _label_brand_match(label: str) -> tuple[int, str]:
    """Returns (min edit distance to a brand token, exact brand match or "")."""
    best = 9
    exact = ""
    for brand in BRAND_TOKENS:
        d = levenshtein(label, brand, cutoff=4)
        if d == 0:
            return 0, brand
        if d <= 2 and abs(len(label) - len(brand)) <= 2:
            best = min(best, d)
    return best, exact


@lru_cache(maxsize=200_000)
def brand_lookalike_distance(host: str) -> tuple[int, int]:
    """Returns (min edit distance to a brand token over the host labels, brand-present flag)."""
    if not host:
        return 9, 0
    reg = registrable(host)
    best = 9
    brand_present = 0
    for label in (l for l in re.split(r"[.\-_]", host) if len(l) >= 3):
        d, exact = _label_brand_match(label)
        if exact:
            brand_present = 1
            official = BRAND_OFFICIAL_DOMAIN.get(exact)
            # brand label on the wrong domain -> spoof
            if official and reg != official:
                best = 0
        elif d <= 2:
            best = min(best, d)
    return best, brand_present


def domain_of(addr: str) -> str:
    if not addr or "@" not in addr:
        return ""
    return addr.rsplit("@", 1)[-1].strip().lower()


# family B: URL and lexical surface features

URL_FEATURE_NAMES = [
    "n_urls", "n_urls_in_text", "url_max_len", "url_mean_len", "url_max_entropy",
    "url_mean_entropy", "url_max_digit_ratio", "url_max_subdomain_depth",
    "url_max_path_depth", "url_max_hyphens", "url_max_query_len",
    "any_risky_tld", "n_risky_tld", "any_punycode", "any_shortener",
    "any_ip_literal", "any_at_symbol", "any_explicit_port", "https_ratio",
    "brand_lookalike_min_dist", "any_brand_lookalike", "any_brand_in_host",
    "urgency_count", "credential_count", "money_count",
    "subject_len", "body_len", "caps_ratio", "exclaim_count", "digit_ratio_text",
]


class UrlLexicalFeatures(BaseEstimator, TransformerMixin):
    """Family B. Nothing is fitted. Expects the urls, subject and body columns."""

    def fit(self, X, y=None):
        self.n_features_in_ = 3
        return self

    def transform(self, X) -> np.ndarray:
        X = pd.DataFrame(X)
        rows = np.zeros((len(X), len(URL_FEATURE_NAMES)), dtype=np.float64)
        subjects = X["subject"].fillna("").astype(str).tolist()
        bodies = X["body"].fillna("").astype(str).tolist()
        url_lists = X["urls"].tolist()

        for i, (subj, body, urls) in enumerate(zip(subjects, bodies, url_lists)):
            if not isinstance(urls, (list, tuple)):
                urls = [] if urls is None or (isinstance(urls, float) and np.isnan(urls)) else list(urls)
            urls = [str(u) for u in urls]
            text = f"{subj}\n{body}"
            low = text.lower()

            lens, ents, digit_ratios, subdepths, pathdepths, hyphens, qlens = [], [], [], [], [], [], []
            n_risky = 0
            f_puny = f_short = f_ip = f_at = f_port = 0
            n_https = 0
            best_dist, brand_in_host = 9, 0

            for u in urls:
                host = split_host(u)
                tail = u[len(host):] if host and host in u else u
                lens.append(len(u))
                ents.append(shannon_entropy(host + tail))
                digits = sum(ch.isdigit() for ch in u)
                digit_ratios.append(digits / max(1, len(u)))
                labels = [l for l in host.split(".") if l]
                subdepths.append(max(0, len(labels) - 2))
                path = u.split("://")[-1]
                path = path.split("/", 1)[1] if "/" in path else ""
                pathdepths.append(path.split("?")[0].count("/") + (1 if path.split("?")[0] else 0))
                hyphens.append(host.count("-"))
                qlens.append(len(u.split("?", 1)[1]) if "?" in u else 0)

                tld = labels[-1] if labels else ""
                if tld in RISKY_TLDS:
                    n_risky += 1
                if host.startswith("xn--") or ".xn--" in host:
                    f_puny = 1
                if host in SHORTENER_HOSTS:
                    f_short = 1
                if _IPV4_RE.match(host):
                    f_ip = 1
                if "@" in u.split("://")[-1].split("/")[0]:
                    f_at = 1
                if re.search(r":\d{2,5}(/|$)", u.split("://")[-1]):
                    f_port = 1
                if u.lower().startswith("https://"):
                    n_https += 1
                d, bih = brand_lookalike_distance(host)
                best_dist = min(best_dist, d)
                brand_in_host = max(brand_in_host, bih)

            n = len(urls)
            caps = sum(ch.isupper() for ch in text)
            alpha = max(1, sum(ch.isalpha() for ch in text))

            rows[i] = [
                n,
                len(_URL_RE.findall(text)),
                max(lens) if lens else 0.0,
                float(np.mean(lens)) if lens else 0.0,
                max(ents) if ents else 0.0,
                float(np.mean(ents)) if ents else 0.0,
                max(digit_ratios) if digit_ratios else 0.0,
                max(subdepths) if subdepths else 0.0,
                max(pathdepths) if pathdepths else 0.0,
                max(hyphens) if hyphens else 0.0,
                max(qlens) if qlens else 0.0,
                1.0 if n_risky else 0.0,
                float(n_risky),
                float(f_puny), float(f_short), float(f_ip), float(f_at), float(f_port),
                (n_https / n) if n else 0.0,
                float(best_dist),
                1.0 if best_dist <= 2 else 0.0,
                float(brand_in_host),
                float(sum(low.count(t) for t in URGENCY_TERMS)),
                float(sum(low.count(t) for t in CREDENTIAL_TERMS)),
                float(sum(low.count(t) for t in MONEY_TERMS)),
                float(len(subj)),
                float(len(body)),
                caps / alpha,
                float(text.count("!")),
                sum(ch.isdigit() for ch in text) / max(1, len(text)),
            ]
        return rows

    def get_feature_names_out(self, input_features=None) -> np.ndarray:
        return np.asarray(URL_FEATURE_NAMES, dtype=object)


# family C: header and authentication features

HEADER_FEATURE_NAMES = [
    "spf_pass", "dkim_pass", "dmarc_pass", "auth_fail_count", "all_auth_pass",
    "has_attachment", "received_hops",
    "display_brand_mismatch", "display_is_person", "display_has_brand",
    "display_domain_token_mismatch",
    "reply_to_present", "reply_to_domain_mismatch", "reply_to_freemail",
    "sender_is_freemail", "sender_is_role_account", "sender_domain_len",
    "sender_domain_depth", "sender_domain_hyphens", "sender_domain_digits",
    "sender_domain_risky_tld", "sender_domain_brand_dist",
]


class HeaderAuthFeatures(BaseEstimator, TransformerMixin):
    """Family C. Nothing is fitted. Expects the sender, reply-to and auth columns."""

    def fit(self, X, y=None):
        self.n_features_in_ = 8
        return self

    def transform(self, X) -> np.ndarray:
        X = pd.DataFrame(X)
        n_rows = len(X)
        out = np.zeros((n_rows, len(HEADER_FEATURE_NAMES)), dtype=np.float64)

        disp = X["sender_display_name"].fillna("").astype(str).tolist()
        addr = X["sender_address"].fillna("").astype(str).tolist()
        rto = X["reply_to"].fillna("").astype(str).tolist()
        spf = X["spf_pass"].fillna(False).astype(bool).to_numpy()
        dkim = X["dkim_pass"].fillna(False).astype(bool).to_numpy()
        dmarc = X["dmarc_pass"].fillna(False).astype(bool).to_numpy()
        att = X["has_attachment"].fillna(False).astype(bool).to_numpy()
        hops = pd.to_numeric(X["received_hops"], errors="coerce").fillna(0).to_numpy()

        for i in range(n_rows):
            d, a, r = disp[i], addr[i], rto[i]
            sdom = domain_of(a)
            rdom = domain_of(r)
            dl = d.lower()
            sreg = registrable(sdom)

            # Does the display name claim a brand the envelope domain does not own?
            display_has_brand = 0
            display_brand_mismatch = 0
            for brand in BRAND_TOKENS:
                if brand in dl.replace(" ", ""):
                    display_has_brand = 1
                    official = BRAND_OFFICIAL_DOMAIN.get(brand)
                    if official and sreg != official:
                        display_brand_mismatch = 1
                    break

            # "Acme IT" over @unrelated.com, display token not in the domain
            tokens = [t for t in re.split(r"\W+", dl) if len(t) > 3]
            token_mismatch = 1 if tokens and not any(t in sdom for t in tokens) else 0

            words = d.split()
            display_is_person = 1 if (len(words) == 2 and all(w[:1].isupper() for w in words if w)) else 0

            local = a.split("@")[0].lower() if "@" in a else ""
            labels = [l for l in sdom.split(".") if l]
            tld = labels[-1] if labels else ""
            sdist, _ = brand_lookalike_distance(sdom)

            out[i] = [
                float(spf[i]), float(dkim[i]), float(dmarc[i]),
                float(3 - int(spf[i]) - int(dkim[i]) - int(dmarc[i])),
                float(spf[i] and dkim[i] and dmarc[i]),
                float(att[i]), float(hops[i]),
                float(display_brand_mismatch), float(display_is_person),
                float(display_has_brand), float(token_mismatch),
                1.0 if r else 0.0,
                1.0 if (rdom and sdom and rdom != sdom) else 0.0,
                1.0 if rdom in FREEMAIL_DOMAINS else 0.0,
                1.0 if sreg in FREEMAIL_DOMAINS else 0.0,
                1.0 if local in ROLE_LOCALPARTS else 0.0,
                float(len(sdom)), float(len(labels)),
                float(sdom.count("-")), float(sum(c.isdigit() for c in sdom)),
                1.0 if tld in RISKY_TLDS else 0.0,
                float(sdist),
            ]
        return out

    def get_feature_names_out(self, input_features=None) -> np.ndarray:
        return np.asarray(HEADER_FEATURE_NAMES, dtype=object)


# column groups and assembly

TEXT_COL = "text_all"
URL_COLS = ["urls", "subject", "body"]
HEADER_COLS = ["sender_display_name", "sender_address", "reply_to", "spf_pass",
               "dkim_pass", "dmarc_pass", "has_attachment", "received_hops"]


def build_text_union(word_max_features: int = 60000,
                     char_max_features: int = 80000,
                     word_ngram: tuple[int, int] = (1, 2),
                     char_ngram: tuple[int, int] = (3, 5),
                     min_df: int = 2,
                     use_char: bool = True) -> FeatureUnion:
    """Family A. Word n-grams plus char n-grams; use_char=False is the M1 baseline."""
    blocks = [
        ("word", TfidfVectorizer(
            analyzer="word", ngram_range=word_ngram, min_df=min_df,
            max_features=word_max_features, sublinear_tf=True,
            lowercase=True, strip_accents="unicode",
            token_pattern=r"(?u)\b\w[\w'\-]+\b")),
    ]
    if use_char:
        blocks.append(("char", TfidfVectorizer(
            analyzer="char_wb", ngram_range=char_ngram, min_df=min_df + 1,
            max_features=char_max_features, sublinear_tf=True,
            lowercase=True)))
    return FeatureUnion(blocks, n_jobs=None)


class SoftVoteEnsemble(BaseEstimator):
    """Unweighted soft vote over fitted pipelines. At module scope so joblib can pickle it."""

    def __init__(self, members: list | None = None):
        self.members = members or []

    def fit(self, X, y=None):
        return self

    def predict_proba(self, X) -> np.ndarray:
        p = np.mean([m.predict_proba(X)[:, 1] for m in self.members], axis=0)
        return np.column_stack([1.0 - p, p])

    def predict(self, X) -> np.ndarray:
        return (self.predict_proba(X)[:, 1] >= 0.5).astype(int)


def build_dense_union() -> ColumnTransformer:
    """FAMILIES B + C, dense, unscaled (for tree ensembles)."""
    return ColumnTransformer(
        [
            ("url", UrlLexicalFeatures(), URL_COLS),
            ("header", HeaderAuthFeatures(), HEADER_COLS),
        ],
        remainder="drop",
        verbose_feature_names_out=True,
    )


def build_preprocessor(kind: str = "combined", **text_kw) -> ColumnTransformer:
    """Assemble the feature families: "text" = A, "dense" = B + C, "combined" = all three."""
    if kind == "text":
        blocks = [("text", build_text_union(**text_kw), TEXT_COL)]
    elif kind == "dense":
        blocks = [
            ("url", Pipeline([("f", UrlLexicalFeatures()), ("s", StandardScaler())]), URL_COLS),
            ("header", Pipeline([("f", HeaderAuthFeatures()), ("s", StandardScaler())]), HEADER_COLS),
        ]
    elif kind == "combined":
        blocks = [
            ("text", build_text_union(**text_kw), TEXT_COL),
            ("url", Pipeline([("f", UrlLexicalFeatures()), ("s", StandardScaler())]), URL_COLS),
            ("header", Pipeline([("f", HeaderAuthFeatures()), ("s", StandardScaler())]), HEADER_COLS),
        ]
    else:
        raise ValueError(f"unknown kind: {kind!r}")
    return ColumnTransformer(blocks, remainder="drop", verbose_feature_names_out=True)


RAW_COLUMNS = ["id", "subject", "body", "sender_display_name", "sender_address",
               "reply_to", "urls", "has_attachment", "spf_pass", "dkim_pass",
               "dmarc_pass", "received_hops", "label", "group_id", "theme",
               "template_id", "source"]


def add_text_column(df: pd.DataFrame) -> pd.DataFrame:
    """Join subject and body for the text family, with the subject repeated once."""
    df = df.copy()
    subj = df["subject"].fillna("").astype(str)
    body = df["body"].fillna("").astype(str)
    df[TEXT_COL] = subj + "\n" + subj + "\n" + body
    return df


def load_records(path: str | Path) -> pd.DataFrame:
    """Load a JSONL corpus into a DataFrame with `text_all` attached."""
    rows = []
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    df = pd.DataFrame(rows)
    for col in RAW_COLUMNS:
        if col not in df.columns:
            df[col] = "" if col not in ("urls", "label", "received_hops") else (
                [[] for _ in range(len(df))] if col == "urls" else 0)
    df["urls"] = df["urls"].apply(lambda v: v if isinstance(v, list) else [])
    for c in ("spf_pass", "dkim_pass", "dmarc_pass", "has_attachment"):
        df[c] = df[c].fillna(False).astype(bool)
    df["received_hops"] = pd.to_numeric(df["received_hops"], errors="coerce").fillna(0).astype(int)
    df["label"] = pd.to_numeric(df["label"], errors="coerce").fillna(0).astype(int)
    return add_text_column(df)


def dense_feature_names() -> list[str]:
    return [f"url__{n}" for n in URL_FEATURE_NAMES] + [f"header__{n}" for n in HEADER_FEATURE_NAMES]
