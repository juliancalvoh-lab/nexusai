// deploys the stack and writes deployments/<network>.json.
// the deployer keeps admin roles, so run governance-handoff.js afterwards.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { NETWORKS, PARAMS } = require("./config");

async function main() {
  const cfg = NETWORKS[network.name];
  if (!cfg) throw new Error(`Unknown network '${network.name}'. Add it to scripts/config.js.`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer. DEPLOYER_PRIVATE_KEY is empty or missing in .env.\n" +
      "  Put your key on the DEPLOYER_PRIVATE_KEY= line in .env and run this again."
    );
  }
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log(`\nNexusAI deployment`);
  console.log(`  network        ${cfg.label} (${network.name})`);
  console.log(`  role           ${cfg.role}`);
  console.log(`  chain selector ${cfg.chainSelector}`);
  console.log(`  deployer       ${deployer.address}`);
  console.log(`  balance        ${ethers.formatEther(balance)} ETH\n`);

  const isHub = cfg.role === "hub" || cfg.role === "local";
  const out = { network: network.name, chainSelector: cfg.chainSelector.toString(), role: cfg.role, contracts: {}, constructorArgs: {} };

  const record = async (name, contract, args) => {
    const addr = await contract.getAddress();
    out.contracts[name] = addr;
    out.constructorArgs[name] = args.map((a) => (typeof a === "bigint" ? a.toString() : a));
    console.log(`  ${name.padEnd(24)} ${addr}`);
    return addr;
  };

  // 1. Timelock (treasury + future admin of everything)
  const timelockArgs = [PARAMS.timelock.minDelay, [], [], deployer.address];
  const timelock = await (await ethers.getContractFactory("NexusTimelock")).deploy(...timelockArgs);
  await timelock.waitForDeployment();
  const timelockAddr = await record("NexusTimelock", timelock, timelockArgs);

  // 2. Token. Genesis supply only on the hub, spokes start at zero.
  const genesis = isHub ? PARAMS.token.genesisMint : 0n;
  const tokenArgs = [timelockAddr, genesis, deployer.address];
  const token = await (await ethers.getContractFactory("NexusAIToken")).deploy(...tokenArgs);
  await token.waitForDeployment();
  const tokenAddr = await record("NexusAIToken", token, tokenArgs);

  // 3. Compliance registry (every chain needs its own)
  const complianceArgs = [deployer.address];
  const compliance = await (await ethers.getContractFactory("ComplianceRegistry")).deploy(...complianceArgs);
  await compliance.waitForDeployment();
  const complianceAddr = await record("ComplianceRegistry", compliance, complianceArgs);

  // 4. Oracle
  const oracleArgs = [
    deployer.address,
    PARAMS.oracle.minQuorum,
    PARAMS.oracle.stalenessWindow,
    PARAMS.oracle.maxDeviationBps,
  ];
  const oracle = await (await ethers.getContractFactory("AIPerformanceOracle")).deploy(...oracleArgs);
  await oracle.waitForDeployment();
  const oracleAddr = await record("AIPerformanceOracle", oracle, oracleArgs);

  // 5. Staking vault
  const vaultArgs = [tokenAddr, timelockAddr, deployer.address];
  const vault = await (await ethers.getContractFactory("StakingVault")).deploy(...vaultArgs);
  await vault.waitForDeployment();
  const vaultAddr = await record("StakingVault", vault, vaultArgs);

  // 6. Marketplace
  const marketArgs = [tokenAddr, oracleAddr, complianceAddr, vaultAddr, timelockAddr, deployer.address];
  const marketplace = await (await ethers.getContractFactory("AIModelMarketplace")).deploy(...marketArgs);
  await marketplace.waitForDeployment();
  const marketAddr = await record("AIModelMarketplace", marketplace, marketArgs);

  // 7. Sealed-bid auction
  const auctionArgs = [tokenAddr, complianceAddr, deployer.address];
  const auction = await (await ethers.getContractFactory("SealedBidLicenceAuction")).deploy(...auctionArgs);
  await auction.waitForDeployment();
  const auctionAddr = await record("SealedBidLicenceAuction", auction, auctionArgs);

  // 8. Governance (hub only, spokes are governed through the bridge)
  if (isHub) {
    const govArgs = [
      tokenAddr,
      timelockAddr,
      PARAMS.governor.votingDelay,
      PARAMS.governor.votingPeriod,
      PARAMS.governor.proposalThreshold,
      PARAMS.governor.quorumPercent,
    ];
    const governor = await (await ethers.getContractFactory("NexusGovernor")).deploy(...govArgs);
    await governor.waitForDeployment();
    await record("NexusGovernor", governor, govArgs);
  }

  // 9. Cross-chain router. Production binds a real CCIP/LayerZero adapter here.
  let routerAddr = process.env.CROSSCHAIN_ROUTER || "";
  const usePublicDemoRouter = process.env.TESTNET_DEMO_ROUTER === "true";
  if (cfg.role === "local" || usePublicDemoRouter) {
    const routerArgs = [cfg.chainSelector, PARAMS.router.baseFee, deployer.address];
    const router = await (await ethers.getContractFactory("MockCrossChainRouter")).deploy(...routerArgs);
    await router.waitForDeployment();
    routerAddr = await record("MockCrossChainRouter", router, routerArgs);
    if (cfg.role !== "local") {
      out.transport = "operator-relayed testnet demonstration; not a production bridge";
      console.log("  ! TESTNET_DEMO_ROUTER enabled: public-testnet evidence only; not production transport.");
    }
  } else if (!routerAddr) {
    console.log("\n  ! CROSSCHAIN_ROUTER not set, skipping CrossChainRegistry.");
    console.log("    Set it to the CCIP/LayerZero adapter for this chain and re-run with --tags crosschain.\n");
  }

  if (routerAddr) {
    const registryArgs = [routerAddr, marketAddr, cfg.chainSelector, deployer.address];
    const registry = await (await ethers.getContractFactory("CrossChainRegistry")).deploy(...registryArgs);
    await registry.waitForDeployment();
    const registryAddr = await record("CrossChainRegistry", registry, registryArgs);
    await (await marketplace.grantRole(await marketplace.CROSSCHAIN_ROLE(), registryAddr)).wait();
  }

  // 10. Wiring
  console.log("\n  wiring...");
  await (await auction.setMarketplace(marketAddr)).wait();
  await (await marketplace.grantRole(await marketplace.LICENCE_ISSUER_ROLE(), auctionAddr)).wait();
  // staking only lives on the hub, so a spoke cannot ask for a bond
  const bond = isHub ? PARAMS.marketplace.minProviderBond : 0n;
  const bondLock = isHub ? PARAMS.marketplace.minBondLock : 0;
  await (
    await marketplace.setParameters(
      PARAMS.marketplace.protocolFeeBps,
      PARAMS.marketplace.burnShareBps,
      PARAMS.marketplace.disputeWindow,
      bond,
      bondLock
    )
  ).wait();
  console.log(`  provider bond on this chain: ${bond === 0n ? "none (spoke)" : "10,000 NEXA locked 90d"}`);
  console.log("  wiring complete.");

  out.deployedAt = new Date().toISOString();
  out.blockNumber = await ethers.provider.getBlockNumber();
  out.deployer = deployer.address;

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\n  wrote ${path.relative(process.cwd(), file)}`);
  console.log(`\n  NEXT: npx hardhat run scripts/governance-handoff.js --network ${network.name}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
