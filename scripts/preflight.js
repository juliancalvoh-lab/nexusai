// estimates what a deployment on this network will cost and checks the balance
// covers it. sends nothing. run before deploy.js so you find out you are short
// before you are half deployed.
//   npx hardhat run scripts/preflight.js --network baseSepolia
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
  const provider = ethers.provider;
  const balance = await provider.getBalance(deployer.address);
  const fee = await provider.getFeeData();
  const gasPrice = fee.maxFeePerGas || fee.gasPrice;

  const isHub = cfg.role === "hub" || cfg.role === "local";
  const useDemoRouter = process.env.TESTNET_DEMO_ROUTER === "true" || cfg.role === "local";

  console.log(`\npreflight: ${cfg.label} (${network.name}), role ${cfg.role}`);
  console.log(`  deployer  ${deployer.address}`);
  console.log(`  balance   ${ethers.formatEther(balance)} ETH`);
  console.log(`  gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei\n`);

  const zero = ethers.ZeroAddress;
  const me = deployer.address;
  // placeholder addresses are fine, we only want the deploy gas
  const plan = [
    ["NexusTimelock", [PARAMS.timelock.minDelay, [], [], me]],
    ["NexusAIToken", [me, isHub ? PARAMS.token.genesisMint : 0n, me]],
    ["ComplianceRegistry", [me]],
    ["AIPerformanceOracle", [me, PARAMS.oracle.minQuorum, PARAMS.oracle.stalenessWindow, PARAMS.oracle.maxDeviationBps]],
    ["StakingVault", [me, me, me]],
    ["AIModelMarketplace", [me, me, me, me, me, me]],
    ["SealedBidLicenceAuction", [me, me, me]],
  ];
  if (isHub) {
    plan.push(["NexusGovernor", [me, me, PARAMS.governor.votingDelay, PARAMS.governor.votingPeriod,
      PARAMS.governor.proposalThreshold, PARAMS.governor.quorumPercent]]);
  }
  if (useDemoRouter) plan.push(["MockCrossChainRouter", [cfg.chainSelector, PARAMS.router.baseFee, me]]);
  if (useDemoRouter || process.env.CROSSCHAIN_ROUTER) {
    plan.push(["CrossChainRegistry", [process.env.CROSSCHAIN_ROUTER || me, me, cfg.chainSelector, me]]);
  }

  let total = 0n;
  for (const [name, args] of plan) {
    const factory = await ethers.getContractFactory(name);
    const tx = await factory.getDeployTransaction(...args);
    let gas;
    try {
      gas = await provider.estimateGas({ ...tx, from: me });
    } catch {
      // estimateGas reverts when the balance cannot cover it, so fall back to
      // the bytecode-length heuristic rather than giving up.
      gas = BigInt(Math.ceil((ethers.dataLength(tx.data) * 200) + 100000));
      console.log(`  ${name.padEnd(26)} ${String(gas).padStart(10)}  (estimated from bytecode, node refused)`);
      total += gas;
      continue;
    }
    console.log(`  ${name.padEnd(26)} ${String(gas).padStart(10)}`);
    total += gas;
  }

  const wiring = 400000n; // role grants + setParameters + setMarketplace
  total += wiring;
  console.log(`  ${"wiring txs".padEnd(26)} ${String(wiring).padStart(10)}`);

  const cost = total * gasPrice;
  const l2 = cfg.chainSelector !== 11155111n && cfg.role !== "local";
  const margin = l2 ? 3n : 2n; // L2s also pay an L1 data fee that is not in estimateGas

  console.log(`\n  total gas       ${total}`);
  console.log(`  execution cost  ${ethers.formatEther(cost)} ETH`);
  if (l2) console.log(`  note: this is L2 execution only. Base also charges an L1 data fee for the`);
  if (l2) console.log(`        calldata, which estimateGas does not include. Hence the wider margin.`);
  const need = cost * margin;
  console.log(`  recommended     ${ethers.formatEther(need)} ETH  (${margin}x for fee drift${l2 ? " + L1 data" : ""})`);

  if (balance >= need) {
    console.log(`\n  OK. Balance covers the recommended amount.\n`);
  } else if (balance >= cost) {
    console.log(`\n  TIGHT. Balance covers the estimate but not the ${margin}x margin.`);
    console.log(`  Top up by ${ethers.formatEther(need - balance)} ETH to be safe.\n`);
    process.exitCode = 1;
  } else {
    console.log(`\n  SHORT. Need at least ${ethers.formatEther(need - balance)} ETH more.\n`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
