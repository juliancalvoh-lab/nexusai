// publishes the ML evaluation result on-chain. run ml/src/evaluate.py first.
// env: ORACLE_REPORT (path to the JSON), MODEL_ID (override the modelId).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

async function main() {
  const reportPath = process.env.ORACLE_REPORT || path.join(__dirname, "..", "ml", "reports", "oracle_report.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`No evaluation report at ${reportPath}. Run: python3 ml/src/evaluate.py`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  for (const k of ["accuracyBps", "latencyMs", "driftBps"]) {
    if (typeof report[k] !== "number") throw new Error(`Report field '${k}' missing or not a number`);
  }
  if (report.accuracyBps < 0 || report.accuracyBps > 10000) throw new Error("accuracyBps out of range");

  const modelId = process.env.MODEL_ID || report.modelId;
  if (!modelId || !/^0x[0-9a-fA-F]{64}$/.test(modelId)) {
    throw new Error("modelId must be a 0x-prefixed 32-byte hex string (set MODEL_ID or fix the report)");
  }

  const depFile = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(depFile)) throw new Error(`No deployment record at ${depFile}`);
  const dep = JSON.parse(fs.readFileSync(depFile, "utf8"));

  const oracle = await ethers.getContractAt("AIPerformanceOracle", dep.contracts.AIPerformanceOracle);
  const [reporter] = await ethers.getSigners();

  const hasRole = await oracle.hasRole(await oracle.REPORTER_ROLE(), reporter.address);
  if (!hasRole) throw new Error(`${reporter.address} does not hold REPORTER_ROLE on ${await oracle.getAddress()}`);

  console.log(`\nPublishing evaluation to ${network.name}`);
  console.log(`  model      ${modelId}`);
  console.log(`  accuracy   ${(report.accuracyBps / 100).toFixed(2)}%`);
  console.log(`  p95 latency ${report.latencyMs} ms`);
  console.log(`  drift      ${(report.driftBps / 100).toFixed(2)}%`);
  console.log(`  generated  ${report.generatedAt}`);
  console.log(`  eval commit ${report.evaluationCommit}`);
  console.log(`  reporter   ${reporter.address}\n`);

  const tx = await oracle.submitReport(modelId, report.accuracyBps, report.latencyMs, report.driftBps);
  const receipt = await tx.wait();
  console.log(`  submitted in block ${receipt.blockNumber} (tx ${receipt.hash})`);

  try {
    const agg = await oracle.latestAggregate(modelId);
    console.log(`  aggregate: round ${agg.roundId}, ${agg.reportCount} report(s), median ${(Number(agg.accuracyBps) / 100).toFixed(2)}%`);
    console.log(`  usable by the marketplace: ${await oracle.isUsable(modelId)}`);
  } catch {
    console.log(`  aggregate: below quorum, waiting for other reporters.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exitCode = 1;
});
