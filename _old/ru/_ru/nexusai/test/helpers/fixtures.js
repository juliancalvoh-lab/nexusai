const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const DAY = 24 * 60 * 60;

const CONFIG = {
  genesisMint: ethers.parseEther("400000000"),
  timelockDelay: 2 * DAY,
  votingDelay: DAY,
  votingPeriod: 5 * DAY,
  proposalThreshold: ethers.parseEther("250000"),
  quorumPercent: 4,
  oracle: { minQuorum: 3, staleness: DAY, maxDeviationBps: 1500 },
  hubSelector: 11155111n, // Sepolia
  spokeSelector: 84532n, // Base Sepolia
  routerBaseFee: ethers.parseEther("0.0001"),
};

// full local deployment; the deployer keeps admin roles so tests can call privileged paths
async function deployFixture() {
  const signers = await ethers.getSigners();
  const [deployer, provider, buyer, reporter1, reporter2, reporter3, attester, bidderA, bidderB, outsider] = signers;

  // governance shell
  const Timelock = await ethers.getContractFactory("NexusTimelock");
  const timelock = await Timelock.deploy(CONFIG.timelockDelay, [], [], deployer.address);

  const Token = await ethers.getContractFactory("NexusAIToken");
  const token = await Token.deploy(deployer.address, CONFIG.genesisMint, deployer.address);

  const Governor = await ethers.getContractFactory("NexusGovernor");
  const governor = await Governor.deploy(
    await token.getAddress(),
    await timelock.getAddress(),
    CONFIG.votingDelay,
    CONFIG.votingPeriod,
    CONFIG.proposalThreshold,
    CONFIG.quorumPercent
  );

  // protocol
  const Oracle = await ethers.getContractFactory("AIPerformanceOracle");
  const oracle = await Oracle.deploy(
    deployer.address,
    CONFIG.oracle.minQuorum,
    CONFIG.oracle.staleness,
    CONFIG.oracle.maxDeviationBps
  );

  const Compliance = await ethers.getContractFactory("ComplianceRegistry");
  const compliance = await Compliance.deploy(deployer.address);

  const Vault = await ethers.getContractFactory("StakingVault");
  const vault = await Vault.deploy(await token.getAddress(), await timelock.getAddress(), deployer.address);

  const Marketplace = await ethers.getContractFactory("AIModelMarketplace");
  const marketplace = await Marketplace.deploy(
    await token.getAddress(),
    await oracle.getAddress(),
    await compliance.getAddress(),
    await vault.getAddress(),
    await timelock.getAddress(),
    deployer.address
  );

  const Auction = await ethers.getContractFactory("SealedBidLicenceAuction");
  const auction = await Auction.deploy(await token.getAddress(), await compliance.getAddress(), deployer.address);

  // cross-chain: two routers + two registries stand in for two chains
  const Router = await ethers.getContractFactory("MockCrossChainRouter");
  const hubRouter = await Router.deploy(CONFIG.hubSelector, CONFIG.routerBaseFee, deployer.address);
  const spokeRouter = await Router.deploy(CONFIG.spokeSelector, CONFIG.routerBaseFee, deployer.address);

  // The spoke has its own marketplace instance.
  const spokeMarketplace = await Marketplace.deploy(
    await token.getAddress(),
    await oracle.getAddress(),
    await compliance.getAddress(),
    await vault.getAddress(),
    await timelock.getAddress(),
    deployer.address
  );

  const Registry = await ethers.getContractFactory("CrossChainRegistry");
  const hubRegistry = await Registry.deploy(
    await hubRouter.getAddress(),
    await marketplace.getAddress(),
    CONFIG.hubSelector,
    deployer.address
  );
  const spokeRegistry = await Registry.deploy(
    await spokeRouter.getAddress(),
    await spokeMarketplace.getAddress(),
    CONFIG.spokeSelector,
    deployer.address
  );

  await hubRegistry.setTrustedRemote(CONFIG.spokeSelector, await spokeRegistry.getAddress());
  await spokeRegistry.setTrustedRemote(CONFIG.hubSelector, await hubRegistry.getAddress());

  // Wire the auction so a won exclusive licence is actually issued on-chain.
  await auction.setMarketplace(await marketplace.getAddress());
  await marketplace.grantRole(await marketplace.LICENCE_ISSUER_ROLE(), await auction.getAddress());

  const CROSSCHAIN_ROLE = await marketplace.CROSSCHAIN_ROLE();
  await marketplace.grantRole(CROSSCHAIN_ROLE, await hubRegistry.getAddress());
  await spokeMarketplace.grantRole(CROSSCHAIN_ROLE, await spokeRegistry.getAddress());

  // roles
  await vault.grantRole(await vault.SLASHER_ROLE(), deployer.address);
  await oracle.addReporter(reporter1.address);
  await oracle.addReporter(reporter2.address);
  await oracle.addReporter(reporter3.address);
  await compliance.grantRole(await compliance.ATTESTER_ROLE(), attester.address);

  // funding
  const fund = async (who, amount) => token.transfer(who.address, amount);
  await fund(provider, ethers.parseEther("1000000"));
  await fund(buyer, ethers.parseEther("1000000"));
  await fund(bidderA, ethers.parseEther("1000000"));
  await fund(bidderB, ethers.parseEther("1000000"));
  await fund(outsider, ethers.parseEther("1000000"));

  return {
    signers,
    deployer,
    provider,
    buyer,
    reporter1,
    reporter2,
    reporter3,
    attester,
    bidderA,
    bidderB,
    outsider,
    token,
    timelock,
    governor,
    oracle,
    compliance,
    vault,
    marketplace,
    spokeMarketplace,
    auction,
    hubRouter,
    spokeRouter,
    hubRegistry,
    spokeRegistry,
    CONFIG,
  };
}

// stake a bond big enough and locked long enough to list a model
async function bondProvider(ctx, who = ctx.provider, amount = ethers.parseEther("50000"), tier = 2) {
  await ctx.token.connect(who).approve(await ctx.vault.getAddress(), amount);
  await ctx.vault.connect(who).stake(amount, tier);
}

// register a model with default settings, returns the modelId
async function registerModel(ctx, overrides = {}) {
  const cfg = {
    metadataURI: "ipfs://bafyPhishGuardModelCard",
    weightsHash: ethers.keccak256(ethers.toUtf8Bytes("phishguard-v1-weights")),
    price: ethers.parseEther("1000"),
    minAccuracyBps: 9000,
    licenceTerm: 30 * DAY,
    requiresCompliance: false,
    signer: ctx.provider,
    ...overrides,
  };

  const tx = await ctx.marketplace
    .connect(cfg.signer)
    .registerModel(
      cfg.metadataURI,
      cfg.weightsHash,
      cfg.price,
      cfg.minAccuracyBps,
      cfg.licenceTerm,
      cfg.requiresCompliance
    );
  const receipt = await tx.wait();
  const parsed = receipt.logs
    .map((l) => {
      try {
        return ctx.marketplace.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "ModelRegistered");
  return parsed.args.modelId;
}

// push enough oracle reports to open the quality gate
async function reportAccuracy(ctx, modelId, accuracyBps = 9600, latencyMs = 12, driftBps = 250) {
  for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
    await ctx.oracle.connect(r).submitReport(modelId, accuracyBps, latencyMs, driftBps);
  }
}

// attest with a two-leaf Merkle tree so one attribute can be revealed on its own
async function attest(ctx, account, jurisdiction = 840, ttl = 365 * DAY) {
  const leafA = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "bytes32"],
      ["accredited", "true", ethers.id("saltA")]
    )
  );
  const leafB = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "bytes32"],
      ["entityType", "financial-institution", ethers.id("saltB")]
    )
  );
  // root = keccak(sorted(leafA, leafB)), same ordering as OZ MerkleProof
  const [lo, hi] = leafA < leafB ? [leafA, leafB] : [leafB, leafA];
  const root = ethers.keccak256(ethers.concat([lo, hi]));

  const now = await time.latest();
  await ctx.compliance.connect(ctx.attester).attest(account.address, root, jurisdiction, now + ttl);
  return { root, leafA, leafB, proofForA: [leafB], proofForB: [leafA] };
}

module.exports = { deployFixture, bondProvider, registerModel, reportAccuracy, attest, CONFIG, DAY };
