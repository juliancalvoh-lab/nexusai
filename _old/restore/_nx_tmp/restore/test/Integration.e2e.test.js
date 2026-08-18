const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, bondProvider, registerModel, reportAccuracy, attest, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;
const KEY_REF = ethers.id("ipfs://encrypted-key");

describe("End-to-end platform flows", () => {
  // the full happy path: bond, list, oracle, compliance, purchase, escrow, mirror, staking
  it("carries a model from listing to cross-chain entitlement and pays everyone correctly", async () => {
    const ctx = await loadFixture(deployFixture);

    // 1. Provider bonds locked capital.
    await bondProvider(ctx, ctx.provider, E("50000"), 2);
    expect((await ctx.vault.bondOf(ctx.provider.address))[0]).to.equal(E("50000"));

    // 2. Provider lists the phishing-detection model with a 90% accuracy floor.
    const modelId = await registerModel(ctx, { requiresCompliance: true, minAccuracyBps: 9000 });

    // 3. The oracle committee publishes the evaluation harness result.
    await reportAccuracy(ctx, modelId, 9600, 12, 250);
    const agg = await ctx.oracle.latestAggregate(modelId);
    expect(agg.accuracyBps).to.equal(9600);

    // 4. The buyer is attested by an accredited compliance provider.
    const { leafA, proofForA } = await attest(ctx, ctx.buyer, 840);
    expect(await ctx.compliance.verifyAttribute(ctx.buyer.address, leafA, proofForA)).to.equal(true);

    // 5. Purchase.
    await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("10000"));
    const tx = await ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF);
    const receipt = await tx.wait();
    const purchaseId = receipt.logs
      .map((l) => {
        try {
          return ctx.marketplace.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "LicencePurchased").args.purchaseId;

    expect(await ctx.marketplace.hasActiveLicence(modelId, ctx.buyer.address)).to.equal(true);

    // 6. Mirror both the listing and the entitlement onto the spoke chain.
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
      await ctx.hubRouter.acknowledge(ev.args.messageId);
    };

    await relay(await ctx.hubRegistry.publishModel(modelId, ctx.CONFIG.spokeSelector, { value: E("1") }));
    await relay(
      await ctx.hubRegistry.publishLicence(modelId, ctx.buyer.address, ctx.CONFIG.spokeSelector, { value: E("1") })
    );
    expect(await ctx.spokeMarketplace.hasActiveLicence(modelId, ctx.buyer.address)).to.equal(true);

    // 7. Escrow matures and the provider is paid.
    await time.increase(8 * DAY);
    await expect(ctx.marketplace.releaseEscrow(purchaseId)).to.changeTokenBalance(ctx.token, ctx.provider, E("950"));

    // 8. Treasury fee funds staking yield, which the bonded provider now earns.
    await ctx.token.approve(await ctx.vault.getAddress(), E("10000"));
    await ctx.vault.fundRewards(E("10000"), 30 * DAY);
    await time.increase(15 * DAY);
    expect(await ctx.vault.earned(ctx.provider.address)).to.be.gt(0);
  });

  it("punishes a provider who misrepresents a model: gate closes, dispute refunds, bond is slashed", async () => {
    const ctx = await loadFixture(deployFixture);
    await bondProvider(ctx, ctx.provider, E("50000"), 2);
    const modelId = await registerModel(ctx, { minAccuracyBps: 9000 });
    await reportAccuracy(ctx, modelId, 9600);

    await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("10000"));
    const receipt = await (await ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)).wait();
    const purchaseId = receipt.logs
      .map((l) => {
        try {
          return ctx.marketplace.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "LicencePurchased").args.purchaseId;

    // Independent re-evaluation shows the model is far worse than claimed.
    await ctx.oracle.connect(ctx.reporter1).submitReport(modelId, 6000, 12, 4000);
    await ctx.oracle.connect(ctx.reporter2).submitReport(modelId, 6100, 12, 4100);
    expect(await ctx.oracle.circuitBroken(modelId)).to.equal(true);

    // The gate is closed to new buyers.
    await expect(
      ctx.marketplace.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)
    ).to.be.revertedWithCustomError(ctx.marketplace, "OracleUnusable");

    // The existing buyer disputes and is refunded the provider share.
    await ctx.marketplace.connect(ctx.buyer).openDispute(purchaseId, "accuracy far below the declared floor");
    await expect(ctx.marketplace.resolveDispute(purchaseId, true)).to.changeTokenBalance(
      ctx.token,
      ctx.buyer,
      E("950")
    );

    // Governance delists and slashes the bond.
    await ctx.marketplace.delistModel(modelId, "misrepresented accuracy");
    await ctx.vault.slash(ctx.provider.address, 2000, "misrepresented accuracy");
    expect(await ctx.vault.stakedOf(ctx.provider.address)).to.equal(E("40000"));
    expect((await ctx.marketplace.modelOf(modelId)).active).to.equal(false);
  });

  it("resists a reentrant payment token on the purchase path", async () => {
    const ctx = await loadFixture(deployFixture);

    const Hostile = await ethers.getContractFactory("ReentrantToken");
    const hostile = await Hostile.deploy();
    await hostile.mint(ctx.buyer.address, E("1000000"));

    const Marketplace = await ethers.getContractFactory("AIModelMarketplace");
    const victim = await Marketplace.deploy(
      await hostile.getAddress(),
      await ctx.oracle.getAddress(),
      await ctx.compliance.getAddress(),
      await ctx.vault.getAddress(),
      ctx.deployer.address,
      ctx.deployer.address
    );
    await victim.setParameters(500, 3000, 7 * DAY, 0, 0);

    const modelId = await (async () => {
      const r = await (
        await victim
          .connect(ctx.provider)
          .registerModel("ipfs://hostile", ethers.id("w"), E("100"), 0, 30 * DAY, false)
      ).wait();
      return r.logs
        .map((l) => {
          try {
            return victim.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ModelRegistered").args.modelId;
    })();

    await hostile.connect(ctx.buyer).approve(await victim.getAddress(), E("100000"));
    await hostile.arm(await victim.getAddress(), modelId);

    await expect(victim.connect(ctx.buyer).purchaseLicence(modelId, KEY_REF)).to.be.revertedWithCustomError(
      victim,
      "ReentrancyGuardReentrantCall"
    );
  });

  it("keeps the sealed-bid auction private until reveal, then settles to the true high bidder", async () => {
    const ctx = await loadFixture(deployFixture);
    const collateral = E("50000");
    await ctx.auction.connect(ctx.provider).createAuction(
      ethers.id("exclusive-licence"),
      E("10000"),
      collateral,
      2 * DAY,
      DAY,
      365 * DAY,
      false
    );
    for (const b of [ctx.bidderA, ctx.bidderB]) {
      await ctx.token.connect(b).approve(await ctx.auction.getAddress(), collateral);
    }

    const bids = [
      { signer: ctx.bidderA, amount: E("18000"), salt: ethers.id("A") },
      { signer: ctx.bidderB, amount: E("31000"), salt: ethers.id("B") },
    ];
    for (const b of bids) {
      const c = await ctx.auction.computeCommitment(b.signer.address, b.amount, b.salt);
      await ctx.auction.connect(b.signer).commitBid(1, c);
    }

    // Nothing about the amounts is observable on-chain during the commit phase.
    const a = await ctx.auction.bidOf(1, ctx.bidderA.address);
    const b = await ctx.auction.bidOf(1, ctx.bidderB.address);
    expect(a.deposit).to.equal(b.deposit);
    expect(a.revealedAmount).to.equal(0);
    expect(b.revealedAmount).to.equal(0);

    await time.increase(2 * DAY + 1);
    for (const bid of bids) {
      await ctx.auction.connect(bid.signer).revealBid(1, bid.amount, bid.salt);
    }
    await time.increase(DAY + 1);

    const sellerBefore = await ctx.token.balanceOf(ctx.provider.address);
    await ctx.auction.settle(1);
    expect(await ctx.token.balanceOf(ctx.provider.address)).to.equal(sellerBefore + E("31000"));
    expect((await ctx.auction.auctionOf(1)).highBidder).to.equal(ctx.bidderB.address);

    await expect(ctx.auction.connect(ctx.bidderA).withdrawCollateral(1)).to.changeTokenBalance(
      ctx.token,
      ctx.bidderA,
      collateral
    );
  });

  it("holds an access-control matrix: no privileged entry point is open to the public", async () => {
    const ctx = await loadFixture(deployFixture);
    const o = ctx.outsider;
    const calls = [
      [ctx.token, "mint", [o.address, 1n]],
      [ctx.token, "setEmissionCeiling", [1n]],
      [ctx.vault, "fundRewards", [1n, 1n]],
      [ctx.vault, "slash", [o.address, 100, "x"]],
      [ctx.vault, "configureTier", [0, 1, 1, true]],
      [ctx.vault, "setTreasury", [o.address]],
      [ctx.vault, "pause", []],
      [ctx.oracle, "addReporter", [o.address]],
      [ctx.oracle, "removeReporter", [o.address]],
      [ctx.oracle, "setParameters", [1, 1, 1]],
      [ctx.oracle, "clearCircuit", [ethers.id("m")]],
      [ctx.oracle, "submitReport", [ethers.id("m"), 1, 1, 1]],
      [ctx.compliance, "attest", [o.address, ethers.id("r"), 1, 99999999999n]],
      [ctx.compliance, "setBlockedJurisdiction", [1, true]],
      [ctx.compliance, "setDenied", [o.address, true, "x"]],
      [ctx.marketplace, "delistModel", [ethers.id("m"), "x"]],
      [ctx.marketplace, "setParameters", [1, 1, 1, 1, 1]],
      [ctx.marketplace, "pause", []],
      [ctx.marketplace, "resolveDispute", [ethers.id("p"), true]],
      [ctx.marketplace, "mirrorLicence", [ethers.id("m"), o.address, 1, 1]],
      [ctx.auction, "setNoRevealPenalty", [100]],
      [ctx.auction, "setCompliance", [o.address]],
      [ctx.hubRegistry, "setTrustedRemote", [1, o.address]],
      [ctx.hubRegistry, "setRouter", [o.address]],
      [ctx.hubRegistry, "publishModel", [ethers.id("m"), 1]],
      [ctx.hubRouter, "setBaseFee", [1]],
      [ctx.hubRouter, "setPeerRouter", [1, o.address]],
      [ctx.hubRouter, "withdrawFees", [o.address]],
    ];

    for (const [contract, fn, args] of calls) {
      await expect(contract.connect(o)[fn](...args), `${fn} should be permissioned`).to.be.revertedWithCustomError(
        contract,
        "AccessControlUnauthorizedAccount"
      );
    }
  });

  it("survives a governance takeover attempt via borrowed voting power", async () => {
    const ctx = await loadFixture(deployFixture);
    const timelockAddr = await ctx.timelock.getAddress();
    await ctx.timelock.grantRole(await ctx.timelock.PROPOSER_ROLE(), await ctx.governor.getAddress());
    await ctx.timelock.grantRole(await ctx.timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await ctx.marketplace.grantRole(await ctx.marketplace.MARKET_ADMIN_ROLE(), timelockAddr);
    await ctx.token.delegate(ctx.deployer.address);
    await mine();

    const calldata = ctx.marketplace.interface.encodeFunctionData("pause", []);
    const proposalId = await (async () => {
      const r = await (
        await ctx.governor.propose([await ctx.marketplace.getAddress()], [0], [calldata], "takeover test")
      ).wait();
      return r.logs
        .map((l) => {
          try {
            return ctx.governor.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === "ProposalCreated").args.proposalId;
    })();

    await time.increase(DAY + 1);
    // Attacker acquires an enormous balance after the snapshot.
    await ctx.token.transfer(ctx.outsider.address, E("100000000"));
    await ctx.token.connect(ctx.outsider).delegate(ctx.outsider.address);
    await mine();
    await ctx.governor.connect(ctx.outsider).castVote(proposalId, 1);

    expect((await ctx.governor.proposalVotes(proposalId)).forVotes).to.equal(0);
  });
});
