#!/usr/bin/env python3
"""Builds the phishing corpus and the holdout set.

Parses a real corpus if --real-corpus points at one (Nazario / SpamAssassin /
PhishTank / UCI layout), otherwise synthesises a deterministic seeded corpus.
Writes corpus.jsonl, holdout.jsonl, holdout_manifest.json and dataset_summary.json.

Usage: python data/build_dataset.py [--real-corpus PATH] [--n-corpus N] [--seed S]
"""

from __future__ import annotations

import argparse
import email
import email.policy
import hashlib
import json
import mailbox
import os
import random
import re
import string
import sys
from pathlib import Path
from typing import Any, Iterable

HERE = Path(__file__).resolve().parent
DEFAULT_SEED = 6850  # AAI6850

BRANDS = {
    "PayPal": "paypal.com",
    "Microsoft": "microsoft.com",
    "Apple": "apple.com",
    "Amazon": "amazon.com",
    "Chase": "chase.com",
    "Netflix": "netflix.com",
    "DocuSign": "docusign.com",
    "Dropbox": "dropbox.com",
    "LinkedIn": "linkedin.com",
    "FedEx": "fedex.com",
    "Adobe": "adobe.com",
    "Wells Fargo": "wellsfargo.com",
    "UPS": "ups.com",
    "Okta": "okta.com",
    "Zoom": "zoom.us",
    "Slack": "slack.com",
}

# corporate and personal domains used by benign mail
CORP_DOMAINS = [
    "northeastern.edu", "acmelogistics.com", "brightpathhealth.org", "vertexcap.com",
    "hensley-associates.co.uk", "orionsoft.io", "kestrelbank.com", "maplewood.k12.ma.us",
    "quantumleap.ai", "fairview-clinic.org", "tuftsmedical.org", "bluewater-marine.com",
]
FREEMAIL = ["gmail.com", "outlook.com", "yahoo.com", "icloud.com", "proton.me", "hotmail.com"]

# hosts that show up in both classes, the main source of URL-feature overlap
DUAL_USE_HOSTS = [
    "docs.google.com", "drive.google.com", "sites.google.com", "forms.gle",
    "firebasestorage.googleapis.com", "storage.googleapis.com", "notion.site",
    "sharepoint.com", "onedrive.live.com", "s3.amazonaws.com", "web.app",
]
SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "cutt.ly"]
BENIGN_HOSTS = [
    "github.com", "stackoverflow.com", "zoom.us", "calendar.google.com", "atlassian.net",
    "workday.com", "servicenow.com", "confluence.internal", "jira.internal", "app.asana.com",
]
RISKY_TLDS = ["ru", "cn", "tk", "ml", "ga", "cf", "gq", "xyz", "top", "buzz", "click", "zip", "info", "su", "icu"]
NORMAL_TLDS = ["com", "org", "net", "io", "co", "edu", "gov", "us", "uk", "de", "ca"]

HOMOGLYPH = {"l": "1", "o": "0", "i": "1", "e": "3", "a": "@", "s": "5", "m": "rn", "g": "9", "c": "("}

FIRST_NAMES = ["Sarah", "Michael", "Priya", "Daniel", "Elena", "Marcus", "Aisha", "Tom", "Grace",
               "Hiroshi", "Laura", "Omar", "Nina", "Carlos", "Ruth", "Kevin", "Anika", "Peter"]
LAST_NAMES = ["Chen", "Okafor", "Whitfield", "Nakamura", "Delgado", "Brennan", "Kowalski", "Haddad",
              "Lindqvist", "Ferreira", "Osei", "Vargas", "McAllister", "Petrov", "Rahman"]
DEPARTMENTS = ["IT Service Desk", "Payroll", "Accounts Payable", "HR Operations", "Security Team",
               "Facilities", "Billing Support", "Benefits Administration"]

# both classes draw on every theme, with p_weight / b_weight setting how often

THEMES: list[dict[str, Any]] = [
    {
        "name": "password_reset", "p_weight": 16, "b_weight": 6,
        "subjects": [
            "Password expiration notice for {email}",
            "{brand} security alert: unusual sign-in",
            "Action required: reset your {brand} password",
            "Your {brand} password expires {date}",
            "Re: multi-factor authentication enrolment",
        ],
        "bodies": [
            "Hello {name},\n\nOur records show the password for your {brand} account has not been "
            "changed in 90 days and will expire on {date}. To keep access to mail and shared drives, "
            "please review your settings at {url}.\n\nIf you have already updated your password you "
            "can ignore this message.\n\n{signoff}\n{dept}",
            "Hi {name},\n\nWe detected a sign-in to your {brand} account from a device we do not "
            "recognise ({city}). If this was you, no action is needed. If it was not, secure the "
            "account here: {url}\n\nReference: {ticket}\n\n{signoff}\n{dept}",
            "{name},\n\nMulti-factor authentication is being rolled out across the organisation. "
            "Enrolment for your group closes {date}. The enrolment portal is {url} and takes about "
            "three minutes.\n\nQuestions go to the {dept}.\n\n{signoff}",
        ],
    },
    {
        "name": "invoice_payment", "p_weight": 15, "b_weight": 12,
        "subjects": [
            "Invoice {ticket} — {amount} due {date}",
            "Remittance advice for invoice {ticket}",
            "Overdue: invoice {ticket} ({amount})",
            "Payment confirmation — {amount}",
            "Updated banking details for remittance",
        ],
        "bodies": [
            "Dear {name},\n\nPlease find attached invoice {ticket} for {amount}, due {date}. "
            "Payment can be made through the portal at {url} or by bank transfer using the details "
            "on the invoice.\n\nThank you for your business.\n\n{signoff}\n{dept}",
            "Hi {name},\n\nInvoice {ticket} for {amount} is now {days} days past due. Could you "
            "confirm whether it has been scheduled for payment? The statement is available at "
            "{url}.\n\n{signoff}\n{dept}",
            "{name},\n\nOur finance team has migrated to a new banking provider. Please update the "
            "remittance details on file before releasing the next payment of {amount}. The updated "
            "details are in the document at {url}.\n\nApologies for the short notice.\n\n{signoff}",
        ],
    },
    {
        "name": "shared_document", "p_weight": 13, "b_weight": 14,
        "subjects": [
            "{sender_first} shared \"{docname}\" with you",
            "Document for review: {docname}",
            "{brand}: you have a new shared file",
            "Signature requested — {docname}",
        ],
        "bodies": [
            "{sender_first} shared a document with you.\n\n{docname}\n\nOpen it here: {url}\n\n"
            "This link is tied to your email address. If you were not expecting this document you "
            "can safely ignore the message.\n\n{signoff}",
            "Hi {name},\n\nI have put the {docname} in shared storage — link is {url}. Comments "
            "welcome before {date}, after that I will circulate it to the wider group.\n\n{signoff}",
            "You have been requested to review and sign {docname}.\n\nReview document: {url}\n\n"
            "Reference {ticket}. The request expires {date}.\n\n{signoff}\n{dept}",
        ],
    },
    {
        "name": "shipping", "p_weight": 11, "b_weight": 10,
        "subjects": [
            "{brand} delivery exception for package {ticket}",
            "Your parcel {ticket} is on its way",
            "Unable to deliver — reschedule required",
            "Shipment {ticket} out for delivery",
        ],
        "bodies": [
            "Package {ticket} could not be delivered on {date} because the address was incomplete. "
            "Reschedule delivery at {url}. Packages unclaimed after {days} days are returned to "
            "sender.\n\n{signoff}\n{brand}",
            "Hi {name},\n\nYour order has shipped and is expected {date}. Track it at {url}.\n\n"
            "Tracking number {ticket}.\n\n{signoff}\n{brand}",
            "A customs charge of {amount} is outstanding on shipment {ticket}. Settle the charge at "
            "{url} to release the parcel.\n\n{signoff}\n{brand}",
        ],
    },
    {
        "name": "account_billing", "p_weight": 12, "b_weight": 9,
        "subjects": [
            "{brand}: your subscription could not be renewed",
            "Receipt for your {brand} subscription — {amount}",
            "Your {brand} membership is on hold",
            "Billing update required for {brand}",
        ],
        "bodies": [
            "We were unable to process the payment method for your {brand} account on {date}. "
            "Your membership is on hold. Update the payment method at {url} to restore "
            "access.\n\nReference {ticket}.\n\n{signoff}\n{brand}",
            "Thanks for your payment of {amount}. Your {brand} plan renews on {date}. You can view "
            "the invoice or change your plan at any time at {url}.\n\nReference {ticket}.\n\n{signoff}",
        ],
    },
    {
        "name": "hr_payroll", "p_weight": 9, "b_weight": 11,
        "subjects": [
            "Payroll: {month} pay statement available",
            "Open enrolment closes {date}",
            "Update your direct deposit details",
            "Annual compliance training — due {date}",
        ],
        "bodies": [
            "Hi {name},\n\nYour {month} pay statement is available in the payroll portal: {url}. "
            "Statements remain available for 24 months.\n\n{signoff}\n{dept}",
            "{name},\n\nOpen enrolment for benefits closes {date}. If you make no changes your "
            "current elections roll over. Review your options at {url}.\n\n{signoff}\n{dept}",
            "All staff must complete the annual security-awareness module by {date}. Launch the "
            "course from {url}. Completion is tracked by the {dept}.\n\n{signoff}",
        ],
    },
    {
        "name": "it_notice", "p_weight": 8, "b_weight": 12,
        "subjects": [
            "Scheduled maintenance {date}",
            "Mailbox storage at {pct}% capacity",
            "VPN certificate renewal required",
            "New device enrolment policy",
        ],
        "bodies": [
            "Planned maintenance will take {brand} services offline between 22:00 and 02:00 on "
            "{date}. No action is required. Status updates are posted at {url}.\n\n{signoff}\n{dept}",
            "Your mailbox is at {pct}% of its quota. Once full you will stop receiving mail. "
            "Request additional storage at {url} or archive older items.\n\nReference {ticket}."
            "\n\n{signoff}\n{dept}",
            "The VPN client certificate on your workstation expires {date}. Renew it from {url} "
            "while connected to the corporate network.\n\n{signoff}\n{dept}",
        ],
    },
    {
        "name": "meeting_project", "p_weight": 4, "b_weight": 16,
        "subjects": [
            "Re: {docname} — notes from {date}",
            "Agenda for {date} sync",
            "Can we move {date}'s call?",
            "Follow-ups from the {docname} review",
        ],
        "bodies": [
            "Hi {name},\n\nNotes from the {date} session are in {url}. Main open item is still the "
            "{docname} scope — {sender_first} is going to draft something before we meet "
            "again.\n\nThanks,\n{signoff}",
            "{name},\n\nAgenda for {date}:\n  1. {docname} status\n  2. budget for next quarter\n"
            "  3. AOB\n\nDial-in is the usual link: {url}. Shout if you want anything added.\n\n{signoff}",
            "Sorry — something has come up and I need to move our {date} call. Does the same time "
            "later that week work? Calendar is at {url} if you want to grab a slot "
            "directly.\n\n{signoff}",
        ],
    },
    {
        "name": "legal_threat", "p_weight": 7, "b_weight": 3,
        "subjects": [
            "Notice of account suspension — {ticket}",
            "Final notice regarding your {brand} account",
            "Copyright complaint concerning your content",
            "Compliance review of your account",
        ],
        "bodies": [
            "This is a final notice regarding {brand} account {ticket}. Documentation requested on "
            "{date} has not been received. Failure to respond within {days} days will result in "
            "suspension. Submit documents at {url}.\n\n{signoff}\n{dept}",
            "We received a complaint relating to material associated with your account. Under our "
            "policy you have {days} days to respond. The complaint reference is {ticket} and the "
            "response form is at {url}.\n\n{signoff}\n{dept}",
        ],
    },
    {
        "name": "reward_offer", "p_weight": 5, "b_weight": 7,
        "subjects": [
            "You have {amount} in {brand} rewards expiring",
            "{month} customer survey — {amount} gift card",
            "Exclusive offer for {brand} members",
        ],
        "bodies": [
            "Your {brand} rewards balance of {amount} expires on {date}. Redeem it at {url}.\n\n"
            "{signoff}\n{brand}",
            "Hi {name},\n\nWe are running a short customer survey — it takes about four minutes and "
            "everyone who completes it gets a {amount} gift card. The survey is at {url} and closes "
            "{date}.\n\n{signoff}\n{dept}",
        ],
    },
    # BEC / wire fraud. Text is clean and urgent-but-plausible, usually NO url.
    {
        "name": "bec_request", "p_weight": 10, "b_weight": 4,
        "subjects": [
            "Quick request",
            "Are you at your desk?",
            "Confidential — need your help",
            "Vendor payment — please action today",
        ],
        "bodies": [
            "{name},\n\nAre you free for a moment? I am heading into back-to-back meetings and "
            "cannot take calls. I need a supplier payment of {amount} released today — it was "
            "approved last week but missed the run. Let me know if you can handle it and I will "
            "send the details.\n\nSent from my iPhone\n\n{signoff}",
            "Hi {name},\n\nCan you confirm what we have on file for the {docname} vendor? I want to "
            "check the remittance details before we release {amount} tomorrow. Keep this between us "
            "for now, the contract is not public yet.\n\n{signoff}",
            "{name} — please process the attached request for {amount} against cost centre {ticket} "
            "before end of day. I am travelling and signal is poor, email is best.\n\n{signoff}",
        ],
    },
]

FILLER = [
    "Please do not reply to this automated message.",
    "This message and any attachments are confidential.",
    "If you believe you received this in error, please let us know.",
    "For assistance contact the service desk during business hours.",
    "Your privacy matters to us; see our policy for details.",
    "Message ID {ticket} was generated automatically.",
    "You are receiving this because of your account preferences.",
    "Thank you for your continued custom.",
    "This notice is sent to all account holders.",
    "Standard turnaround is two business days.",
]
SIGNOFFS = ["Kind regards", "Best regards", "Thanks", "Regards", "Sincerely", "Many thanks", "Best"]
DOCNAMES = ["Q3 Budget Review", "Vendor Agreement", "Statement of Work", "Onboarding Checklist",
            "Incident Report", "Migration Plan", "Payroll Summary", "Service Contract",
            "Security Assessment", "Roadmap Draft", "NDA", "Purchase Order"]
CITIES = ["Lagos, NG", "Frankfurt, DE", "Ho Chi Minh City, VN", "Boston, US", "Sao Paulo, BR",
          "Warsaw, PL", "Chennai, IN", "Manchester, GB", "Toronto, CA"]
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


def _rand_path(rng: random.Random, depth: int = 2) -> str:
    words = ["secure", "login", "verify", "account", "update", "session", "auth", "portal",
             "docs", "view", "file", "track", "billing", "confirm", "id", "u", "r"]
    parts = [rng.choice(words) for _ in range(depth)]
    if rng.random() < 0.55:
        parts.append("".join(rng.choices(string.ascii_lowercase + string.digits, k=rng.randint(6, 22))))
    return "/".join(parts)


def _homoglyph(rng: random.Random, token: str) -> str:
    chars = list(token)
    idxs = [i for i, c in enumerate(chars) if c in HOMOGLYPH]
    if not idxs:
        return token
    for i in rng.sample(idxs, k=min(len(idxs), rng.randint(1, 2))):
        chars[i] = HOMOGLYPH[chars[i]]
    return "".join(chars)


def _brand_token(brand: str) -> str:
    return brand.lower().replace(" ", "")


def make_phishing_url(rng: random.Random, brand: str) -> str:
    """Build one attacker-controlled URL using a realistic evasion technique."""
    tok = _brand_token(brand)
    style = rng.choices(
        ["homoglyph", "hyphen", "subdomain", "punycode", "tld_swap", "shortener",
         "ip_literal", "dual_use", "random"],
        weights=[13, 18, 18, 6, 10, 12, 7, 10, 6], k=1,
    )[0]
    scheme = "https" if rng.random() < 0.72 else "http"

    if style == "homoglyph":
        host = f"{_homoglyph(rng, tok)}.{rng.choice(NORMAL_TLDS)}"
    elif style == "hyphen":
        pads = ["secure", "login", "verify", "account", "support", "service", "auth", "id"]
        left = "-".join(rng.sample(pads, k=rng.randint(1, 2)))
        host = f"{left}-{tok}.{rng.choice(NORMAL_TLDS + RISKY_TLDS)}"
    elif style == "subdomain":
        # paypal.com.secure-login.ru: the brand is only a subdomain label
        tail = rng.choice(["secure-login", "account-check", "verify-id", "session-renew", "cdn-static"])
        host = f"{tok}.com.{tail}.{rng.choice(RISKY_TLDS)}"
        if rng.random() < 0.4:
            host = f"login.{host}"
    elif style == "punycode":
        stripped = re.sub(r"[aeiou]", "", tok, count=1)
        host = f"xn--{stripped}-{''.join(rng.choices(string.ascii_lowercase + string.digits, k=4))}.{rng.choice(NORMAL_TLDS)}"
    elif style == "tld_swap":
        host = f"{tok}.{rng.choice(['com.co', 'security', 'support', 'help'])}.{rng.choice(RISKY_TLDS)}"
    elif style == "shortener":
        host = rng.choice(SHORTENERS)
        return f"https://{host}/{''.join(rng.choices(string.ascii_letters + string.digits, k=rng.randint(6, 9)))}"
    elif style == "ip_literal":
        host = ".".join(str(rng.randint(1, 254)) for _ in range(4))
        if rng.random() < 0.3:
            host += f":{rng.choice([8080, 8000, 8443, 81])}"
        scheme = "http"
    elif style == "dual_use":
        host = rng.choice(DUAL_USE_HOSTS)
    else:
        host = f"{''.join(rng.choices(string.ascii_lowercase, k=rng.randint(7, 14)))}.{rng.choice(RISKY_TLDS)}"

    url = f"{scheme}://{host}/{_rand_path(rng, rng.randint(1, 3))}"
    if rng.random() < 0.35:
        url += f"?{rng.choice(['id', 'session', 'u', 'ref', 'token'])}=" \
               f"{''.join(rng.choices(string.ascii_letters + string.digits, k=rng.randint(10, 28)))}"
    return url


def make_benign_url(rng: random.Random, brand: str | None, corp_domain: str) -> str:
    r = rng.random()
    if brand and r < 0.30:
        host = BRANDS[brand]
        if rng.random() < 0.5:
            host = f"{rng.choice(['www', 'account', 'secure', 'support'])}.{host}"
    elif r < 0.50:
        host = rng.choice(BENIGN_HOSTS)
    elif r < 0.70:
        host = rng.choice(DUAL_USE_HOSTS)          # overlap with phishing
    elif r < 0.80:
        host = rng.choice(SHORTENERS)              # overlap: marketing uses shorteners
        return f"https://{host}/{''.join(rng.choices(string.ascii_letters + string.digits, k=rng.randint(6, 9)))}"
    else:
        host = f"{rng.choice(['portal', 'intranet', 'apps', 'www'])}.{corp_domain}"
    url = f"https://{host}/{_rand_path(rng, rng.randint(1, 3))}"
    if rng.random() < 0.30:
        url += f"?utm_source=email&utm_campaign={''.join(rng.choices(string.ascii_lowercase, k=6))}"
    return url


def _slot_values(rng: random.Random, brand: str, corp: str) -> dict[str, str]:
    first = rng.choice(FIRST_NAMES)
    sender_first = rng.choice(FIRST_NAMES)
    return {
        "name": first,
        "sender_first": sender_first,
        "brand": brand,
        "date": f"{rng.choice(MONTHS)} {rng.randint(1, 28)}",
        "month": rng.choice(MONTHS),
        "amount": f"${rng.randint(12, 48000):,}.{rng.randint(0, 99):02d}",
        "ticket": f"{rng.choice(['INV', 'REF', 'TKT', 'CS', 'PO'])}-{rng.randint(10000, 999999)}",
        "days": str(rng.choice([2, 3, 5, 7, 10, 14, 30])),
        "pct": str(rng.randint(88, 99)),
        "docname": rng.choice(DOCNAMES),
        "dept": rng.choice(DEPARTMENTS),
        "signoff": rng.choice(SIGNOFFS),
        "city": rng.choice(CITIES),
        "email": f"{first.lower()}.{rng.choice(LAST_NAMES).lower()}@{corp}",
    }


def _render(tmpl: str, slots: dict[str, str], url: str | None) -> str:
    out = tmpl
    for k, v in slots.items():
        out = out.replace("{" + k + "}", v)
    if url is not None:
        out = out.replace("{url}", url)
    else:
        # BEC-style: drop the whole URL sentence instead of leaving a hole
        out = re.sub(r"[^.\n]*\{url\}[^.\n]*\.?", "", out)
    return out


def _typo(rng: random.Random, text: str) -> str:
    """Light, realistic typo/obfuscation noise (also applied to a few benigns)."""
    subs = [("please", "pls"), ("account", "acount"), ("verification", "verifcation"),
            ("immediately", "imediately"), ("received", "recieved"), ("suspended", "suspened")]
    for a, b in subs:
        if a in text.lower() and rng.random() < 0.5:
            text = re.sub(a, b, text, count=1, flags=re.I)
    return text


def _pick_theme(rng: random.Random, label: int) -> dict[str, Any]:
    key = "p_weight" if label == 1 else "b_weight"
    weights = [t[key] for t in THEMES]
    return rng.choices(THEMES, weights=weights, k=1)[0]


def synth_record(rng: random.Random, label: int, idx: int,
                 excluded_templates: set[str] | None = None,
                 only_excluded: bool = False) -> dict[str, Any]:
    """Generate one labelled email record.

    excluded_templates / only_excluded carve out the unseen-template slice used
    by part of the holdout.
    """
    while True:
        theme = _pick_theme(rng, label)
        s_i = rng.randrange(len(theme["subjects"]))
        b_i = rng.randrange(len(theme["bodies"]))
        template_id = f"{theme['name']}:s{s_i}:b{b_i}"
        if excluded_templates is None:
            break
        in_excluded = template_id in excluded_templates
        if only_excluded and in_excluded:
            break
        if not only_excluded and not in_excluded:
            break

    brand = rng.choice(list(BRANDS))
    corp = rng.choice(CORP_DOMAINS)
    slots = _slot_values(rng, brand, corp)

    # stealth phishing: clean text, clean auth, often no URL -> hard FNs
    stealth = label == 1 and rng.random() < 0.28
    # noisy benign: ESP relay, display-name mismatch, shortener, urgent CTA -> hard FPs
    noisy_benign = label == 0 and rng.random() < 0.22

    # URLs
    urls: list[str] = []
    if label == 1:
        if theme["name"] == "bec_request" or stealth:
            n_url = 0 if rng.random() < 0.75 else 1
        else:
            n_url = rng.choices([1, 2, 3, 4], weights=[52, 27, 13, 8], k=1)[0]
        # stealth phishing links to dual-use hosting so the URL family sees nothing odd
        p_benign_link = 0.80 if stealth else 0.22
        for _ in range(n_url):
            if rng.random() < p_benign_link:
                urls.append(make_benign_url(rng, brand, corp))
            else:
                urls.append(make_phishing_url(rng, brand))
    else:
        n_url = rng.choices([0, 1, 2, 3], weights=[18, 46, 26, 10], k=1)[0]
        for _ in range(n_url):
            urls.append(make_benign_url(rng, brand if rng.random() < 0.5 else None, corp))
        if noisy_benign and not urls:
            urls.append(f"https://{rng.choice(SHORTENERS)}/"
                        f"{''.join(rng.choices(string.ascii_letters + string.digits, k=7))}")

    primary_url = urls[0] if urls else None

    # text
    subject = _render(theme["subjects"][s_i], slots, primary_url)
    body = _render(theme["bodies"][b_i], slots, primary_url)
    if len(urls) > 1:
        body += "\n\nAlso: " + "  ".join(urls[1:])
    for _ in range(rng.randint(0, 2)):
        body += "\n" + _render(rng.choice(FILLER), slots, primary_url)

    if label == 1 and not stealth and rng.random() < 0.45:
        body = _typo(rng, body)
    if label == 0 and rng.random() < 0.06:
        body = _typo(rng, body)          # benign mail has typos too

    # urgency injection, more often on phishing but benign mail gets it too
    urgency = ["Immediate action is required!", "This is time sensitive.",
               "Please respond within 24 hours.", "Failure to act may interrupt service!",
               "Do not ignore this notice.", "ACT NOW to avoid interruption!",
               "Don't miss out!", "Last chance to respond."]
    if label == 1 and rng.random() < 0.55:
        body += "\n" + rng.choice(urgency)
    elif label == 0 and rng.random() < (0.30 if noisy_benign else 0.12):
        body += "\n" + rng.choice(urgency)

    # sender and headers
    last = rng.choice(LAST_NAMES)
    if label == 1:
        if stealth or rng.random() < 0.30:
            # BEC: plausible human display name over freemail or lookalike corp
            display = f"{slots['sender_first']} {last}"
            dom = rng.choice(FREEMAIL) if rng.random() < 0.55 else _homoglyph(rng, corp)
            addr = f"{slots['sender_first'].lower()}.{last.lower()}@{dom}"
        else:
            display = rng.choice([f"{brand} Support", f"{brand} Security", brand,
                                  slots["dept"], f"{brand} Billing"])
            phost = re.sub(r"^https?://", "", make_phishing_url(rng, brand)).split("/")[0].split(":")[0]
            addr = f"{rng.choice(['no-reply', 'support', 'service', 'alerts', 'admin'])}@{phost}"
    else:
        if rng.random() < 0.45:
            display = f"{slots['sender_first']} {last}"
            addr = f"{slots['sender_first'].lower()}.{last.lower()}@{corp}"
        else:
            display = rng.choice([f"{brand} Support", brand, slots["dept"], f"{corp.split('.')[0].title()} IT"])
            addr = f"{rng.choice(['no-reply', 'notifications', 'support', 'billing'])}@" \
                   f"{BRANDS[brand] if rng.random() < 0.55 else corp}"

    # reply-to mismatch: strong phishing signal, but benign ESPs do it too
    reply_to = ""
    if label == 1 and rng.random() < 0.42:
        reply_to = f"{rng.choice(['reply', 'info', 'admin', slots['sender_first'].lower()])}@" \
                   f"{rng.choice(FREEMAIL + [f'mail-{rng.randint(1,99)}.{rng.choice(RISKY_TLDS)}'])}"
    elif label == 0 and rng.random() < (0.35 if noisy_benign else 0.10):
        reply_to = f"reply@{rng.choice(['mailer.sendgrid.net', 'bounces.mailchimp.com', corp])}"

    # auth results, heavily overlapping between the classes
    if label == 1:
        spf = rng.random() < (0.72 if stealth else 0.30)
        dkim = spf and rng.random() < 0.62
        dmarc = dkim and rng.random() < 0.55
    else:
        spf = rng.random() < 0.88
        dkim = spf and rng.random() < 0.90
        dmarc = dkim and rng.random() < 0.88
    if noisy_benign:
        spf = rng.random() < 0.55
        dkim = spf and rng.random() < 0.5
        dmarc = dkim and rng.random() < 0.5

    hops = rng.randint(2, 9) if label == 1 else rng.randint(2, 6)
    has_attach = rng.random() < (0.34 if label == 1 else 0.22)

    if noisy_benign:
        display = rng.choice([f"{brand} Deals", "Special Offer", f"{brand} Rewards"])
        addr = f"campaign{rng.randint(100,999)}@{rng.choice(['mailer.sendgrid.net','em.marketing-cloud.com','sendible.io'])}"

    # near-duplicate cluster: bounds group size so splits stay group-disjoint
    cluster = rng.randrange(14)
    group_id = f"{template_id}#c{cluster}"

    return {
        "id": f"syn-{idx:06d}",
        "subject": subject.strip(),
        "body": body.strip(),
        "sender_display_name": display,
        "sender_address": addr,
        "reply_to": reply_to,
        "urls": urls,
        "has_attachment": bool(has_attach),
        "spf_pass": bool(spf),
        "dkim_pass": bool(dkim),
        "dmarc_pass": bool(dmarc),
        "received_hops": int(hops),
        "label": int(label),
        "group_id": group_id,
        "theme": theme["name"],
        "template_id": template_id,
        "source": "synthetic",
    }


def build_synthetic(n: int, seed: int, start_idx: int = 0,
                    excluded_templates: set[str] | None = None,
                    only_excluded_frac: float = 0.0,
                    label_noise: float = 0.015) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    records = []
    n_unseen = int(n * only_excluded_frac)
    for i in range(n):
        label = 1 if rng.random() < 0.42 else 0
        use_excluded = i < n_unseen
        rec = synth_record(
            rng, label, start_idx + i,
            excluded_templates=excluded_templates,
            only_excluded=use_excluded,
        )
        records.append(rec)

    # symmetric label noise, injected last so it is irreducible
    n_flip = int(len(records) * label_noise)
    for rec in rng.sample(records, k=n_flip):
        rec["label"] = 1 - rec["label"]
        rec["source"] = rec["source"] + "+noise"
    return records


_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)


def _decode_body(msg: email.message.Message) -> str:
    try:
        if msg.is_multipart():
            parts = []
            for p in msg.walk():
                if p.get_content_type() in ("text/plain", "text/html"):
                    payload = p.get_payload(decode=True) or b""
                    parts.append(payload.decode(p.get_content_charset() or "utf-8", "replace"))
            text = "\n".join(parts)
        else:
            payload = msg.get_payload(decode=True) or b""
            text = payload.decode(msg.get_content_charset() or "utf-8", "replace")
    except Exception:
        text = str(msg.get_payload())[:20000]
    text = re.sub(r"<[^>]+>", " ", text)          # strip HTML tags, keep anchor text
    return re.sub(r"\s+", " ", text).strip()[:20000]


def _auth_from_headers(msg: email.message.Message) -> tuple[bool, bool, bool]:
    ar = " ".join(msg.get_all("Authentication-Results", []) or []).lower()
    ar += " " + " ".join(msg.get_all("Received-SPF", []) or []).lower()
    return ("spf=pass" in ar or ar.strip().startswith("pass"),
            "dkim=pass" in ar,
            "dmarc=pass" in ar)


def _parse_message(msg: email.message.Message, label: int, idx: int, source: str) -> dict[str, Any]:
    subject = str(msg.get("Subject", "") or "")
    body = _decode_body(msg)
    raw_from = str(msg.get("From", "") or "")
    display, addr = email.utils.parseaddr(raw_from)
    reply_to = email.utils.parseaddr(str(msg.get("Reply-To", "") or ""))[1]
    urls = list(dict.fromkeys(_URL_RE.findall(subject + " " + body)))[:25]
    spf, dkim, dmarc = _auth_from_headers(msg)
    hops = len(msg.get_all("Received", []) or [])
    has_attach = any(
        (p.get_filename() or "") for p in msg.walk()
    ) if msg.is_multipart() else False
    return {
        "id": f"real-{idx:06d}",
        "subject": subject.strip(),
        "body": body.strip(),
        "sender_display_name": display.strip(),
        "sender_address": addr.strip(),
        "reply_to": reply_to.strip(),
        "urls": urls,
        "has_attachment": bool(has_attach),
        "spf_pass": bool(spf),
        "dkim_pass": bool(dkim),
        "dmarc_pass": bool(dmarc),
        "received_hops": int(hops),
        "label": int(label),
        # real mail has no template, so group by sender domain instead
        "group_id": f"real:{(addr.split('@')[-1] or 'unknown').lower()}",
        "theme": "real",
        "template_id": f"real:{source}",
        "source": source,
    }


def _iter_messages(root: Path) -> Iterable[email.message.Message]:
    """Yield messages from mbox files, maildirs, or flat directories of RFC-822."""
    if root.is_file():
        candidates = [root]
    else:
        candidates = sorted(p for p in root.rglob("*") if p.is_file())
    for path in candidates:
        try:
            head = path.open("rb").read(64)
        except OSError:
            continue
        if head.startswith(b"From "):
            try:
                for m in mailbox.mbox(str(path), factory=None):
                    yield m
                continue
            except Exception:
                pass
        try:
            with path.open("rb") as fh:
                yield email.message_from_binary_file(fh, policy=email.policy.compat32)
        except Exception:
            continue


def _merge_url_feeds(corpus_dir: Path, records: list[dict[str, Any]], rng: random.Random) -> int:
    """Attach PhishTank / UCI URL evidence to phishing records that have none."""
    feed: list[str] = []
    pt = corpus_dir / "verified_online.csv"
    if pt.exists():
        import csv
        with pt.open(newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                u = row.get("url") or row.get("URL")
                if u:
                    feed.append(u.strip())
    uci = corpus_dir / "uci_phishing.csv"
    if uci.exists():
        import csv
        with uci.open(newline="", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                u = row.get("url") or row.get("URL") or row.get("Domain")
                if u and u.startswith("http"):
                    feed.append(u.strip())
    if not feed:
        return 0
    n = 0
    for rec in records:
        if rec["label"] == 1 and not rec["urls"]:
            rec["urls"] = [rng.choice(feed)]
            n += 1
    return n


def load_real_corpus(corpus_dir: Path) -> list[dict[str, Any]]:
    """Parse a real corpus laid out as <dir>/phishing/** and <dir>/ham/**."""
    records: list[dict[str, Any]] = []
    idx = 0
    for sub, label, src in (("phishing", 1, "nazario"), ("ham", 0, "spamassassin")):
        d = corpus_dir / sub
        if not d.exists():
            continue
        for msg in _iter_messages(d):
            if msg is None:
                continue
            try:
                records.append(_parse_message(msg, label, idx, src))
                idx += 1
            except Exception:
                continue
    if records:
        _merge_url_feeds(corpus_dir, records, random.Random(DEFAULT_SEED))
    return records


def write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n")


def write_manifest(path: Path, records: list[dict[str, Any]]) -> str:
    """Order-independent manifest of the holdout; its sha256 is the evaluationCommit."""
    entries = sorted(
        (
            {
                "id": r["id"],
                "label": r["label"],
                "sha256": hashlib.sha256(
                    json.dumps({k: r[k] for k in sorted(r) if k != "id"},
                               ensure_ascii=False, sort_keys=True).encode()
                ).hexdigest(),
            }
            for r in records
        ),
        key=lambda e: e["id"],
    )
    payload = {"schemaVersion": 1, "count": len(entries), "entries": entries}
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(blob, encoding="utf-8")
    return hashlib.sha256(blob.encode()).hexdigest()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--real-corpus", default=os.environ.get("PHISH_CORPUS_DIR", ""),
                    help="Path to a real corpus dir (<dir>/phishing, <dir>/ham). "
                         "Falls back to the synthesiser if absent or empty.")
    ap.add_argument("--n-corpus", type=int, default=8000)
    ap.add_argument("--n-holdout", type=int, default=1200)
    ap.add_argument("--seed", type=int, default=DEFAULT_SEED)
    ap.add_argument("--label-noise", type=float, default=0.015)
    ap.add_argument("--out-dir", default=str(HERE))
    args = ap.parse_args(argv)

    out = Path(args.out_dir)
    provenance = "synthetic"
    corpus: list[dict[str, Any]] = []
    holdout: list[dict[str, Any]] = []

    if args.real_corpus:
        cdir = Path(args.real_corpus).expanduser()
        if cdir.exists():
            print(f"[build_dataset] trying real corpus at {cdir}")
            real = load_real_corpus(cdir)
            if len(real) >= 200:
                rng = random.Random(args.seed)
                rng.shuffle(real)
                # group-disjoint holdout carve-out
                groups = sorted({r["group_id"] for r in real})
                rng.shuffle(groups)
                k = max(1, int(len(groups) * 0.13))
                hold_groups = set(groups[:k])
                holdout = [r for r in real if r["group_id"] in hold_groups]
                corpus = [r for r in real if r["group_id"] not in hold_groups]
                provenance = "real"
                print(f"[build_dataset] real corpus: {len(corpus)} corpus / {len(holdout)} holdout")
            else:
                print(f"[build_dataset] only {len(real)} usable messages found, falling back to synthetic")
        else:
            print(f"[build_dataset] {cdir} does not exist, falling back to synthetic")

    if provenance == "synthetic":
        print("[build_dataset] restricted egress: synthesising a deterministic corpus "
              f"(seed={args.seed})")
        # hold back a few templates the corpus never sees, for the drift signal
        all_templates = [f"{t['name']}:s{si}:b{bi}"
                         for t in THEMES
                         for si in range(len(t["subjects"]))
                         for bi in range(len(t["bodies"]))]
        rng = random.Random(args.seed + 99)
        excluded = set(rng.sample(all_templates, k=max(4, len(all_templates) // 12)))

        corpus = build_synthetic(args.n_corpus, args.seed, 0,
                                 excluded_templates=excluded,
                                 only_excluded_frac=0.0,
                                 label_noise=args.label_noise)
        holdout = build_synthetic(args.n_holdout, args.seed + 1, 900000,
                                  excluded_templates=excluded,
                                  only_excluded_frac=0.25,   # 25% unseen-template stress
                                  label_noise=args.label_noise)
        # give the holdout its own group namespace so no cluster straddles the two
        cgroups = {r["group_id"] for r in corpus}
        for r in holdout:
            if r["group_id"] in cgroups:
                r["group_id"] = "hold::" + r["group_id"]

    write_jsonl(out / "corpus.jsonl", corpus)
    write_jsonl(out / "holdout.jsonl", holdout)
    commit = write_manifest(out / "holdout_manifest.json", holdout)

    summary = {
        "provenance": provenance,
        "seed": args.seed,
        "label_noise": args.label_noise,
        "corpus": {
            "n": len(corpus),
            "phishing": sum(r["label"] for r in corpus),
            "benign": sum(1 - r["label"] for r in corpus),
            "groups": len({r["group_id"] for r in corpus}),
            "templates": len({r["template_id"] for r in corpus}),
        },
        "holdout": {
            "n": len(holdout),
            "phishing": sum(r["label"] for r in holdout),
            "benign": sum(1 - r["label"] for r in holdout),
            "groups": len({r["group_id"] for r in holdout}),
            "unseen_template_records": sum(
                1 for r in holdout if r["template_id"] not in {c["template_id"] for c in corpus}
            ),
        },
        "group_overlap_corpus_holdout": len(
            {r["group_id"] for r in corpus} & {r["group_id"] for r in holdout}
        ),
        "evaluationCommit": commit,
        "sources_documented": [
            "https://monkey.org/~jose/phishing/",
            "https://spamassassin.apache.org/old/publiccorpus/",
            "https://phishtank.org/developer_info.php",
            "https://archive.ics.uci.edu/dataset/327/phishing+websites",
        ],
    }
    (out / "dataset_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
