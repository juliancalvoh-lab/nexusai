# Demo script

Target is about 12 minutes. Slide numbers match
`Calvo_Julian_AAI6850_Capstone_Slides.pptx`.

## Before recording

```bash
npm install && npm run build && npm test
```

Have two terminals open. One in the repo root for the demo, one spare.
Zoom the terminal font up so the output is readable in a recording.

Dry-run `npm run demo:crosschain` once so the compile is cached and the live run
is fast.

## 0:00 to 0:45, slides 1 and 2

Open with the problem, not the tech. A buyer can't verify a vendor's accuracy
claim before paying. Models decay and nobody says when. Licensing one is a
procurement cycle. And public chains publish who bought what.

## 0:45 to 3:00, slides 3 to 5

What I built. Ten contracts plus a real ML model. The point worth landing: the
provider posts a slashable bond and declares an accuracy floor, an oracle
committee measures the model on a holdout the provider hasn't seen, and the
marketplace won't sell below the floor. The oracle reads the ML result and the
marketplace gates on it.

Then tokenomics quickly: 1B cap, epoch-limited emissions, four staking tiers,
governor with a 2-day timelock, snapshot voting. Point out that the fee ceiling
and the emission ceiling are constants, so governance can't vote past them.

## 3:00 to 5:15, slides 6 and 7

The model. Three feature families, six-model ladder, selected ensemble, test F1
0.960 at a threshold chosen on expected cost rather than on F1.

Two things to actually spend time on:

1. Dropping the text entirely and using only URL and header features beat every
   text model. Most of the signal is in who sent it and where the links go.
2. The leakage control. Template-generated mail forms near-duplicate clusters, so
   the split is grouped, and I measured what that is worth: random split test F1
   0.9411 against grouped 0.9358.

Say the corpus is synthetic here rather than later.

## 5:15 to 7:15, slides 8 to 12

Oracle: median not mean, quorum of 3, 1-day staleness window, 15% circuit
breaker. Everything fails closed.

Privacy: Merkle root plus country code on chain and nothing else, one leaf
revealed per proof, commit-reveal auctions with uniform collateral so neither
the bid nor the deposit leaks.

Cross-chain: source emits, destination executes, destination re-authenticates
the router, the trusted remote and the nonce itself.

Security: 13 findings, 12 fixed, both Highs found by reading rather than by any
tool.

## 7:15 to 8:15, slides 13 and 15

Coverage numbers and the four CI hard gates. Then the business case, and be
straight that base-case NPV is positive only because of terminal value.

## 8:15 to 11:00, slide 14, then the terminal

Run it live:

```bash
npm run demo:crosschain
```

Narrate as it goes. The four moments that matter:

- Step 3: three reporters, the median lands at 96.04%, above the 90% floor
- Step 5: the purchase splits 15 burned, 35 to treasury, 950 escrowed
- Step 8: a replayed message and a direct ccReceive call both get rejected
- Step 9: the model drops to 61%, the breaker trips, and the next purchase
  reverts. This is the bit to point at

Finish on step 10: the buyer disputes, gets refunded, the bond is slashed 20%,
the model is delisted.

## 11:00 to 12:00, slides 16 and 17

Say what isn't done before anyone asks: operator-relayed router, self-review not
an audit, synthetic corpus, no cross-chain revocation, monitoring written but not
running.

Then the roadmap. The testnet deployment is done, so end on the real CCIP adapter
and an independent audit.

## Questions to have an answer ready for

**"Your F1 is on data you generated. Why should I believe any of it?"**
You shouldn't, as a claim about real mail, and I don't present it as one. What
it shows is that the pipeline is sound: grouped splits with zero overlap, a
leakage measurement, one shot at the test set. Re-running on real corpora is the
first item on the ML roadmap and I expect the number to drop.

**"Why does this need a blockchain? A database and a contract would do it."**
You need the buyer to be able to check the score wasn't tampered with, the
seller to have capital the buyer can actually reach, and the sale to stop by
itself when the score drops. A database gives you none of that unless you trust
whoever runs it. A consortium chain would probably do most of it, and the reason
I went public is mostly that I'd have had to pick the consortium.

**"You audited your own code. What is that worth?"**
Less than an independent audit. M-05 is a compliance bypass I introduced while
fixing a different finding and only caught on a later pass, and static analysis
found neither High finding. What it's worth is that every Slither result has a
written reason, 8 residual risks are written down, and an independent audit is
prerequisite one before mainnet.

**"What breaks first at scale?"**
The oracle committee. A median beats a minority of liars but not a majority, and
reporters are permissioned today, so trust concentrates there. Moving to a
decentralised oracle network with per-reporter staking is the fix, and it's on
the roadmap.

**"Why 30% for the discount rate?"**
It's a seed-stage convention and it's flagged as an unsourced estimate in the
model. That's why NPV is also reported at 20% and 40%.
