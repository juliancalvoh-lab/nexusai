const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, bondProvider, registerModel, reportAccuracy, attest, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;
const KEY = ethers.id("k");

// regression tests for the auction -> marketplace entitlement link
describe("Exclusive licences", () => {
  async function auctionedFixture() {
    const ctx = await loadFixture(deployFixture);
    await bondProvider(ctx);
    const modelId = await registerModel(ctx, { minAccuracyBps: 0 });
    const collateral = E("50000");

    await ctx.auction
      .connect(ctx.provider)
      .createAuction(modelId, E("10000"), collateral, 2 * DAY, DAY, 180 * DAY, false);
    await ctx.token.connect(ctx.bidderA).approve(await ctx.auction.getAddress(), collateral);

    const salt = ethers.id("bidA");
    await ctx.auction
      .connect(ctx.bidderA)
      .commitBid(1, await ctx.auction.computeCommitment(ctx.bidderA.address, E("20000"), salt));
    await time.increase(2 * DAY + 1);
    await ctx.auction.connect(ctx.bidderA).revealBid(1, E("20000"), salt);
    await time.increase(DAY + 1);
    return { ...ctx, modelId, collateral };
  }

  it("issues a real on-chain entitlement to the auction winner", async () => {
    const ctx = await auctionedFixture();
    await expect(ctx.auction.settle(1)).to.emit(ctx.auction, "ExclusiveLicenceIssued");

    expect(await ctx.marketplace.exclusiveHolder(ctx.modelId)).to.equal(ctx.bidderA.address);
    expect(await ctx.marketplace.hasActiveLicence(ctx.modelId, ctx.bidderA.address)).to.equal(true);
    expect(await ctx.marketplace.exclusiveUntil(ctx.modelId)).to.be.closeTo(
      BigInt(await time.latest()) + BigInt(180 * DAY),
      5n
    );
  });

  it("shuts every other buyer out for the exclusivity term, then reopens", async () => {
    const ctx = await auctionedFixture();
    await ctx.auction.settle(1);
    await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));

    await expect(
      ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY)
    ).to.be.revertedWithCustomError(ctx.marketplace, "ExclusivelyLicensed");

    // The exclusive holder can still transact.
    await ctx.token.connect(ctx.bidderA).approve(await ctx.marketplace.getAddress(), E("100000"));
    await expect(ctx.marketplace.connect(ctx.bidderA).purchaseLicence(ctx.modelId, KEY)).to.emit(
      ctx.marketplace,
      "LicencePurchased"
    );

    await time.increase(181 * DAY);
    await expect(ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY)).to.emit(
      ctx.marketplace,
      "LicencePurchased"
    );
  });

  it("does not brick settlement when the model is unknown to this marketplace", async () => {
    const ctx = await loadFixture(deployFixture);
    const collateral = E("50000");
    await ctx.auction
      .connect(ctx.provider)
      .createAuction(ethers.id("not-listed-here"), E("1000"), collateral, DAY, DAY, 30 * DAY, false);
    await ctx.token.connect(ctx.bidderA).approve(await ctx.auction.getAddress(), collateral);

    const salt = ethers.id("s");
    await ctx.auction
      .connect(ctx.bidderA)
      .commitBid(1, await ctx.auction.computeCommitment(ctx.bidderA.address, E("2000"), salt));
    await time.increase(DAY + 1);
    await ctx.auction.connect(ctx.bidderA).revealBid(1, E("2000"), salt);
    await time.increase(DAY + 1);

    // Money still settles; the failure is surfaced as an event, not a revert.
    await expect(ctx.auction.settle(1)).to.emit(ctx.auction, "ExclusiveLicenceIssuanceFailed");
    expect((await ctx.auction.auctionOf(1)).phase).to.equal(3); // Settled
  });

  it("gates issueExclusiveLicence behind LICENCE_ISSUER_ROLE and rejects unknown models", async () => {
    const ctx = await loadFixture(deployFixture);
    await bondProvider(ctx);
    const modelId = await registerModel(ctx, { minAccuracyBps: 0 });

    await expect(
      ctx.marketplace.connect(ctx.outsider).issueExclusiveLicence(modelId, ctx.outsider.address, 100)
    ).to.be.revertedWithCustomError(ctx.marketplace, "AccessControlUnauthorizedAccount");

    await ctx.marketplace.grantRole(await ctx.marketplace.LICENCE_ISSUER_ROLE(), ctx.deployer.address);
    await expect(
      ctx.marketplace.issueExclusiveLicence(ethers.id("nope"), ctx.outsider.address, 100)
    ).to.be.revertedWithCustomError(ctx.marketplace, "UnknownModel");

    await expect(ctx.marketplace.issueExclusiveLicence(modelId, ctx.buyer.address, 100)).to.emit(
      ctx.marketplace,
      "ExclusiveLicenceIssued"
    );
  });

  it("does not shorten a longer existing licence when granting exclusivity", async () => {
    const ctx = await loadFixture(deployFixture);
    await bondProvider(ctx);
    const modelId = await registerModel(ctx, { minAccuracyBps: 0, licenceTerm: 365 * DAY });
    await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));
    await ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY);
    const longExpiry = await ctx.marketplace.licenceExpiry(modelId, ctx.buyer.address);

    await ctx.marketplace.grantRole(await ctx.marketplace.LICENCE_ISSUER_ROLE(), ctx.deployer.address);
    await ctx.marketplace.issueExclusiveLicence(modelId, ctx.buyer.address, 10 * DAY);

    expect(await ctx.marketplace.licenceExpiry(modelId, ctx.buyer.address)).to.equal(longExpiry);
  });

  it("re-checks the model's own compliance gate when issuing", async () => {
    const ctx = await loadFixture(deployFixture);
    await bondProvider(ctx);
    const modelId = await registerModel(ctx, { minAccuracyBps: 0, requiresCompliance: true });
    await ctx.marketplace.grantRole(await ctx.marketplace.LICENCE_ISSUER_ROLE(), ctx.deployer.address);

    // the auction's compliance flag is set by the seller and is separate from the model's
    await expect(
      ctx.marketplace.issueExclusiveLicence(modelId, ctx.buyer.address, 100)
    ).to.be.revertedWithCustomError(ctx.marketplace, "NotCompliant");

    await attest(ctx, ctx.buyer);
    await expect(ctx.marketplace.issueExclusiveLicence(modelId, ctx.buyer.address, 100)).to.emit(
      ctx.marketplace,
      "ExclusiveLicenceIssued"
    );
  });

  it("lets the auction admin rewire or unset the marketplace link", async () => {
    const ctx = await loadFixture(deployFixture);
    await expect(ctx.auction.setMarketplace(ethers.ZeroAddress)).to.emit(ctx.auction, "MarketplaceUpdated");
    expect(await ctx.auction.marketplace()).to.equal(ethers.ZeroAddress);
    await expect(
      ctx.auction.connect(ctx.outsider).setMarketplace(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(ctx.auction, "AccessControlUnauthorizedAccount");
  });
});

describe("CrossChainRegistry fee sweep", () => {
  it("recovers pre-funded native currency to a nominated address", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.deployer.sendTransaction({ to: await ctx.hubRegistry.getAddress(), value: E("2") });
    await expect(ctx.hubRegistry.sweep(ctx.outsider.address)).to.changeEtherBalance(ctx.outsider, E("2"));
    await expect(ctx.hubRegistry.sweep(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      ctx.hubRegistry,
      "ZeroAddress"
    );
    await expect(ctx.hubRegistry.connect(ctx.outsider).sweep(ctx.outsider.address)).to.be.revertedWithCustomError(
      ctx.hubRegistry,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("reverts when the recipient rejects the transfer", async () => {
    const ctx = await loadFixture(deployFixture);
    await ctx.deployer.sendTransaction({ to: await ctx.hubRegistry.getAddress(), value: E("1") });
    // The marketplace has no receive/fallback, so the low-level call fails.
    await expect(ctx.hubRegistry.sweep(await ctx.marketplace.getAddress())).to.be.revertedWithCustomError(
      ctx.hubRegistry,
      "SweepFailed"
    );
  });
});

describe("Mirror sovereignty", () => {
  it("does not re-list a model that this chain's governance has delisted", async () => {
    const ctx = await loadFixture(deployFixture);
    await bondProvider(ctx);
    const modelId = await registerModel(ctx);
    await reportAccuracy(ctx, modelId, 9600);

    const relay = async (t) => {
      const r = await t.wait();
      const ev = r.logs
        .map((l) => {
          try {
            return ctx.hubRouter.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "MessageSent");
      await ctx.spokeRouter.relayIn(
        ctx.CONFIG.hubSelector,
        ev.args.sender,
        ev.args.nonce,
        ev.args.receiver,
        ev.args.payload
      );
    };

    await relay(await ctx.hubRegistry.publishModel(modelId, ctx.CONFIG.spokeSelector, { value: E("1") }));
    const listedAt = (await ctx.spokeMarketplace.modelOf(modelId)).listedAt;

    // The spoke's own governance takes it down (e.g. a local legal order).
    await ctx.spokeMarketplace.delistModel(modelId, "local jurisdictional takedown");
    expect((await ctx.spokeMarketplace.modelOf(modelId)).active).to.equal(false);

    // A subsequent hub mirror must not quietly re-list it or rewrite its history.
    await time.increase(DAY);
    await relay(await ctx.hubRegistry.publishModel(modelId, ctx.CONFIG.spokeSelector, { value: E("1") }));
    const after = await ctx.spokeMarketplace.modelOf(modelId);
    expect(after.active).to.equal(false);
    expect(after.listedAt).to.equal(listedAt);
  });
});
