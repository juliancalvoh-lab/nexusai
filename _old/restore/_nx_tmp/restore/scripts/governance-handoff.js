// moves every privileged role from the deployer to the Timelock, then renounces
// the deployer's own roles. DRY_RUN=true prints the plan without sending anything.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const DRY = process.env.DRY_RUN === "true";

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record at ${file}. Run scripts/deploy.js first.`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = dep.contracts;

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No signer. DEPLOYER_PRIVATE_KEY is empty or missing in .env.\n" +
      "  Put your key on the DEPLOYER_PRIVATE_KEY= line in .env and run this again."
    );
  }
  const at = async (name, key) => ethers.getContractAt(name, c[key]);

  const token = await at("NexusAIToken", "NexusAIToken");
  const vault = await at("StakingVault", "StakingVault");
  const oracle = await at("AIPerformanceOracle", "AIPerformanceOracle");
  const compliance = await at("ComplianceRegistry", "ComplianceRegistry");
  const marketplace = await at("AIModelMarketplace", "AIModelMarketplace");
  const auction = await at("SealedBidLicenceAuction", "SealedBidLicenceAuction");
  const timelock = await at("NexusTimelock", "NexusTimelock");
  const registry = c.CrossChainRegistry ? await at("CrossChainRegistry", "CrossChainRegistry") : null;
  const governor = c.NexusGovernor ? await at("NexusGovernor", "NexusGovernor") : null;

  const TL = c.NexusTimelock;

  // (label, contract, roleId) for every role the Timelock should end up with
  const grants = [
    ["NexusAIToken.DEFAULT_ADMIN", token, await token.DEFAULT_ADMIN_ROLE()],
    ["NexusAIToken.MINTER", token, await token.MINTER_ROLE()],
    ["NexusAIToken.EMISSION_MANAGER", token, await token.EMISSION_MANAGER_ROLE()],
    ["StakingVault.DEFAULT_ADMIN", vault, await vault.DEFAULT_ADMIN_ROLE()],
    ["StakingVault.VAULT_ADMIN", vault, await vault.VAULT_ADMIN_ROLE()],
    ["StakingVault.REWARD_MANAGER", vault, await vault.REWARD_MANAGER_ROLE()],
    ["StakingVault.SLASHER", vault, await vault.SLASHER_ROLE()],
    ["AIPerformanceOracle.DEFAULT_ADMIN", oracle, await oracle.DEFAULT_ADMIN_ROLE()],
    ["AIPerformanceOracle.ORACLE_ADMIN", oracle, await oracle.ORACLE_ADMIN_ROLE()],
    ["ComplianceRegistry.DEFAULT_ADMIN", compliance, await compliance.DEFAULT_ADMIN_ROLE()],
    ["ComplianceRegistry.COMPLIANCE_ADMIN", compliance, await compliance.COMPLIANCE_ADMIN_ROLE()],
    ["AIModelMarketplace.DEFAULT_ADMIN", marketplace, await marketplace.DEFAULT_ADMIN_ROLE()],
    ["AIModelMarketplace.MARKET_ADMIN", marketplace, await marketplace.MARKET_ADMIN_ROLE()],
    ["AIModelMarketplace.ARBITER", marketplace, await marketplace.ARBITER_ROLE()],
    ["SealedBidLicenceAuction.DEFAULT_ADMIN", auction, await auction.DEFAULT_ADMIN_ROLE()],
    ["SealedBidLicenceAuction.AUCTION_ADMIN", auction, await auction.AUCTION_ADMIN_ROLE()],
  ];
  if (registry) {
    grants.push(["CrossChainRegistry.DEFAULT_ADMIN", registry, await registry.DEFAULT_ADMIN_ROLE()]);
    grants.push(["CrossChainRegistry.BRIDGE_ADMIN", registry, await registry.BRIDGE_ADMIN_ROLE()]);
    grants.push(["CrossChainRegistry.PUBLISHER", registry, await registry.PUBLISHER_ROLE()]);
  }

  console.log(`\nGovernance hand-off on ${network.name}${DRY ? "  [DRY RUN]" : ""}`);
  console.log(`  timelock ${TL}`);
  console.log(`  deployer ${deployer.address}\n`);

  // Step 1: timelock wiring. Something has to be able to propose, or step 4
  // renounces the last admin and the timelock can never schedule anything again.
  // On a spoke there is no Governor, so the proposer has to be named explicitly.
  const PROPOSER = await timelock.PROPOSER_ROLE();
  let proposer = governor ? c.NexusGovernor : process.env.SPOKE_PROPOSER || "";
  if (!governor && !ethers.isAddress(proposer)) {
    // falling back to the deployer keeps the chain administrable. leaving it
    // empty would hand every role to a timelock nobody can ever propose to.
    proposer = deployer.address;
    console.log("  ! SPOKE_PROPOSER not set. Defaulting to the deployer so this chain stays");
    console.log("    administrable. A multisig should hold this before any real use.\n");
  }
  if (!ethers.isAddress(proposer)) throw new Error("Could not resolve a timelock proposer.");
  for (const [label, role, who] of [
    [`PROPOSER_ROLE -> ${governor ? "Governor" : "SPOKE_PROPOSER"}`, PROPOSER, proposer],
    [`CANCELLER_ROLE -> ${governor ? "Governor" : "SPOKE_PROPOSER"}`, await timelock.CANCELLER_ROLE(), proposer],
    ["EXECUTOR_ROLE -> anyone", await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress],
  ]) {
    console.log(`  timelock: ${label}`);
    if (!DRY) await (await timelock.grantRole(role, who)).wait();
  }

  // Step 2: grant every protocol role to the timelock.
  for (const [label, contract, role] of grants) {
    const already = await contract.hasRole(role, TL);
    console.log(`  grant  ${label.padEnd(42)} ${already ? "(already held)" : "-> timelock"}`);
    if (!already && !DRY) await (await contract.grantRole(role, TL)).wait();
  }

  // Step 3: renounce the deployer's roles, DEFAULT_ADMIN last.
  const ordered = [...grants].sort((a, b) => (a[0].endsWith("DEFAULT_ADMIN") ? 1 : 0) - (b[0].endsWith("DEFAULT_ADMIN") ? 1 : 0));
  for (const [label, contract, role] of ordered) {
    const held = await contract.hasRole(role, deployer.address);
    if (!held) continue;
    console.log(`  revoke ${label.padEnd(42)} <- deployer`);
    if (!DRY) await (await contract.renounceRole(role, deployer.address)).wait();
  }

  // Step 4: the deployer's admin role on the timelock goes last of all.
  const tlAdmin = await timelock.DEFAULT_ADMIN_ROLE();
  if (await timelock.hasRole(tlAdmin, deployer.address)) {
    console.log(`  revoke NexusTimelock.DEFAULT_ADMIN                  <- deployer`);
    if (!DRY) await (await timelock.renounceRole(tlAdmin, deployer.address)).wait();
  }

  // Step 5: verify. Any EOA still holding a role is a failure.
  if (!DRY) {
    console.log("\n  verification:");
    let bad = 0;
    for (const [label, contract, role] of grants) {
      const eoa = await contract.hasRole(role, deployer.address);
      const tl = await contract.hasRole(role, TL);
      const ok = !eoa && tl;
      if (!ok) bad++;
      console.log(`    ${ok ? "PASS" : "FAIL"}  ${label.padEnd(42)} timelock=${tl} deployer=${eoa}`);
    }
    const canPropose = await timelock.hasRole(PROPOSER, proposer);
    if (!canPropose) bad++;
    console.log(`    ${canPropose ? "PASS" : "FAIL"}  ${"NexusTimelock.PROPOSER".padEnd(42)} ${proposer}`);
    if (bad > 0) {
      console.error(`\n  ${bad} role(s) not correctly transferred. Deployment is NOT safe to announce.`);
      process.exitCode = 1;
      return;
    }
    console.log("\n  All privileged roles are held by the Timelock. Hand-off complete.\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
