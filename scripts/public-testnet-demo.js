// runs a model-listing transfer between two public testnets and records the txs.
// deploy both sides with TESTNET_DEMO_ROUTER=true first.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { NETWORKS } = require("./config");

const ROOT = path.join(__dirname, "..");
const SOURCE = process.env.SOURCE_NETWORK || "sepolia";
const DEST = process.env.DEST_NETWORK || "baseSepolia";

const RPC_ENV = {
  sepolia: "SEPOLIA_RPC_URL",
  baseSepolia: "BASE_SEPOLIA_RPC_URL",
  arbitrumSepolia: "ARBITRUM_SEPOLIA_RPC_URL",
  amoy: "AMOY_RPC_URL",
  hoodi: "HOODI_RPC_URL",
};
const DEFAULT_RPC = {
  sepolia: "https://rpc.sepolia.org",
  baseSepolia: "https://sepolia.base.org",
  arbitrumSepolia: "https://sepolia-rollup.arbitrum.io/rpc",
  amoy: "https://rpc-amoy.polygon.technology",
  hoodi: "https://ethereum-hoodi-rpc.publicnode.com",
};
const EXPLORER = {
  sepolia: "https://sepolia.etherscan.io",
  baseSepolia: "https://sepolia.basescan.org",
  arbitrumSepolia: "https://sepolia.arbiscan.io",
  amoy: "https://amoy.polygonscan.com",
  hoodi: "https://hoodi.etherscan.io",
};

const loadDeployment = (name) => {
  const file = path.join(ROOT, "deployments", `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${path.relative(ROOT, file)}. Deploy ${name} first.`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};
const artifact = (relative) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts", relative), "utf8")).abi;
const wait = async (tx, evidence, network, label) => {
  const receipt = await tx.wait();
  evidence.transactions.push({
    network,
    label,
    hash: receipt.hash,
    blockNumber: receipt.blockNumber,
    explorer: `${EXPLORER[network]}/tx/${receipt.hash}`,
  });
  console.log(`  ${label.padEnd(32)} ${receipt.hash}`);
  return receipt;
};

async function main() {
  if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY is required in .env.");
  if (!NETWORKS[SOURCE] || !NETWORKS[DEST] || SOURCE === DEST) throw new Error("Choose two different configured public networks.");

  const srcDep = loadDeployment(SOURCE);
  const dstDep = loadDeployment(DEST);
  for (const [name, dep] of [[SOURCE, srcDep], [DEST, dstDep]]) {
    for (const required of ["MockCrossChainRouter", "CrossChainRegistry", "AIModelMarketplace"]) {
      if (!dep.contracts[required]) throw new Error(`${name} deployment lacks ${required}; deploy with TESTNET_DEMO_ROUTER=true.`);
    }
  }

  const srcProvider = new ethers.JsonRpcProvider(process.env[RPC_ENV[SOURCE]] || DEFAULT_RPC[SOURCE]);
  const dstProvider = new ethers.JsonRpcProvider(process.env[RPC_ENV[DEST]] || DEFAULT_RPC[DEST]);
  const srcSigner = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, srcProvider);
  const dstSigner = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, dstProvider);

  const tokenAbi = artifact("contracts/token/NexusAIToken.sol/NexusAIToken.json");
  const vaultAbi = artifact("contracts/staking/StakingVault.sol/StakingVault.json");
  const oracleAbi = artifact("contracts/oracle/AIPerformanceOracle.sol/AIPerformanceOracle.json");
  const marketAbi = artifact("contracts/marketplace/AIModelMarketplace.sol/AIModelMarketplace.json");
  const routerAbi = artifact("contracts/crosschain/MockCrossChainRouter.sol/MockCrossChainRouter.json");
  const registryAbi = artifact("contracts/crosschain/CrossChainRegistry.sol/CrossChainRegistry.json");

  const token = new ethers.Contract(srcDep.contracts.NexusAIToken, tokenAbi, srcSigner);
  const vault = new ethers.Contract(srcDep.contracts.StakingVault, vaultAbi, srcSigner);
  const oracle = new ethers.Contract(srcDep.contracts.AIPerformanceOracle, oracleAbi, srcSigner);
  const srcMarket = new ethers.Contract(srcDep.contracts.AIModelMarketplace, marketAbi, srcSigner);
  const dstMarket = new ethers.Contract(dstDep.contracts.AIModelMarketplace, marketAbi, dstSigner);
  const srcRouter = new ethers.Contract(srcDep.contracts.MockCrossChainRouter, routerAbi, srcSigner);
  const dstRouter = new ethers.Contract(dstDep.contracts.MockCrossChainRouter, routerAbi, dstSigner);
  const srcRegistry = new ethers.Contract(srcDep.contracts.CrossChainRegistry, registryAbi, srcSigner);
  const dstRegistry = new ethers.Contract(dstDep.contracts.CrossChainRegistry, registryAbi, dstSigner);

  const evidence = {
    generatedAt: new Date().toISOString(),
    workflow: "public-testnet model-listing transfer with operator-relayed demonstration adapter",
    productionTransport: false,
    source: { network: SOURCE, chainId: Number((await srcProvider.getNetwork()).chainId), contracts: srcDep.contracts },
    destination: { network: DEST, chainId: Number((await dstProvider.getNetwork()).chainId), contracts: dstDep.contracts },
    deployer: srcSigner.address,
    transactions: [],
  };

  console.log(`\nPublic-testnet demonstration: ${SOURCE} -> ${DEST}`);
  await wait(await srcRegistry.setTrustedRemote(BigInt(dstDep.chainSelector), dstDep.contracts.CrossChainRegistry), evidence, SOURCE, "trust destination registry");
  await wait(await dstRegistry.setTrustedRemote(BigInt(srcDep.chainSelector), srcDep.contracts.CrossChainRegistry), evidence, DEST, "trust source registry");
  await wait(await srcRouter.setPeerRouter(BigInt(dstDep.chainSelector), dstDep.contracts.MockCrossChainRouter), evidence, SOURCE, "record destination router");
  await wait(await dstRouter.setPeerRouter(BigInt(srcDep.chainSelector), srcDep.contracts.MockCrossChainRouter), evidence, DEST, "record source router");

  const stakeAmount = ethers.parseEther("50000");
  if ((await vault.stakedOf(srcSigner.address)) < stakeAmount) {
    // the genesis mint goes to the Timelock treasury, not the deployer, so on a
    // real deployment this account starts with no NEXA. mint what the demo needs
    // while the deployer still holds MINTER_ROLE (before the governance handoff).
    const held = await token.balanceOf(srcSigner.address);
    if (held < stakeAmount) {
      const minterRole = await token.MINTER_ROLE();
      if (!(await token.hasRole(minterRole, srcSigner.address))) {
        throw new Error(
          "Deployer holds no NEXA and no MINTER_ROLE. Run this before governance-handoff.js, " +
          "or transfer at least 50,000 NEXA to the deployer first."
        );
      }
      await wait(await token.mint(srcSigner.address, stakeAmount - held), evidence, SOURCE, "mint demo provider bond");
    }
    await wait(await token.approve(await vault.getAddress(), stakeAmount), evidence, SOURCE, "approve staking vault");
    await wait(await vault.stake(stakeAmount, 2), evidence, SOURCE, "stake provider bond");
  }

  await wait(await oracle.setParameters(1, 86400, 1500), evidence, SOURCE, "set demo oracle quorum");
  const reporterRole = await oracle.REPORTER_ROLE();
  if (!(await oracle.hasRole(reporterRole, srcSigner.address))) {
    await wait(await oracle.addReporter(srcSigner.address), evidence, SOURCE, "authorize demo reporter");
  }

  const unique = `${Date.now()}-${SOURCE}-${DEST}`;
  const registerReceipt = await wait(
    await srcMarket.registerModel(`ipfs://nexusai-public-demo/${unique}`, ethers.id(`weights-${unique}`), ethers.parseEther("1000"), 9000, 2592000, false),
    evidence,
    SOURCE,
    "register source model",
  );
  const registered = registerReceipt.logs.map((log) => { try { return srcMarket.interface.parseLog(log); } catch { return null; } }).find((event) => event?.name === "ModelRegistered");
  if (!registered) throw new Error("ModelRegistered event not found.");
  const modelId = registered.args.modelId;
  evidence.modelId = modelId;

  await wait(await oracle.submitReport(modelId, 9600, 12, 250), evidence, SOURCE, "publish oracle result");
  const publishReceipt = await wait(
    await srcRegistry.publishModel(modelId, BigInt(dstDep.chainSelector), { value: ethers.parseEther("0.01") }),
    evidence,
    SOURCE,
    "publish cross-chain model",
  );
  const sent = publishReceipt.logs.map((log) => { try { return srcRouter.interface.parseLog(log); } catch { return null; } }).find((event) => event?.name === "MessageSent");
  if (!sent) throw new Error("MessageSent event not found.");
  evidence.messageId = sent.args.messageId;
  evidence.nonce = sent.args.nonce.toString();

  await wait(
    await dstRouter.relayIn(BigInt(srcDep.chainSelector), sent.args.sender, sent.args.nonce, sent.args.receiver, sent.args.payload),
    evidence,
    DEST,
    "relay model on destination",
  );
  await wait(await srcRouter.acknowledge(sent.args.messageId), evidence, SOURCE, "acknowledge source message");

  const mirrored = await dstMarket.modelOf(modelId);
  if (!mirrored.active || mirrored.originChain !== BigInt(srcDep.chainSelector)) throw new Error("Destination model state did not match the source workflow.");
  evidence.destinationState = { active: mirrored.active, provider: mirrored.provider, originChain: mirrored.originChain.toString() };
  evidence.contractExplorers = {
    sourceRegistry: `${EXPLORER[SOURCE]}/address/${srcDep.contracts.CrossChainRegistry}`,
    destinationRegistry: `${EXPLORER[DEST]}/address/${dstDep.contracts.CrossChainRegistry}`,
  };

  const dir = path.join(ROOT, "deployments");
  const out = path.join(dir, `public-demo-${SOURCE}-to-${DEST}.json`);
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2));
  console.log(`\nVerified destination model ${modelId}`);
  console.log(`Evidence: ${path.relative(ROOT, out)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
