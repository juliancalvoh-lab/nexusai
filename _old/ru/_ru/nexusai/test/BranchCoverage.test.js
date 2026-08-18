const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, bondProvider, registerModel, reportAccuracy, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;
const Z = ethers.ZeroAddress;

// walks every clause of the multi-part validation checks
describe("Branch coverage: validation clauses", () => {
  describe("AIModelMarketplace constructor", () => {
    it("rejects a zero value in each dependency slot independently", async () => {
      const ctx = await loadFixture(deployFixture);
      const M = await ethers.getContractFactory("AIModelMarketplace");
      const good = [
        await ctx.token.getAddress(),
        await ctx.oracle.getAddress(),
        await ctx.compliance.getAddress(),
        await ctx.vault.getAddress(),
        ctx.deployer.address,
        ctx.deployer.address,
      ];
      for (let i = 0; i < good.length; i++) {
        const args = [...good];
        args[i] = Z;
        await expect(M.deploy(...args), `slot ${i}`).to.be.revertedWithCustomError(M, "ZeroAddress");
      }
    });

    it("rejects a zero value in each setDependencies slot independently", async () => {
      const ctx = await loadFixture(deployFixture);
      const good = [
        await ctx.oracle.getAddress(),
        await ctx.compliance.getAddress(),
        await ctx.vault.getAddress(),
        ctx.deployer.address,
      ];
      for (let i = 0; i < good.length; i++) {
        const args = [...good];
        args[i] = Z;
        await expect(ctx.marketplace.setDependencies(...args), `slot ${i}`).to.be.revertedWithCustomError(
          ctx.marketplace,
          "ZeroAddress"
        );
      }
    });
  });

  describe("SealedBidLicenceAuction", () => {
    it("rejects a zero admin", async () => {
      const ctx = await loadFixture(deployFixture);
      const A = await ethers.getContractFactory("SealedBidLicenceAuction");
      await expect(
        A.deploy(await ctx.token.getAddress(), await ctx.compliance.getAddress(), Z)
      ).to.be.revertedWithCustomError(A, "ZeroAddress");
    });

    it("lets an auction admin cancel a seller's auction", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.auction.connect(ctx.provider).createAuction(ethers.id("m"), E("1"), E("1"), DAY, DAY, DAY, false);
      await expect(ctx.auction.cancelAuction(1, "admin cancellation")).to.emit(ctx.auction, "AuctionCancelled");
    });

    it("returns collateral in full after a cancellation, no no-reveal penalty", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.auction.connect(ctx.provider).createAuction(ethers.id("m"), E("1"), E("100"), DAY, DAY, DAY, false);
      await ctx.token.connect(ctx.bidderA).approve(await ctx.auction.getAddress(), E("100"));
      await ctx.auction.connect(ctx.bidderA).commitBid(1, ethers.id("c"));
      await ctx.auction.connect(ctx.provider).cancelAuction(1, "changed our mind");
      await expect(ctx.auction.connect(ctx.bidderA).withdrawCollateral(1)).to.changeTokenBalance(
        ctx.token,
        ctx.bidderA,
        E("100")
      );
    });

    it("handles a zero no-reveal penalty", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.auction.setNoRevealPenalty(0);
      await ctx.auction.connect(ctx.provider).createAuction(ethers.id("m"), E("1"), E("100"), DAY, DAY, DAY, false);
      await ctx.token.connect(ctx.bidderA).approve(await ctx.auction.getAddress(), E("100"));
      await ctx.auction.connect(ctx.bidderA).commitBid(1, ethers.id("c"));
      await time.increase(2 * DAY + 2);
      await ctx.auction.settle(1);
      await expect(ctx.auction.connect(ctx.bidderA).withdrawCollateral(1)).to.changeTokenBalance(
        ctx.token,
        ctx.bidderA,
        E("100")
      );
    });

    it("pays no refund when the winner bids exactly the collateral", async () => {
      const ctx = await loadFixture(deployFixture);
      const collateral = E("100");
      await ctx.auction.connect(ctx.provider).createAuction(ethers.id("m"), E("1"), collateral, DAY, DAY, DAY, false);
      await ctx.token.connect(ctx.bidderA).approve(await ctx.auction.getAddress(), collateral);
      const salt = ethers.id("s");
      await ctx.auction
        .connect(ctx.bidderA)
        .commitBid(1, await ctx.auction.computeCommitment(ctx.bidderA.address, collateral, salt));
      await time.increase(DAY + 1);
      await ctx.auction.connect(ctx.bidderA).revealBid(1, collateral, salt);
      await time.increase(DAY + 1);
      await expect(ctx.auction.settle(1)).to.changeTokenBalance(ctx.token, ctx.provider, collateral);
    });
  });

  describe("AIModelMarketplace fee edge cases", () => {
    it("handles a zero protocol fee, nothing burned and nothing sent to the treasury", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.marketplace.setParameters(0, 0, 7 * DAY, E("10000"), 90 * DAY);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx, { minAccuracyBps: 0 });
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("10000"));

      const supplyBefore = await ctx.token.totalSupply();
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, ethers.id("k"));
      expect(await ctx.token.totalSupply()).to.equal(supplyBefore);
      expect(await ctx.token.balanceOf(await ctx.marketplace.getAddress())).to.equal(E("1000"));
    });

    it("handles a fee that is burned in full", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.marketplace.setParameters(1000, 10000, 7 * DAY, E("10000"), 90 * DAY);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx, { minAccuracyBps: 0 });
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("10000"));

      const supplyBefore = await ctx.token.totalSupply();
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, ethers.id("k"));
      expect(await ctx.token.totalSupply()).to.equal(supplyBefore - E("100"));
    });

    it("allows listing with no bond requirement at all (spoke configuration)", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.marketplace.setParameters(500, 3000, 7 * DAY, 0, 0);
      const modelId = await registerModel(ctx, { signer: ctx.outsider });
      expect((await ctx.marketplace.modelOf(modelId)).provider).to.equal(ctx.outsider.address);
    });
  });

  describe("StakingVault edge cases", () => {
    it("handles a full unstake down to zero weight", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx, ctx.provider, E("1000"), 1);
      await time.increase(91 * DAY);
      await ctx.vault.connect(ctx.provider).unstake(E("1000"));
      expect(await ctx.vault.totalWeight()).to.equal(0);
      expect(await ctx.vault.stakedOf(ctx.provider.address)).to.equal(0);
    });

    it("keeps accruing correctly after the reward period finishes", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx, ctx.provider, E("1000"), 0);
      await ctx.token.approve(await ctx.vault.getAddress(), E("1000"));
      await ctx.vault.fundRewards(E("1000"), 10 * DAY);
      await time.increase(20 * DAY);
      const earnedAtEnd = await ctx.vault.earned(ctx.provider.address);
      await time.increase(10 * DAY);
      expect(await ctx.vault.earned(ctx.provider.address)).to.equal(earnedAtEnd);
    });

    it("slashing an account with no rewards accrued still settles cleanly", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx, ctx.provider, E("1000"), 2);
      await expect(ctx.vault.slash(ctx.provider.address, 3000, "max slash")).to.emit(ctx.vault, "Slashed");
      expect(await ctx.vault.stakedOf(ctx.provider.address)).to.equal(E("700"));
    });
  });

  describe("AIPerformanceOracle edge cases", () => {
    it("aggregates with a single-reporter quorum", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.setParameters(1, DAY, 1500);
      await ctx.oracle.connect(ctx.reporter1).submitReport(ethers.id("m"), 9000, 10, 100);
      expect((await ctx.oracle.latestAggregate(ethers.id("m"))).accuracyBps).to.equal(9000);
    });

    it("tolerates a zero staleness cutoff at genesis timestamps", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.setParameters(1, 10 ** 9, 1500);
      await ctx.oracle.connect(ctx.reporter1).submitReport(ethers.id("m"), 9000, 10, 100);
      expect(await ctx.oracle.isUsable(ethers.id("m"))).to.equal(true);
    });

    it("removing the last reporter in the set works", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.oracle.removeReporter(ctx.reporter3.address);
      await ctx.oracle.removeReporter(ctx.reporter2.address);
      await ctx.oracle.removeReporter(ctx.reporter1.address);
      expect(await ctx.oracle.reporterCount()).to.equal(0);
    });
  });

  describe("CrossChainRegistry edge cases", () => {
    it("rejects a zero admin at construction", async () => {
      const ctx = await loadFixture(deployFixture);
      const R = await ethers.getContractFactory("CrossChainRegistry");
      await expect(
        R.deploy(await ctx.hubRouter.getAddress(), await ctx.marketplace.getAddress(), 1, Z)
      ).to.be.revertedWithCustomError(R, "ZeroAddress");
    });

    it("rejects an inbound message whose source chain has no trusted remote at all", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.spokeRegistry.setRouter(ctx.deployer.address);
      await expect(
        ctx.spokeRegistry.ccReceive(999999, ctx.deployer.address, 1, "0x")
      ).to.be.revertedWithCustomError(ctx.spokeRegistry, "UntrustedRemote");
    });

    it("accepts ether so a relayer can pre-fund outbound message fees", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.deployer.sendTransaction({ to: await ctx.hubRegistry.getAddress(), value: E("1") })
      ).to.not.be.reverted;
    });
  });

  describe("NexusAIToken epoch rolling", () => {
    it("rolls forward across several missed epochs in one step", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.token.mint(ctx.buyer.address, E("1000000"));
      const firstStart = await ctx.token.epochStart();
      await time.increase(95 * DAY);
      await ctx.token.mint(ctx.buyer.address, E("1"));
      const newStart = await ctx.token.epochStart();
      expect((newStart - firstStart) % BigInt(30 * DAY)).to.equal(0n);
      expect(newStart).to.be.gt(firstStart);
    });
  });
});
