const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, DAY } = require("./helpers/fixtures");

const MODEL = ethers.id("phishguard-v1");

describe("AIPerformanceOracle", () => {
  describe("deployment & configuration", () => {
    it("stores the initial parameters", async () => {
      const { oracle, CONFIG } = await loadFixture(deployFixture);
      expect(await oracle.minQuorum()).to.equal(CONFIG.oracle.minQuorum);
      expect(await oracle.stalenessWindow()).to.equal(CONFIG.oracle.staleness);
      expect(await oracle.maxDeviationBps()).to.equal(CONFIG.oracle.maxDeviationBps);
      expect(await oracle.reporterCount()).to.equal(3);
    });

    it("rejects invalid constructor arguments", async () => {
      const Oracle = await ethers.getContractFactory("AIPerformanceOracle");
      const [deployer] = await ethers.getSigners();
      await expect(Oracle.deploy(ethers.ZeroAddress, 3, DAY, 1500)).to.be.revertedWithCustomError(
        Oracle,
        "ZeroAddress"
      );
      await expect(Oracle.deploy(deployer.address, 0, DAY, 1500)).to.be.revertedWithCustomError(
        Oracle,
        "InvalidQuorum"
      );
      await expect(Oracle.deploy(deployer.address, 3, DAY, 10001)).to.be.revertedWithCustomError(
        Oracle,
        "InvalidBps"
      );
    });

    it("adds and removes reporters", async () => {
      const { oracle, outsider, reporter1 } = await loadFixture(deployFixture);
      await expect(oracle.addReporter(outsider.address)).to.emit(oracle, "ReporterAdded");
      expect(await oracle.reporterCount()).to.equal(4);
      await expect(oracle.addReporter(outsider.address)).to.be.revertedWithCustomError(oracle, "AlreadyReporter");
      await expect(oracle.addReporter(ethers.ZeroAddress)).to.be.revertedWithCustomError(oracle, "ZeroAddress");

      await expect(oracle.removeReporter(reporter1.address)).to.emit(oracle, "ReporterRemoved");
      expect(await oracle.reporterCount()).to.equal(3);
      expect(await oracle.hasRole(await oracle.REPORTER_ROLE(), reporter1.address)).to.equal(false);
      await expect(oracle.removeReporter(reporter1.address)).to.be.revertedWithCustomError(oracle, "NotReporter");
    });

    it("enforces the reporter-set upper bound", async () => {
      const { oracle } = await loadFixture(deployFixture);
      const max = Number(await oracle.MAX_REPORTERS());
      for (let i = 3; i < max; i++) {
        await oracle.addReporter(ethers.Wallet.createRandom().address);
      }
      await expect(oracle.addReporter(ethers.Wallet.createRandom().address)).to.be.revertedWithCustomError(
        oracle,
        "TooManyReporters"
      );
    });

    it("updates parameters with validation", async () => {
      const { oracle } = await loadFixture(deployFixture);
      await expect(oracle.setParameters(2, 3600, 500)).to.emit(oracle, "ParametersUpdated");
      expect(await oracle.minQuorum()).to.equal(2);
      await expect(oracle.setParameters(0, 3600, 500)).to.be.revertedWithCustomError(oracle, "InvalidQuorum");
      await expect(oracle.setParameters(2, 3600, 10001)).to.be.revertedWithCustomError(oracle, "InvalidBps");
    });

    it("gates reporter management behind ORACLE_ADMIN_ROLE", async () => {
      const { oracle, outsider } = await loadFixture(deployFixture);
      await expect(oracle.connect(outsider).addReporter(outsider.address)).to.be.revertedWithCustomError(
        oracle,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("reporting & aggregation", () => {
    it("withholds an aggregate until quorum is reached", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 9500, 10, 100);
      await ctx.oracle.connect(ctx.reporter2).submitReport(MODEL, 9400, 12, 120);
      await expect(ctx.oracle.latestAggregate(MODEL)).to.be.revertedWithCustomError(ctx.oracle, "NoAggregate");
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(false);

      await expect(ctx.oracle.connect(ctx.reporter3).submitReport(MODEL, 9600, 11, 110)).to.emit(
        ctx.oracle,
        "AggregateUpdated"
      );
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(true);
    });

    it("publishes the median, not the mean, so one liar cannot move it", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 9500, 10, 100);
      await ctx.oracle.connect(ctx.reporter2).submitReport(MODEL, 9550, 12, 120);
      await ctx.oracle.connect(ctx.reporter3).submitReport(MODEL, 100, 9999, 9999); // malicious outlier

      const agg = await ctx.oracle.latestAggregate(MODEL);
      expect(agg.accuracyBps).to.equal(9500); // median of [100, 9500, 9550]
      expect(agg.reportCount).to.equal(3);
      expect(agg.roundId).to.equal(1);
    });

    it("averages the two middle values on an even reporter count", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.addReporter(ctx.outsider.address);
      await ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 9000, 10, 100);
      await ctx.oracle.connect(ctx.reporter2).submitReport(MODEL, 9100, 10, 100);
      await ctx.oracle.connect(ctx.reporter3).submitReport(MODEL, 9200, 10, 100);
      await ctx.oracle.connect(ctx.outsider).submitReport(MODEL, 9300, 10, 100);
      const agg = await ctx.oracle.latestAggregate(MODEL);
      expect(agg.accuracyBps).to.equal(9150);
    });

    it("increments the round on each successful aggregation", async () => {
      const ctx = await loadFixture(deployFixture);
      for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
        await ctx.oracle.connect(r).submitReport(MODEL, 9500, 10, 100);
      }
      expect((await ctx.oracle.latestAggregate(MODEL)).roundId).to.equal(1);
      await ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 9510, 10, 100);
      expect((await ctx.oracle.latestAggregate(MODEL)).roundId).to.equal(2);
    });

    it("rejects out-of-range values and non-reporters", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 10001, 10, 100)
      ).to.be.revertedWithCustomError(ctx.oracle, "InvalidBps");
      await expect(
        ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 9000, 10, 10001)
      ).to.be.revertedWithCustomError(ctx.oracle, "InvalidBps");
      await expect(
        ctx.oracle.connect(ctx.outsider).submitReport(MODEL, 9000, 10, 100)
      ).to.be.revertedWithCustomError(ctx.oracle, "AccessControlUnauthorizedAccount");
    });

    it("stores the individual report for audit", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 9500, 42, 100);
      const r = await ctx.oracle.reportOf(MODEL, ctx.reporter1.address);
      expect(r.accuracyBps).to.equal(9500);
      expect(r.latencyMs).to.equal(42);
      expect(r.ts).to.be.gt(0);
    });
  });

  describe("staleness", () => {
    it("stops being usable once every report ages past the window", async () => {
      const ctx = await loadFixture(deployFixture);
      for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
        await ctx.oracle.connect(r).submitReport(MODEL, 9500, 10, 100);
      }
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(true);
      await time.increase(2 * DAY);
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(false);
    });

    it("ignores stale reports when re-aggregating, leaving the prior value intact", async () => {
      const ctx = await loadFixture(deployFixture);
      for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
        await ctx.oracle.connect(r).submitReport(MODEL, 9500, 10, 100);
      }
      const round1 = (await ctx.oracle.latestAggregate(MODEL)).roundId;

      await time.increase(2 * DAY);
      // only one fresh report, below quorum so no new aggregate is written
      await ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 5000, 10, 100);
      const agg = await ctx.oracle.latestAggregate(MODEL);
      expect(agg.roundId).to.equal(round1);
      expect(agg.accuracyBps).to.equal(9500);
    });
  });

  describe("circuit breaker", () => {
    it("trips on an anomalous jump and blocks consumption until cleared", async () => {
      const ctx = await loadFixture(deployFixture);
      for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
        await ctx.oracle.connect(r).submitReport(MODEL, 9500, 10, 100);
      }
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(true);

      // 9500 -> 7000 is a 2500 bps move, above the 1500 bps tolerance
      await expect(ctx.oracle.connect(ctx.reporter1).submitReport(MODEL, 7000, 10, 100)).to.not.emit(
        ctx.oracle,
        "CircuitBroken"
      );
      // the second one flips the median, so now it trips
      await expect(ctx.oracle.connect(ctx.reporter2).submitReport(MODEL, 7000, 10, 100)).to.emit(
        ctx.oracle,
        "CircuitBroken"
      );

      expect(await ctx.oracle.circuitBroken(MODEL)).to.equal(true);
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(false);

      await expect(ctx.oracle.clearCircuit(MODEL)).to.emit(ctx.oracle, "CircuitCleared");
      expect(await ctx.oracle.isUsable(MODEL)).to.equal(true);
    });

    it("does not trip on a move inside the tolerance", async () => {
      const ctx = await loadFixture(deployFixture);
      for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
        await ctx.oracle.connect(r).submitReport(MODEL, 9500, 10, 100);
      }
      for (const r of [ctx.reporter1, ctx.reporter2, ctx.reporter3]) {
        await ctx.oracle.connect(r).submitReport(MODEL, 9000, 10, 100);
      }
      expect(await ctx.oracle.circuitBroken(MODEL)).to.equal(false);
    });

    it("only ORACLE_ADMIN_ROLE can clear the breaker", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.oracle.connect(ctx.outsider).clearCircuit(MODEL)).to.be.revertedWithCustomError(
        ctx.oracle,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("consumer views", () => {
    it("accuracyOf returns zeroes for an unknown model rather than reverting", async () => {
      const ctx = await loadFixture(deployFixture);
      const [acc, ts] = await ctx.oracle.accuracyOf(ethers.id("nope"));
      expect(acc).to.equal(0);
      expect(ts).to.equal(0);
    });
  });
});
