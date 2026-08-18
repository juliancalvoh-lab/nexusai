const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, bondProvider, registerModel, reportAccuracy, attest, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;
const KEY_REF = ethers.id("ipfs://encrypted-licence-key");

// provider bonded, model listed, oracle healthy
async function listedFixture() {
  const ctx = await loadFixture(deployFixture);
  await bondProvider(ctx);
  const modelId = await registerModel(ctx);
  await reportAccuracy(ctx, modelId, 9600);
  await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));
  return { ...ctx, modelId };
}

describe("AIModelMarketplace", () => {
  describe("deployment", () => {
    it("rejects any zero dependency", async () => {
      const ctx = await loadFixture(deployFixture);
      const M = await ethers.getContractFactory("AIModelMarketplace");
      await expect(
        M.deploy(
          ethers.ZeroAddress,
          await ctx.oracle.getAddress(),
          await ctx.compliance.getAddress(),
          await ctx.vault.getAddress(),
          ctx.deployer.address,
          ctx.deployer.address
        )
      ).to.be.revertedWithCustomError(M, "ZeroAddress");
    });

    it("starts with a non-zero provider bond requirement", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.marketplace.minProviderBond()).to.equal(E("10000"));
      expect(await ctx.marketplace.minBondLock()).to.equal(90 * DAY);
    });
  });

  describe("listing", () => {
    it("registers a model and indexes it", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx);

      const m = await ctx.marketplace.modelOf(modelId);
      expect(m.provider).to.equal(ctx.provider.address);
      expect(m.price).to.equal(E("1000"));
      expect(m.minAccuracyBps).to.equal(9000);
      expect(m.active).to.equal(true);
      expect(await ctx.marketplace.modelCount()).to.equal(1);
      expect(await ctx.marketplace.modelIdAt(0)).to.equal(modelId);
    });

    it("refuses a provider with no bond", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(registerModel(ctx)).to.be.revertedWithCustomError(ctx.marketplace, "InsufficientBond");
    });

    it("refuses a bond that is not locked long enough (stake/list/unstake attack)", async () => {
      const ctx = await loadFixture(deployFixture);
      // tier 0 has no lock so it can be withdrawn straight away
      await bondProvider(ctx, ctx.provider, E("50000"), 0);
      await expect(registerModel(ctx)).to.be.revertedWithCustomError(ctx.marketplace, "BondNotLocked");
    });

    it("rejects an accuracy floor above 100%", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx);
      await expect(registerModel(ctx, { minAccuracyBps: 10001 })).to.be.revertedWithCustomError(
        ctx.marketplace,
        "InvalidAccuracy"
      );
    });

    it("lets the provider update price, floor and active flag", async () => {
      const ctx = await listedFixture();
      await expect(ctx.marketplace.connect(ctx.provider).updateModel(ctx.modelId, E("2000"), 9500, true)).to.emit(
        ctx.marketplace,
        "ModelUpdated"
      );
      const m = await ctx.marketplace.modelOf(ctx.modelId);
      expect(m.price).to.equal(E("2000"));
      expect(m.minAccuracyBps).to.equal(9500);
    });

    it("blocks a non-provider from updating, and rejects unknown models", async () => {
      const ctx = await listedFixture();
      await expect(
        ctx.marketplace.connect(ctx.outsider).updateModel(ctx.modelId, E("1"), 1, true)
      ).to.be.revertedWithCustomError(ctx.marketplace, "NotProvider");
      await expect(
        ctx.marketplace.connect(ctx.provider).updateModel(ethers.id("nope"), E("1"), 1, true)
      ).to.be.revertedWithCustomError(ctx.marketplace, "UnknownModel");
      await expect(ctx.marketplace.modelOf(ethers.id("nope"))).to.be.revertedWithCustomError(
        ctx.marketplace,
        "UnknownModel"
      );
    });

    it("lets governance delist", async () => {
      const ctx = await listedFixture();
      await expect(ctx.marketplace.delistModel(ctx.modelId, "proven misrepresentation")).to.emit(
        ctx.marketplace,
        "ModelDelisted"
      );
      expect((await ctx.marketplace.modelOf(ctx.modelId)).active).to.equal(false);
      await expect(ctx.marketplace.delistModel(ethers.id("nope"), "x")).to.be.revertedWithCustomError(
        ctx.marketplace,
        "UnknownModel"
      );
      await expect(
        ctx.marketplace.connect(ctx.outsider).delistModel(ctx.modelId, "x")
      ).to.be.revertedWithCustomError(ctx.marketplace, "AccessControlUnauthorizedAccount");
    });
  });

  describe("purchasing", () => {
    it("splits the fee between burn and treasury, escrows the provider share", async () => {
      const ctx = await listedFixture();
      const supplyBefore = await ctx.token.totalSupply();
      const treasury = await ctx.timelock.getAddress();
      const treasuryBefore = await ctx.token.balanceOf(treasury);

      await expect(ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF)).to.emit(
        ctx.marketplace,
        "LicencePurchased"
      );

      // price 1000, fee 5% = 50, burn 30% of fee = 15, treasury 35, provider 950
      expect(await ctx.token.totalSupply()).to.equal(supplyBefore - E("15"));
      expect(await ctx.token.balanceOf(treasury)).to.equal(treasuryBefore + E("35"));
      expect(await ctx.token.balanceOf(await ctx.marketplace.getAddress())).to.equal(E("950"));
      expect(await ctx.marketplace.grossRevenue(ctx.modelId)).to.equal(E("1000"));
    });

    it("grants a licence with the configured term", async () => {
      const ctx = await listedFixture();
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      expect(await ctx.marketplace.hasActiveLicence(ctx.modelId, ctx.buyer.address)).to.equal(true);
      const expiry = await ctx.marketplace.licenceExpiry(ctx.modelId, ctx.buyer.address);
      expect(expiry).to.be.closeTo(BigInt(await time.latest()) + BigInt(30 * DAY), 5n);
    });

    it("stacks the term on renewal instead of resetting it", async () => {
      const ctx = await listedFixture();
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      const first = await ctx.marketplace.licenceExpiry(ctx.modelId, ctx.buyer.address);
      await time.increase(3600); // stay inside the oracle staleness window
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      expect(await ctx.marketplace.licenceExpiry(ctx.modelId, ctx.buyer.address)).to.equal(
        first + BigInt(30 * DAY)
      );
    });

    it("restarts the term when the previous licence has already lapsed", async () => {
      const ctx = await listedFixture();
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      await time.increase(60 * DAY);
      await reportAccuracy(ctx, ctx.modelId, 9600); // refresh the feed
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      expect(await ctx.marketplace.licenceExpiry(ctx.modelId, ctx.buyer.address)).to.be.closeTo(
        BigInt(await time.latest()) + BigInt(30 * DAY),
        5n
      );
    });

    it("closes the quality gate when the oracle reports below the floor", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx, { minAccuracyBps: 9500 });
      await reportAccuracy(ctx, modelId, 9000);
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));

      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "QualityGateFailed");
    });

    it("closes the gate when the oracle has no quorum, is stale, or is circuit-broken", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx);
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));

      // no reports at all
      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "OracleUnusable");

      // reported, then allowed to go stale
      await reportAccuracy(ctx, modelId, 9600);
      await time.increase(2 * DAY);
      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "OracleUnusable");

      // fresh again, but the breaker is tripped by an anomalous move
      await reportAccuracy(ctx, modelId, 9600);
      await ctx.oracle.connect(ctx.reporter1).submitReport(modelId, 5000, 10, 100);
      await ctx.oracle.connect(ctx.reporter2).submitReport(modelId, 5000, 10, 100);
      expect(await ctx.oracle.circuitBroken(modelId)).to.equal(true);
      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "OracleUnusable");
    });

    it("skips the oracle entirely when the model declares no floor", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx, { minAccuracyBps: 0 });
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));
      await expect(ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)).to.emit(
        ctx.marketplace,
        "LicencePurchased"
      );
    });

    it("enforces the compliance gate when the listing requires it", async () => {
      const ctx = await loadFixture(deployFixture);
      await bondProvider(ctx);
      const modelId = await registerModel(ctx, { requiresCompliance: true, minAccuracyBps: 0 });
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));

      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "NotCompliant");

      await attest(ctx, ctx.buyer);
      await expect(ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)).to.emit(
        ctx.marketplace,
        "LicencePurchased"
      );
    });

    it("rejects unknown, inactive, and paused purchases", async () => {
      const ctx = await listedFixture();
      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(ethers.id("nope"), KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "UnknownModel");

      await ctx.marketplace.connect(ctx.provider).updateModel(ctx.modelId, E("1000"), 9000, false);
      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "ModelInactive");

      await ctx.marketplace.connect(ctx.provider).updateModel(ctx.modelId, E("1000"), 9000, true);
      await ctx.marketplace.pause();
      await expect(
        ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF)
      ).to.be.revertedWithCustomError(ctx.marketplace, "EnforcedPause");
      await ctx.marketplace.unpause();
      await expect(ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF)).to.emit(
        ctx.marketplace,
        "LicencePurchased"
      );
    });
  });

  describe("escrow and disputes", () => {
    async function purchased() {
      const ctx = await listedFixture();
      const tx = await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l) => {
          try {
            return ctx.marketplace.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "LicencePurchased");
      return { ...ctx, purchaseId: ev.args.purchaseId };
    }

    it("holds the provider share until the dispute window closes", async () => {
      const ctx = await purchased();
      await expect(ctx.marketplace.releaseEscrow(ctx.purchaseId)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "EscrowNotMature"
      );
      await time.increase(8 * DAY);
      await expect(ctx.marketplace.releaseEscrow(ctx.purchaseId)).to.changeTokenBalance(
        ctx.token,
        ctx.provider,
        E("950")
      );
      await expect(ctx.marketplace.releaseEscrow(ctx.purchaseId)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "AlreadySettled"
      );
    });

    it("lets the buyer dispute inside the window and refunds on a buyer-favourable ruling", async () => {
      const ctx = await purchased();
      await expect(
        ctx.marketplace.connect(ctx.buyer).openDispute(ctx.purchaseId, "model does not match the weights hash")
      ).to.emit(ctx.marketplace, "DisputeOpened");

      await expect(ctx.marketplace.releaseEscrow(ctx.purchaseId)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "NoOpenDispute"
      );

      await expect(ctx.marketplace.resolveDispute(ctx.purchaseId, true)).to.changeTokenBalance(
        ctx.token,
        ctx.buyer,
        E("950")
      );
      expect(await ctx.marketplace.hasActiveLicence(ctx.modelId, ctx.buyer.address)).to.equal(false);
      const p = await ctx.marketplace.purchaseOf(ctx.purchaseId);
      expect(p.dispute).to.equal(2); // RefundedToBuyer
    });

    it("pays the provider on a provider-favourable ruling", async () => {
      const ctx = await purchased();
      await ctx.marketplace.connect(ctx.buyer).openDispute(ctx.purchaseId, "unhappy");
      await expect(ctx.marketplace.resolveDispute(ctx.purchaseId, false)).to.changeTokenBalance(
        ctx.token,
        ctx.provider,
        E("950")
      );
      const p = await ctx.marketplace.purchaseOf(ctx.purchaseId);
      expect(p.dispute).to.equal(3); // ReleasedToProvider
    });

    it("guards the dispute paths", async () => {
      const ctx = await purchased();
      await expect(
        ctx.marketplace.connect(ctx.outsider).openDispute(ctx.purchaseId, "x")
      ).to.be.revertedWithCustomError(ctx.marketplace, "NotBuyer");
      await expect(
        ctx.marketplace.connect(ctx.buyer).openDispute(ethers.id("nope"), "x")
      ).to.be.revertedWithCustomError(ctx.marketplace, "UnknownPurchase");
      await expect(ctx.marketplace.resolveDispute(ctx.purchaseId, true)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "NoOpenDispute"
      );
      await expect(ctx.marketplace.resolveDispute(ethers.id("nope"), true)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "UnknownPurchase"
      );
      await expect(ctx.marketplace.releaseEscrow(ethers.id("nope"))).to.be.revertedWithCustomError(
        ctx.marketplace,
        "UnknownPurchase"
      );

      await ctx.marketplace.connect(ctx.buyer).openDispute(ctx.purchaseId, "x");
      await expect(
        ctx.marketplace.connect(ctx.outsider).resolveDispute(ctx.purchaseId, true)
      ).to.be.revertedWithCustomError(ctx.marketplace, "AccessControlUnauthorizedAccount");
    });

    it("closes the dispute window on time", async () => {
      const ctx = await purchased();
      await time.increase(8 * DAY);
      await expect(
        ctx.marketplace.connect(ctx.buyer).openDispute(ctx.purchaseId, "too late")
      ).to.be.revertedWithCustomError(ctx.marketplace, "DisputeWindowClosed");
    });

    it("refuses to resolve or dispute a settled purchase", async () => {
      const ctx = await purchased();
      await time.increase(8 * DAY);
      await ctx.marketplace.releaseEscrow(ctx.purchaseId);
      await expect(ctx.marketplace.resolveDispute(ctx.purchaseId, true)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "AlreadySettled"
      );
    });
  });

  describe("parameters", () => {
    it("updates fees within the hard ceiling", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.marketplace.setParameters(1000, 5000, 3 * DAY, E("1"), 30 * DAY)).to.emit(
        ctx.marketplace,
        "ParametersUpdated"
      );
      expect(await ctx.marketplace.protocolFeeBps()).to.equal(1000);
      await expect(ctx.marketplace.setParameters(1001, 5000, 3 * DAY, 0, 0)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "InvalidFee"
      );
      await expect(ctx.marketplace.setParameters(500, 10001, 3 * DAY, 0, 0)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "InvalidFee"
      );
    });

    it("swaps dependencies and rejects zero addresses", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.marketplace.setDependencies(
          await ctx.oracle.getAddress(),
          await ctx.compliance.getAddress(),
          await ctx.vault.getAddress(),
          ctx.deployer.address
        )
      ).to.emit(ctx.marketplace, "DependenciesUpdated");

      await expect(
        ctx.marketplace.setDependencies(
          ethers.ZeroAddress,
          await ctx.compliance.getAddress(),
          await ctx.vault.getAddress(),
          ctx.deployer.address
        )
      ).to.be.revertedWithCustomError(ctx.marketplace, "ZeroAddress");
    });

    it("gates admin functions", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.marketplace.connect(ctx.outsider).pause()).to.be.revertedWithCustomError(
        ctx.marketplace,
        "AccessControlUnauthorizedAccount"
      );
      await expect(
        ctx.marketplace.connect(ctx.outsider).setParameters(1, 1, 1, 1, 1)
      ).to.be.revertedWithCustomError(ctx.marketplace, "AccessControlUnauthorizedAccount");
    });
  });

  describe("cross-chain mirroring authorisation", () => {
    it("rejects mirroring from an account without CROSSCHAIN_ROLE", async () => {
      const ctx = await listedFixture();
      await expect(
        ctx.marketplace.connect(ctx.outsider).mirrorModel({
          modelId: ethers.id("x"),
          provider: ctx.outsider.address,
          price: 1,
          weightsHash: ethers.id("w"),
          metadataURI: "ipfs://",
          minAccuracyBps: 0,
          licenceTerm: 1,
          requiresCompliance: false,
          srcChain: 1,
        })
      ).to.be.revertedWithCustomError(ctx.marketplace, "AccessControlUnauthorizedAccount");
      await expect(
        ctx.marketplace.connect(ctx.outsider).mirrorLicence(ethers.id("x"), ctx.outsider.address, 1, 1)
      ).to.be.revertedWithCustomError(ctx.marketplace, "AccessControlUnauthorizedAccount");
    });
  });
});
