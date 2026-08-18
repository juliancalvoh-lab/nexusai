# Demo materials

- `Calvo_Julian_AAI6850_Capstone_Slides.pptx`: 17 slides, speaker notes included
- `crosschain_demo.mp4`: screen capture of the local demo running, 20 seconds
- `demo_script.md`: what to say and what to run

Screenshots of the running system are in `docs/screenshots/`.

## Live part

From the repo root:

```bash
npm install
npm run build
npm test
npm run demo:crosschain
```

`demo:crosschain` is the one to record. It runs 10 steps in about 30 seconds and
prints real contract state at each one. `crosschain_demo.mp4` is a capture of it,
and `docs/screenshots/crosschain_demo.png` is the final output as a still.

Nothing here needs a funded account or an RPC key.

## Testnet status

Hub on Ethereum Sepolia, spoke on Ethereum Hoodi. The cross-chain workflow ran
between them in 14 transactions. Addresses and links are in
`docs/DEPLOYMENT.md`.

`crosschain_demo.mp4` records the local two-stack run, which covers all ten steps
including the circuit breaker and the dispute. The testnet run covers the listing
mirror.
