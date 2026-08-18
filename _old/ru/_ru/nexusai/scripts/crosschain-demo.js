// deploys a hub and a spoke in one EVM and walks the whole workflow, printing
// each step. run with: npx hardhat run scripts/crosschain-demo.js
const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const E = ethers.parseEther;
const HUB = 11155111n;
const SPOKE = 84532n;

const line = (s = "") => console.log(s);
const h = (n, s) => line(`\n--- STEP ${n}: ${s} ---`);

async function main() {
  const [deployer, provider, buyer, r1, r2, r3, attester] = await ethers.getSigners();

  h(0, "Deploy the hub and the spoke");

  const timelock = await (await ethers.getContractFactory("NexusTimelock")).deploy(2 * DAY, [], [], deployer.address);
  const token = await (await ethers.getContractFactory("NexusAIToken")).deploy(
    deployer.address,
    E("400000000"),
    deployer.address
  );
  const oracle = await (await ethers.getContractFactory("AIPerformanceOracle")).deploy(
    deployer.address,
    3,
    DAY,
    1500
  );
  const compliance = await (await ethers.getContractFactory("ComplianceRegistry")).deploy(deployer.address);
  const vault = await (await ethers.getContractFactory("StakingVault")).deploy(
    await token.getAddress(),
    await timelock.getAddress(),
    deployer.address
  );

  const Marketplace = await ethers.getContractFactory("AIModelMarketplace");
  const mkArgs = [
    await token.getAddress(),
    await oracle.getAddress(),
    await compliance.getAddress(),
    await vault.getAddress(),
    await timelock.getAddress(),
    deployer.address,
  ];
  const hubMarket = await Marketplace.deploy(...mkArgs);
  const spokeMarket = await Marketplace.deploy(...mkArgs);

  const Router = await ethers.getContractFactory("MockCrossChainRouter");
  const hubRouter = await Router.deploy(HUB, E("0.0001"), deployer.address);
  const spokeRouter = await Router.deploy(SPOKE, E("0.0001"), deployer.address);

  const Registry = await ethers.getContractFactory("CrossChainRegistry");
  const hubReg = await Registry.deploy(await hubRouter.getAddress(), await hubMarket.getAddress(), HUB, deployer.address);
  const spokeReg = await Registry.deploy(
    await spokeRouter.getAddress(),
    await spokeMarket.getAddress(),
    SPOKE,
    deployer.address
  );

  await hubReg.setTrustedRemote(SPOKE, await spokeReg.getAddress());
  await spokeReg.setTrustedRemote(HUB, await hubReg.getAddress());
  await hubMarket.grantRole(await hubMarket.CROSSCHAIN_ROLE(), await hubReg.getAddress());
  await spokeMarket.grantRole(await spokeMarket.CROSSCHAIN_ROLE(), await spokeReg.getAddress());

  await oracle.addReporter(r1.address);
  await oracle.addReporter(r2.address);
  await oracle.addReporter(r3.address);
  await compliance.grantRole(await compliance.ATTESTER_ROLE(), attester.address);

  await token.transfer(provider.address, E("200000"));
  await token.transfer(buyer.address, E("200000"));

  line(`  HUB   marketplace ${await hubMarket.getAddress()}   (selector ${HUB})`);
  line(`  SPOKE marketplace ${await spokeMarket.getAddress()}   (selector ${SPOKE})`);

  h(1, "Provider bonds locked capital on the hub");
  await token.connect(provider).approve(await vault.getAddress(), E("50000"));
  await vault.connect(provider).stake(E("50000"), 2); // 180-day tier
  const [bond, unlockAt] = await vault.bondOf(provider.address);
  line(`  bonded ${ethers.formatEther(bond)} NEXA, locked until ${new Date(Number(unlockAt) * 1000).toISOString()}`);
  line(`  -> the bond is what makes the provider's accuracy claim expensive to fake.`);

  h(2, "Provider lists the phishing-detection model on the hub");
  const weightsHash = ethers.keccak256(ethers.toUtf8Bytes("phishguard-v1-weights"));
  const rcpt = await (
    await hubMarket
      .connect(provider)
      .registerModel("ipfs://bafyPhishGuardModelCard", weightsHash, E("1000"), 9000, 30 * DAY, true)
  ).wait();
  const modelId = rcpt.logs
    .map((l) => {
      try {
        return hubMarket.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "ModelRegistered").args.modelId;
  line(`  modelId       ${modelId}`);
  line(`  price         1000 NEXA / 30-day licence`);
  line(`  accuracy floor 90.00%  (enforced against the oracle at purchase time)`);
  line(`  compliance    required`);

  h(3, "The evaluation committee publishes holdout results to the oracle");
  const evals = [
    [r1, 9612, 12, 248],
    [r2, 9598, 13, 251],
    [r3, 9604, 11, 245],
  ];
  for (const [signer, acc, lat, drift] of evals) {
    await oracle.connect(signer).submitReport(modelId, acc, lat, drift);
    line(`  reporter ${signer.address.slice(0, 10)}...  accuracy ${(acc / 100).toFixed(2)}%  p95 ${lat}ms  drift ${(drift / 100).toFixed(2)}%`);
  }
  const agg = await oracle.latestAggregate(modelId);
  line(`  -> median published: ${(Number(agg.accuracyBps) / 100).toFixed(2)}% from ${agg.reportCount} reports (round ${agg.roundId})`);
  line(`  -> marketplace gate open: ${await oracle.isUsable(modelId)}`);

  h(4, "Buyer receives a privacy-preserving compliance attestation");
  const enc = ethers.AbiCoder.defaultAbiCoder();
  const leafA = ethers.keccak256(enc.encode(["string", "string", "bytes32"], ["accredited", "true", ethers.id("saltA")]));
  const leafB = ethers.keccak256(
    enc.encode(["string", "string", "bytes32"], ["entityType", "financial-institution", ethers.id("saltB")])
  );
  const [lo, hi] = leafA < leafB ? [leafA, leafB] : [leafB, leafA];
  const root = ethers.keccak256(ethers.concat([lo, hi]));
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  await compliance.connect(attester).attest(buyer.address, root, 840, now + 365 * DAY);
  line(`  on-chain record: root ${root.slice(0, 18)}..., jurisdiction 840, expiry +365d`);
  line(`  NO name, address, or document is stored anywhere on-chain.`);
  line(`  selective disclosure of one attribute verifies: ${await compliance.verifyAttribute(buyer.address, leafA, [leafB])}`);

  h(5, "Buyer purchases a licence on the hub");
  await token.connect(buyer).approve(await hubMarket.getAddress(), E("10000"));
  const supplyBefore = await token.totalSupply();
  const pr = await (await hubMarket.connect(buyer).purchaseLicence(modelId, ethers.id("ipfs://encrypted-key"))).wait();
  const ev = pr.logs
    .map((l) => {
      try {
        return hubMarket.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "LicencePurchased");
  line(`  paid          ${ethers.formatEther(ev.args.price)} NEXA`);
  line(`  protocol fee  ${ethers.formatEther(ev.args.fee)} NEXA`);
  line(`  burned        ${ethers.formatEther(ev.args.burned)} NEXA  (supply ${ethers.formatEther(supplyBefore)} -> ${ethers.formatEther(await token.totalSupply())})`);
  line(`  escrowed      ${ethers.formatEther(E("1000") - ev.args.fee)} NEXA for the 7-day dispute window`);
  line(`  licence valid until ${new Date(Number(ev.args.expiresAt) * 1000).toISOString()}`);

  h(6, "Mirror the listing HUB -> SPOKE");
  const relay = async (tx, from, to) => {
    const r = await tx.wait();
    const m = r.logs
      .map((l) => {
        try {
          return from.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "MessageSent");
    line(`  message ${m.args.messageId.slice(0, 18)}...  nonce ${m.args.nonce}  ${m.args.payload.length / 2} bytes`);
    await to.relayIn(await from.localChainSelector(), m.args.sender, m.args.nonce, m.args.receiver, m.args.payload);
    await from.acknowledge(m.args.messageId);
    line(`  delivered and acknowledged.`);
  };

  await relay(await hubReg.publishModel(modelId, SPOKE, { value: E("0.01") }), hubRouter, spokeRouter);
  const mirrored = await spokeMarket.modelOf(modelId);
  line(`  spoke now lists the model: provider ${mirrored.provider.slice(0, 10)}..., origin chain ${mirrored.originChain}`);

  h(7, "Mirror the entitlement HUB -> SPOKE");
  await relay(
    await hubReg.publishLicence(modelId, buyer.address, SPOKE, { value: E("0.01") }),
    hubRouter,
    spokeRouter
  );
  line(`  buyer has an active licence on the spoke: ${await spokeMarket.hasActiveLicence(modelId, buyer.address)}`);
  line(`  -> one purchase, entitlement recognised on both chains, no bridging of the asset.`);

  h(8, "Replay and spoofing attempts are rejected");
  const bad = await hubReg.publishLicence(modelId, buyer.address, SPOKE, { value: E("0.01") });
  const br = await bad.wait();
  const bm = br.logs
    .map((l) => {
      try {
        return hubRouter.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "MessageSent");
  await spokeRouter.relayIn(HUB, bm.args.sender, bm.args.nonce, bm.args.receiver, bm.args.payload);
  try {
    await spokeRouter.relayIn(HUB, bm.args.sender, bm.args.nonce, bm.args.receiver, bm.args.payload);
    line(`  !! replay succeeded, THIS WOULD BE A BUG`);
  } catch {
    line(`  replay of the same (chain, sender, nonce): REJECTED`);
  }
  try {
    await spokeReg.ccReceive(HUB, deployer.address, 999, "0x");
    line(`  !! direct call succeeded, THIS WOULD BE A BUG`);
  } catch {
    line(`  ccReceive called by a non-router: REJECTED`);
  }

  h(9, "Quality gate closes when the model degrades");
  await oracle.connect(r1).submitReport(modelId, 6100, 14, 4200);
  await oracle.connect(r2).submitReport(modelId, 6050, 15, 4300);
  line(`  two reporters now measure ~61% against a published 96%, a 35 point move.`);
  line(`  circuit breaker tripped: ${await oracle.circuitBroken(modelId)}`);
  try {
    await hubMarket.connect(buyer).purchaseLicence(modelId, ethers.id("k2"));
    line(`  !! purchase succeeded, THIS WOULD BE A BUG`);
  } catch (e) {
    line(`  further purchases: BLOCKED (${e.message.match(/OracleUnusable/) ? "OracleUnusable" : "reverted"})`);
  }

  h(10, "Buyer disputes, is refunded, and the provider's bond is slashed");
  await hubMarket.connect(buyer).openDispute(ev.args.purchaseId, "accuracy far below the declared floor");
  const before = await token.balanceOf(buyer.address);
  await hubMarket.resolveDispute(ev.args.purchaseId, true);
  line(`  refunded to buyer: ${ethers.formatEther((await token.balanceOf(buyer.address)) - before)} NEXA`);
  await vault.grantRole(await vault.SLASHER_ROLE(), deployer.address);
  await vault.slash(provider.address, 2000, "misrepresented model accuracy");
  line(`  provider bond after a 20% slash: ${ethers.formatEther(await vault.stakedOf(provider.address))} NEXA`);
  await hubMarket.delistModel(modelId, "misrepresented accuracy");
  line(`  model delisted: ${!(await hubMarket.modelOf(modelId)).active}`);

  line("\ndone. all 10 steps ran against real contract state.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
