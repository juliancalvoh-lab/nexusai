// verifies every contract in deployments/<network>.json on the block explorer.
// already-verified contracts are skipped, so this is safe to re-run.
const fs = require("fs");
const path = require("path");
const { run, network } = require("hardhat");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment record at ${file}`);
  const dep = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`\nVerifying ${Object.keys(dep.contracts).length} contracts on ${network.name}\n`);

  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const [name, address] of Object.entries(dep.contracts)) {
    const args = dep.constructorArgs[name] || [];
    process.stdout.write(`  ${name.padEnd(26)} ${address}  `);
    try {
      await run("verify:verify", { address, constructorArguments: args });
      console.log("VERIFIED");
      ok++;
    } catch (e) {
      const msg = String(e.message || e);
      if (/already verified/i.test(msg)) {
        console.log("already verified");
        skipped++;
      } else {
        console.log(`FAILED: ${msg.split("\n")[0]}`);
        failed++;
      }
    }
  }

  console.log(`\n  verified ${ok}, already-verified ${skipped}, failed ${failed}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
