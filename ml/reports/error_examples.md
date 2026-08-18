# Error analysis: concrete misclassified test samples

Model: **M6_softvote_M3_M5**, operating threshold **0.272** on the held-out test split.

Test set: 1600 messages (673 phishing, 927 benign). **29 false positives**, **25 false negatives**.

Of those, 21 FPs and 9 FNs are genuine model failures; 8 FPs and 16 FNs land on records whose label was flipped by the synthetic annotation-noise process (see the last section). **The examples below are all genuine model failures on correctly labelled mail.**

> Attribution note: the selected model is not linear, so per-feature contributions below come from the tuned linear model (`M5_combined_logreg_tuned`) used as a surrogate explainer on the same features. The listed errors are the SELECTED model's errors.

Each entry lists the record, the features that actually moved its score (`coefficient x value`, signed), and why the mistake happened.

---

## False positives: legitimate mail flagged as phishing (6 shown)

These are the trust-destroying errors: real business mail sent to quarantine.

- **id** `syn-002686`  |  **theme** `password_reset`  |  **score** 0.557 (threshold 0.272)
  - **From:** `Vertexcap IT <no-reply@paypal.com>`
  - **Subject:** Re: multi-factor authentication enrolment
  - **Body (first 300 chars):** Hi Tom,  We detected a sign-in to your PayPal account from a device we do not recognise (Boston, US). If this was you, no action is needed.  Reference: REF-886379  Sincerely HR Operations Thank you for your continued custom. This notice is sent to all account holders. ACT NOW to avoid interruption!
  - **URLs:** (none)
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 0 URL(s)
  - **Top URL/header drivers of the wrong call:** `https_ratio`=0 (+1.411), `any_brand_lookalike`=0 (+0.917), `display_has_brand`=0 (+0.840), `url_max_len`=0 (+0.719), `exclaim_count`=1 (+0.698)
  - **Top text drivers:** `paypal` (+0.019), `do` (+0.011), `do not` (+0.011), `enrolment` (+0.010), `this` (+0.010)
  - **Why it fired:** `https_ratio`=0 carried the most weight here.

- **id** `syn-003295`  |  **theme** `account_billing`  |  **score** 0.554 (threshold 0.272)
  - **From:** `Carlos Lindqvist <carlos.lindqvist@tuftsmedical.org>`
  - **Subject:** Receipt for your PayPal subscription — $35,612.31
  - **Body (first 300 chars):** Thanks for your payment of $35,612.31. Your PayPal plan renews on October 13.  Reference TKT-821002.  Kind regards If you believe you received this in error, please let us know. This message and any attachments are confidential.
  - **URLs:** (none)
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 0 URL(s)
  - **Top URL/header drivers of the wrong call:** `https_ratio`=0 (+1.411), `any_brand_lookalike`=0 (+0.917), `display_has_brand`=0 (+0.840), `url_max_len`=0 (+0.719), `n_urls`=0 (+0.653)
  - **Top text drivers:** `35` (+0.077), `paypal` (+0.039), `your paypal` (+0.020), `of 35` (+0.019), `kind` (+0.019)
  - **Why it fired:** `https_ratio`=0 carried the most weight here.

- **id** `syn-003500`  |  **theme** `password_reset`  |  **score** 0.521 (threshold 0.272)
  - **From:** `UPS Support <support@vertexcap.com>`
  - **Subject:** Password expiration notice for daniel.haddad@vertexcap.com
  - **Body (first 300 chars):** Hello Daniel,  Our records show the password for your UPS account has not been changed in 90 days and will expire on July 23. To keep access to mail and shared drives, please review your settings at https://tinyurl.com/SOywO7.  If you have already updated your password you can ignore this message.  
  - **URLs:** ['https://tinyurl.com/SOywO7', 'https://apps.vertexcap.com/portal', 'https://workday.com/file/u/id']
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 3 URL(s)
  - **Top URL/header drivers of the wrong call:** `display_brand_mismatch`=1 (+1.871), `brand_lookalike_min_dist`=2 (+0.550), `body_len`=452 (+0.440), `received_hops`=6 (+0.435), `reply_to_present`=0 (+0.411)
  - **Top text drivers:** `password` (+0.031), `password expiration` (+0.028), `expiration notice` (+0.028), `expiration` (+0.028), `notice for` (+0.028)
  - **Why it fired:** `display_brand_mismatch`=1 carried the most weight here.

- **id** `syn-003854`  |  **theme** `reward_offer`  |  **score** 0.500 (threshold 0.272)
  - **From:** `Michael Kowalski <michael.kowalski@northeastern.edu>`
  - **Subject:** December customer survey — $18,437.64 gift card
  - **Body (first 300 chars):** Your Chase rewards balance of $18,437.64 expires on February 17.  Thanks Chase Your privacy matters to us; see our policy for details.
  - **URLs:** (none)
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 0 URL(s)
  - **Top URL/header drivers of the wrong call:** `https_ratio`=0 (+1.411), `any_brand_lookalike`=0 (+0.917), `display_has_brand`=0 (+0.840), `url_max_len`=0 (+0.719), `n_urls`=0 (+0.653)
  - **Top text drivers:** `17` (+0.018), `december` (+0.008), `of` (+0.008), ` $1` (+0.007), `8,4` (+0.007)
  - **Why it fired:** `https_ratio`=0 carried the most weight here.

- **id** `syn-003780`  |  **theme** `shared_document`  |  **score** 0.473 (threshold 0.272)
  - **From:** `Apple Support <no-reply@vertexcap.com>`
  - **Subject:** Document for review: Service Contract
  - **Body (first 300 chars):** Omar shared a document with you.  Service Contract  Open it here: https://workday.com/track/update/update/ozzd6cumn2sij7042z2  This link is tied to your email address. If you were not expecting this document you can safely ignore the message.  Regards  Also: https://portal.vertexcap.com/account/id/a
  - **URLs:** ['https://workday.com/track/update/update/ozzd6cumn2sij7042z2', 'https://portal.vertexcap.com/account/id/auth']
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 2 URL(s)
  - **Top URL/header drivers of the wrong call:** `display_brand_mismatch`=1 (+1.871), `exclaim_count`=1 (+0.698), `brand_lookalike_min_dist`=2 (+0.550), `body_len`=456 (+0.452), `reply_to_present`=0 (+0.411)
  - **Top text drivers:** `review service` (+0.020), `contract` (+0.018), `ignore` (+0.016), `com track` (+0.015), `this` (+0.013)
  - **Why it fired:** `display_brand_mismatch`=1 carried the most weight here.

- **id** `syn-000465`  |  **theme** `invoice_payment`  |  **score** 0.460 (threshold 0.272)
  - **From:** `LinkedIn Support <support@brightpathhealth.org>`
  - **Subject:** Remittance advice for invoice REF-500646
  - **Body (first 300 chars):** Dear Carlos,  Please find attached invoice REF-500646 for $42,816.70, due April 1.  Thank you for your business.  Thanks Facilities Your privacy matters to us; see our policy for details.
  - **URLs:** (none)
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 0 URL(s)
  - **Top URL/header drivers of the wrong call:** `display_brand_mismatch`=1 (+1.871), `https_ratio`=0 (+1.411), `any_brand_lookalike`=0 (+0.917), `url_max_len`=0 (+0.719), `n_urls`=0 (+0.653)
  - **Top text drivers:** `advice` (+0.054), `advice for` (+0.054), `for invoice` (+0.054), `remittance advice` (+0.054), `42` (+0.031)
  - **Why it fired:** `display_brand_mismatch`=1 carried the most weight here.


---

## False negatives: phishing delivered to the inbox (6 shown)

These are the costly errors: the user sees an attack with no warning.

- **id** `syn-006020`  |  **theme** `legal_threat`  |  **score** 0.009 (threshold 0.272)
  - **From:** `Payroll <alerts@mxtnqykkn.info>`
  - **Subject:** Copyright complaint concerning your content
  - **Body (first 300 chars):** We recieved a complaint relating to material associated with your acount. Under our policy you have 2 days to respond. The complaint reference is PO-696739 and the response form is at https://support.microsoft.com/billing/billing/view/smizvpygeuqhfxw37zpq5?utm_source=email&utm_campaign=gdvwop.  Best
  - **URLs:** ['https://support.microsoft.com/billing/billing/view/smizvpygeuqhfxw37zpq5?utm_source=email&utm_campaign=gdvwop']
  - **Signals:** 3/3 auth checks passed (SPF=1, DKIM=1, DMARC=1); 1 URL(s)
  - **Top URL/header drivers of the wrong call:** `url_max_len`=109 (-0.985), `display_brand_mismatch`=0 (-0.898), `received_hops`=2 (-0.804), `any_brand_lookalike`=1 (-0.535), `sender_domain_digits`=0 (-0.501)
  - **Top text drivers:** `microsoft` (-0.029), `utm_source email` (-0.015), `email utm_campaign` (-0.015), `utm_source` (-0.015), `utm_campaign` (-0.015)
  - **Why it was missed:** `url_max_len`=109 was the strongest signal and it pointed the wrong way.

- **id** `syn-005871`  |  **theme** `it_notice`  |  **score** 0.037 (threshold 0.272)
  - **From:** `Laura Rahman <laura.rahman@qu@nturnleap.ai>`
  - **Subject:** Scheduled maintenance February 23
  - **Body (first 300 chars):** Your mailbox is at 96% of its quota. Once full you will stop receiving mail. Request additional storage at https://jira.internal/r/a4o16h or archive older items.  Reference CS-97108.  Kind regards Payroll Last chance to respond.
  - **URLs:** ['https://jira.internal/r/a4o16h']
  - **Signals:** 1/3 auth checks passed (SPF=1, DKIM=0, DMARC=0); 1 URL(s)
  - **Top URL/header drivers of the wrong call:** `display_brand_mismatch`=0 (-0.898), `any_brand_lookalike`=1 (-0.535), `sender_domain_digits`=0 (-0.501), `https_ratio`=1 (-0.499), `received_hops`=3 (-0.494)
  - **Top text drivers:** `scheduled` (-0.027), `scheduled maintenance` (-0.020), `storage at` (-0.018), `internal` (-0.016), `96 of` (-0.016)
  - **Why it was missed:** `display_brand_mismatch`=0 was the strongest signal and it pointed the wrong way.

- **id** `syn-006707`  |  **theme** `it_notice`  |  **score** 0.094 (threshold 0.272)
  - **From:** `Sarah Chen <sarah.chen@tuftsmedi(al.org>`
  - **Subject:** New device enrolment policy
  - **Body (first 300 chars):** The VPN client certificate on your workstation expires June 22. Renew it from https://ow.ly/g0KRg2w1 while connected to the corporate network.  Thanks Benefits Administration
  - **URLs:** ['https://ow.ly/g0KRg2w1']
  - **Signals:** 0/3 auth checks passed (SPF=0, DKIM=0, DMARC=0); 1 URL(s)
  - **Top URL/header drivers of the wrong call:** `brand_lookalike_min_dist`=9 (-1.151), `display_brand_mismatch`=0 (-0.898), `sender_domain_digits`=0 (-0.501), `https_ratio`=1 (-0.499), `sender_is_freemail`=0 (-0.489)
  - **Top text drivers:** `expires` (-0.028), `new` (-0.025), `https ow` (-0.024), `ow` (-0.024), `ow ly` (-0.024)
  - **Why it was missed:** `brand_lookalike_min_dist`=9 was the strongest signal and it pointed the wrong way.

- **id** `syn-007140`  |  **theme** `shared_document`  |  **score** 0.095 (threshold 0.272)
  - **From:** `Omar Haddad <omar.haddad@bluewater-marine.(orn>`
  - **Subject:** DocuSign: you have a new shared file
  - **Body (first 300 chars):** Omar shared a document with you.  Q3 Budget Review    This link is tied to your email address. If you were not expecting this document you can safely ignore the message.  Thanks This message and any attachments are confidential. Thank you for your continued custom.
  - **URLs:** (none)
  - **Signals:** 2/3 auth checks passed (SPF=1, DKIM=1, DMARC=0); 0 URL(s)
  - **Top URL/header drivers of the wrong call:** `url_max_entropy`=0 (-1.379), `brand_lookalike_min_dist`=9 (-1.151), `display_brand_mismatch`=0 (-0.898), `sender_domain_len`=21 (-0.667), `sender_domain_digits`=0 (-0.501)
  - **Top text drivers:** `have new` (-0.044), `new shared` (-0.044), `shared file` (-0.044), `shared` (-0.026), `new` (-0.022)
  - **Why it was missed:** `url_max_entropy`=0 was the strongest signal and it pointed the wrong way.

- **id** `syn-006717`  |  **theme** `account_billing`  |  **score** 0.099 (threshold 0.272)
  - **From:** `Kevin McAllister <kevin.mcallister@bluew@ter-marine.com>`
  - **Subject:** Billing update required for LinkedIn
  - **Body (first 300 chars):** We were unable to process the payment method for your LinkedIn account on January 6. Your membership is on hold. Update the payment method at https://sites.google.com/session/portal/r/ond46bzu6429wx6o5ny1 to restore access.  Reference REF-451929.  Kind regards LinkedIn
  - **URLs:** ['https://sites.google.com/session/portal/r/ond46bzu6429wx6o5ny1']
  - **Signals:** 1/3 auth checks passed (SPF=1, DKIM=0, DMARC=0); 1 URL(s)
  - **Top URL/header drivers of the wrong call:** `display_brand_mismatch`=0 (-0.898), `any_brand_lookalike`=1 (-0.535), `sender_domain_digits`=0 (-0.501), `https_ratio`=1 (-0.499), `received_hops`=3 (-0.494)
  - **Top text drivers:** `update required` (-0.024), `required for` (-0.024), `billing update` (-0.021), `linkedin` (-0.016), `january` (-0.012)
  - **Why it was missed:** `display_brand_mismatch`=0 was the strongest signal and it pointed the wrong way.

- **id** `syn-001498`  |  **theme** `invoice_payment`  |  **score** 0.159 (threshold 0.272)
  - **From:** `Apple Billing <no-reply@notion.site>`
  - **Subject:** Updated banking details for remittance
  - **Body (first 300 chars):** Hi Elena,  Invoice REF-352484 for $47,398.87 is now 2 days past due. Could you confirm whether it has been scheduled for payment? The statement is available at https://apple.com/view/confirm/ogsvx1mmfnv02z2wtmpfu.  Best Billing Support  Also: https://sites.google.com/u/update/auth?u=I2ODQ4dSXJEtVLmn
  - **URLs:** ['https://apple.com/view/confirm/ogsvx1mmfnv02z2wtmpfu', 'https://sites.google.com/u/update/auth?u=I2ODQ4dSXJEtVLmnWlqqYtmX2wll']
  - **Signals:** 3/3 auth checks passed (SPF=1, DKIM=1, DMARC=1); 2 URL(s)
  - **Top URL/header drivers of the wrong call:** `display_has_brand`=1 (-1.301), `any_brand_lookalike`=1 (-0.535), `sender_domain_digits`=0 (-0.501), `https_ratio`=1 (-0.499), `sender_is_freemail`=0 (-0.489)
  - **Top text drivers:** `scheduled` (-0.014), `due` (-0.013), `apple` (-0.012), `been` (-0.012), `days` (-0.011)
  - **Why it was missed:** `display_has_brand`=1 was the strongest signal and it pointed the wrong way.


---

## Patterns across all errors

Error counts by theme:

```
theme  account_billing  bec_request  hr_payroll  invoice_payment  it_notice  legal_threat  meeting_project  password_reset  reward_offer  shared_document  shipping
err                                                                                                                                                                
FN                   3            0           3                2          3             1                4               2             2                2         3
FP                   2            3           0                2          2             1                0               7             3                8         1
```

**24 of 54 errors (44.4%) fall on records whose label was flipped by the synthetic annotation-noise process.** On those the model is arguably right and the ground truth is wrong. They form the irreducible-error floor built into the dataset on purpose, and they are why a score near 1.00 would be a red flag rather than a success. The remaining 30 are genuine model failures.

- **12 of 25 false negatives pass all three authentication checks.** Attacker-controlled or compromised domains that publish valid SPF/DKIM/DMARC defeat the header family entirely.
- **1 of 25 false negatives contain no URL at all** (business-email-compromise style), so the URL family contributes nothing and the model must decide on ordinary business English alone.
- Median false-negative score is 0.055 against a threshold of 0.272, i.e. they sit well below the boundary, so these are confident errors that a small threshold change would NOT recover, because every feature the model trusts says 'benign'. Median false-positive score is 0.433, just above the boundary, borderline cases, which is the tractable shape for a human review queue.

---

## Appendix: errors that are actually label noise

24 of the 54 errors sit on flipped labels. One example, to show what that looks like:

- **id** `syn-000725`  |  **theme** `shipping`  |  **score** 0.999 (threshold 0.272)
  - **From:** `HR Operations <no-reply@linkedin.com.cdn-static.top>`  **Reply-To:** `info@yahoo.com`
  - **Subject:** Shipment TKT-534685 out for delivery
  - **Body (first 300 chars):** Hi Omar,  Your order has shipped and is expected July 7. Track it at http://linkedin.com.secure-login.cf/file/account/update.  Tracking number TKT-534685.  Regards LinkedIn  Also: http://login.linkedin.com.secure-login.click/track/si3uvjqconkrxas  https://service-linkedin.co/file/billing If you beli
  - **URLs:** ['http://linkedin.com.secure-login.cf/file/account/update', 'http://login.linkedin.com.secure-login.click/track/si3uvjqconkrxas', 'https://service-linkedin.co/file/billing']
  - **Signals:** 1/3 auth checks passed (SPF=1, DKIM=0, DMARC=0); 3 URL(s); reply-to header present; **this record carries an injected label flip**, so the model's prediction is arguably correct and the *label* is wrong
  - **Top URL/header drivers of the wrong call:** `sender_domain_risky_tld`=1 (+4.209), `any_risky_tld`=1 (+2.653), `reply_to_freemail`=1 (+2.525), `reply_to_domain_mismatch`=1 (+1.068), `brand_lookalike_min_dist`=0 (+1.036)
  - **Top text drivers:** `delivery hi` (+0.020), `july` (+0.015), `685` (+0.009), `login linkedin` (+0.009), `co` (+0.009)
