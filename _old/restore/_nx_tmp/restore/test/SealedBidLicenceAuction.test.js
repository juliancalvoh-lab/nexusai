const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, attest, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;
const MODEL = ethers.id("phishguard-exclusive");
const COMMIT_WINDOW = 2 * DAY;
const REVEAL_WINDOW = DAY;
const EXCLUSIVITY_TERM = 365 * DAY;

async function auctionFixture(requiresCompliance = false) {
  const ctx = await loadFixture(deployFixture);
  const collateral = E("50000");
  const tx = await ctx.auction
    .connect(ctx.provider)
    .createAuction(MODEL, E("10000"), collateral, COMMIT_WINDOW, REVEAL_WINDOW, EXCLUSIVITY_TERM, requiresCompliance);
  await tx.wait();
  for (const b of [ctx.bidderA, ctx.bidderB, ctx.outsider]) {
    await ctx.token.connect(b).approve(await ctx.auction.getAddress(), collateral);
  }
  return { ...ctx, auctionId: 1n, collateral };
}

const commitment = (bidder, amount, salt) =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint96", "bytes32"], [bidder, amount, salt])
  );

describe("SealedBidLicenceAuction", () => {
  it("rejects zero-address constructor arguments", async () => {
    const ctx = await loadFixture(deployFixture);
    const A = await ethers.getContractFactory("SealedBidLicenceAuction");
    await expect(
      A.deploy(ethers.ZeroAddress, await ctx.compliance.getAddress(), ctx.deployer.address)
    ).to.be.revertedWithCustomError(A, "ZeroAddress");
    await expect(
      A.deploy(await ctx.token.getAddress(), ethers.ZeroAddress, ctx.deployer.address)
    ).to.be.revertedWithCustomError(A, "ZeroAddress");
  });

  describe("creation", () => {
    it("opens in the commit phase with the configured windows", async () => {
      const ctx = await auctionFixture();
      const a = await ctx.auction.auctionOf(ctx.auctionId);
      expect(a.phase).to.equal(1); // Commit
      expect(a.seller).to.equal(ctx.provider.address);
      expect(a.reservePrice).to.equal(E("10000"));
      expect(a.revealEnd - a.commitEnd).to.equal(BigInt(REVEAL_WINDOW));
    });

    it("rejects zero windows and collateral below the reserve", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.auction.createAuction(MODEL, E("1"), E("1"), 0, DAY, DAY, false)
      ).to.be.revertedWithCustomError(ctx.auction, "BadWindow");
      await expect(
        ctx.auction.createAuction(MODEL, E("1"), E("1"), DAY, 0, DAY, false)
      ).to.be.revertedWithCustomError(ctx.auction, "BadWindow");
      await expect(
        ctx.auction.createAuction(MODEL, E("100"), E("10"), DAY, DAY, DAY, false)
      ).to.be.revertedWithCustomError(ctx.auction, "BadWindow");
    });
  });

  describe("commit phase", () => {
    it("takes a uniform collateral so the deposit leaks nothing about the bid", async () => {
      const ctx = await auctionFixture();
      await expect(
        ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), ethers.id("a")))
      ).to.changeTokenBalance(ctx.token, ctx.bidderA, -ctx.collateral);
      await expect(
        ctx.auction.connect(ctx.bidderB).commitBid(ctx.auctionId, commitment(ctx.bidderB.address, E("40000"), ethers.id("b")))
      ).to.changeTokenBalance(ctx.token, ctx.bidderB, -ctx.collateral);

      expect(await ctx.auction.bidderCount(ctx.auctionId)).to.equal(2);
      const a = await ctx.auction.bidOf(ctx.auctionId, ctx.bidderA.address);
      const b = await ctx.auction.bidOf(ctx.auctionId, ctx.bidderB.address);
      expect(a.deposit).to.equal(b.deposit); // identical on-chain footprint
      expect(a.revealedAmount).to.equal(0);
    });

    it("refuses a second commitment from the same bidder", async () => {
      const ctx = await auctionFixture();
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("c1"));
      await expect(
        ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("c2"))
      ).to.be.revertedWithCustomError(ctx.auction, "AlreadyCommitted");
    });

    it("refuses commits after the window and on unknown auctions", async () => {
      const ctx = await auctionFixture();
      await expect(ctx.auction.connect(ctx.bidderA).commitBid(99, ethers.id("c"))).to.be.revertedWithCustomError(
        ctx.auction,
        "UnknownAuction"
      );
      await time.increase(COMMIT_WINDOW + 1);
      await expect(
        ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("c"))
      ).to.be.revertedWithCustomError(ctx.auction, "CommitClosed");
    });

    it("enforces compliance when the auction requires it", async () => {
      const ctx = await auctionFixture(true);
      await expect(
        ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("c"))
      ).to.be.revertedWithCustomError(ctx.auction, "NotCompliant");
      await attest(ctx, ctx.bidderA);
      await expect(ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("c"))).to.emit(
        ctx.auction,
        "BidCommitted"
      );
    });
  });

  describe("reveal phase", () => {
    it("rejects reveals before the commit window closes", async () => {
      const ctx = await auctionFixture();
      const salt = ethers.id("a");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), salt));
      await expect(
        ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), salt)
      ).to.be.revertedWithCustomError(ctx.auction, "RevealNotOpen");
    });

    it("accepts a matching reveal and tracks the high bid", async () => {
      const ctx = await auctionFixture();
      const sA = ethers.id("a");
      const sB = ethers.id("b");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), sA));
      await ctx.auction.connect(ctx.bidderB).commitBid(ctx.auctionId, commitment(ctx.bidderB.address, E("30000"), sB));
      await time.increase(COMMIT_WINDOW + 1);

      await expect(ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), sA)).to.emit(
        ctx.auction,
        "BidRevealed"
      );
      await ctx.auction.connect(ctx.bidderB).revealBid(ctx.auctionId, E("30000"), sB);

      const a = await ctx.auction.auctionOf(ctx.auctionId);
      expect(a.highBidder).to.equal(ctx.bidderB.address);
      expect(a.highBid).to.equal(E("30000"));
      expect(a.phase).to.equal(2); // Reveal
    });

    it("rejects a mismatched reveal, a double reveal, and a reveal with no commitment", async () => {
      const ctx = await auctionFixture();
      const salt = ethers.id("a");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), salt));
      await time.increase(COMMIT_WINDOW + 1);

      await expect(
        ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("13000"), salt)
      ).to.be.revertedWithCustomError(ctx.auction, "BadReveal");
      await expect(
        ctx.auction.connect(ctx.bidderB).revealBid(ctx.auctionId, E("12000"), salt)
      ).to.be.revertedWithCustomError(ctx.auction, "NoCommitment");

      await ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), salt);
      await expect(
        ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), salt)
      ).to.be.revertedWithCustomError(ctx.auction, "AlreadyRevealed");
    });

    it("rejects a bid above the collateral or below the reserve", async () => {
      const ctx = await auctionFixture();
      const s1 = ethers.id("a");
      const s2 = ethers.id("b");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("60000"), s1));
      await ctx.auction.connect(ctx.bidderB).commitBid(ctx.auctionId, commitment(ctx.bidderB.address, E("500"), s2));
      await time.increase(COMMIT_WINDOW + 1);

      await expect(
        ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("60000"), s1)
      ).to.be.revertedWithCustomError(ctx.auction, "BidExceedsDeposit");
      await expect(
        ctx.auction.connect(ctx.bidderB).revealBid(ctx.auctionId, E("500"), s2)
      ).to.be.revertedWithCustomError(ctx.auction, "BelowReserve");
    });

    it("rejects reveals after the reveal window", async () => {
      const ctx = await auctionFixture();
      const salt = ethers.id("a");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), salt));
      await time.increase(COMMIT_WINDOW + REVEAL_WINDOW + 1);
      await expect(
        ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), salt)
      ).to.be.revertedWithCustomError(ctx.auction, "RevealClosed");
    });

    it("exposes a commitment helper matching the on-chain check", async () => {
      const ctx = await auctionFixture();
      expect(await ctx.auction.computeCommitment(ctx.bidderA.address, E("1"), ethers.id("s"))).to.equal(
        commitment(ctx.bidderA.address, E("1"), ethers.id("s"))
      );
    });
  });

  describe("settlement", () => {
    async function twoBids() {
      const ctx = await auctionFixture();
      const sA = ethers.id("a");
      const sB = ethers.id("b");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), sA));
      await ctx.auction.connect(ctx.bidderB).commitBid(ctx.auctionId, commitment(ctx.bidderB.address, E("30000"), sB));
      await time.increase(COMMIT_WINDOW + 1);
      await ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), sA);
      await ctx.auction.connect(ctx.bidderB).revealBid(ctx.auctionId, E("30000"), sB);
      return ctx;
    }

    it("pays the seller the winning bid and refunds the winner's excess collateral", async () => {
      const ctx = await twoBids();
      await time.increase(REVEAL_WINDOW + 1);
      const sellerBefore = await ctx.token.balanceOf(ctx.provider.address);
      const winnerBefore = await ctx.token.balanceOf(ctx.bidderB.address);

      await expect(ctx.auction.settle(ctx.auctionId)).to.emit(ctx.auction, "AuctionSettled");

      expect(await ctx.token.balanceOf(ctx.provider.address)).to.equal(sellerBefore + E("30000"));
      expect(await ctx.token.balanceOf(ctx.bidderB.address)).to.equal(winnerBefore + (ctx.collateral - E("30000")));
    });

    it("refunds a losing bidder in full and blocks the winner from withdrawing", async () => {
      const ctx = await twoBids();
      await time.increase(REVEAL_WINDOW + 1);
      await ctx.auction.settle(ctx.auctionId);

      await expect(ctx.auction.connect(ctx.bidderA).withdrawCollateral(ctx.auctionId)).to.changeTokenBalance(
        ctx.token,
        ctx.bidderA,
        ctx.collateral
      );
      await expect(
        ctx.auction.connect(ctx.bidderA).withdrawCollateral(ctx.auctionId)
      ).to.be.revertedWithCustomError(ctx.auction, "AlreadyWithdrawn");
      await expect(
        ctx.auction.connect(ctx.bidderB).withdrawCollateral(ctx.auctionId)
      ).to.be.revertedWithCustomError(ctx.auction, "WinnerCannotWithdraw");
    });

    it("penalises a bidder who commits and never reveals", async () => {
      const ctx = await auctionFixture();
      const sA = ethers.id("a");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), sA));
      await ctx.auction.connect(ctx.bidderB).commitBid(ctx.auctionId, ethers.id("never-revealed"));
      await time.increase(COMMIT_WINDOW + 1);
      await ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), sA);
      await time.increase(REVEAL_WINDOW + 1);
      await ctx.auction.settle(ctx.auctionId);

      const penalty = (ctx.collateral * 2000n) / 10000n;
      await expect(ctx.auction.connect(ctx.bidderB).withdrawCollateral(ctx.auctionId)).to.changeTokenBalance(
        ctx.token,
        ctx.bidderB,
        ctx.collateral - penalty
      );
    });

    it("settles with no winner when nobody reveals", async () => {
      const ctx = await auctionFixture();
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("x"));
      await time.increase(COMMIT_WINDOW + REVEAL_WINDOW + 2);
      await expect(ctx.auction.settle(ctx.auctionId)).to.emit(ctx.auction, "AuctionSettled");
      const a = await ctx.auction.auctionOf(ctx.auctionId);
      expect(a.highBidder).to.equal(ethers.ZeroAddress);
    });

    it("refuses early settlement, double settlement and unknown auctions", async () => {
      const ctx = await twoBids();
      await expect(ctx.auction.settle(ctx.auctionId)).to.be.revertedWithCustomError(ctx.auction, "AuctionNotOver");
      await expect(ctx.auction.settle(99)).to.be.revertedWithCustomError(ctx.auction, "UnknownAuction");
      await time.increase(REVEAL_WINDOW + 1);
      await ctx.auction.settle(ctx.auctionId);
      await expect(ctx.auction.settle(ctx.auctionId)).to.be.revertedWithCustomError(ctx.auction, "WrongPhase");
    });
  });

  describe("cancellation", () => {
    it("lets the seller cancel during commit and returns collateral in full", async () => {
      const ctx = await auctionFixture();
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, ethers.id("x"));
      await expect(ctx.auction.connect(ctx.provider).cancelAuction(ctx.auctionId, "withdrawn")).to.emit(
        ctx.auction,
        "AuctionCancelled"
      );
      await expect(ctx.auction.connect(ctx.bidderA).withdrawCollateral(ctx.auctionId)).to.changeTokenBalance(
        ctx.token,
        ctx.bidderA,
        ctx.collateral
      );
    });

    it("blocks cancellation by a stranger and after the commit phase", async () => {
      const ctx = await auctionFixture();
      await expect(
        ctx.auction.connect(ctx.outsider).cancelAuction(ctx.auctionId, "x")
      ).to.be.revertedWithCustomError(ctx.auction, "NotSeller");
      await expect(ctx.auction.cancelAuction(99, "x")).to.be.revertedWithCustomError(
        ctx.auction,
        "UnknownAuction"
      );

      const salt = ethers.id("a");
      await ctx.auction.connect(ctx.bidderA).commitBid(ctx.auctionId, commitment(ctx.bidderA.address, E("12000"), salt));
      await time.increase(COMMIT_WINDOW + 1);
      await ctx.auction.connect(ctx.bidderA).revealBid(ctx.auctionId, E("12000"), salt);
      await expect(
        ctx.auction.connect(ctx.provider).cancelAuction(ctx.auctionId, "x")
      ).to.be.revertedWithCustomError(ctx.auction, "WrongPhase");
    });
  });

  describe("withdrawal guards & admin", () => {
    it("refuses withdrawal before settlement and from a non-bidder", async () => {
      const ctx = await auctionFixture();
      await expect(
        ctx.auction.connect(ctx.bidderA).withdrawCollateral(ctx.auctionId)
      ).to.be.revertedWithCustomError(ctx.auction, "WrongPhase");
      await expect(ctx.auction.connect(ctx.bidderA).withdrawCollateral(99)).to.be.revertedWithCustomError(
        ctx.auction,
        "UnknownAuction"
      );

      await time.increase(COMMIT_WINDOW + REVEAL_WINDOW + 2);
      await ctx.auction.settle(ctx.auctionId);
      await expect(
        ctx.auction.connect(ctx.outsider).withdrawCollateral(ctx.auctionId)
      ).to.be.revertedWithCustomError(ctx.auction, "NoCommitment");
    });

    it("tunes the no-reveal penalty within bounds", async () => {
      const ctx = await auctionFixture();
      await expect(ctx.auction.setNoRevealPenalty(1000)).to.emit(ctx.auction, "PenaltyUpdated");
      expect(await ctx.auction.noRevealPenaltyBps()).to.equal(1000);
      await expect(ctx.auction.setNoRevealPenalty(5001)).to.be.revertedWithCustomError(
        ctx.auction,
        "InvalidPenalty"
      );
      await expect(ctx.auction.connect(ctx.outsider).setNoRevealPenalty(100)).to.be.revertedWithCustomError(
        ctx.auction,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("swaps the compliance registry", async () => {
      const ctx = await auctionFixture();
      await ctx.auction.setCompliance(await ctx.compliance.getAddress());
      await expect(ctx.auction.setCompliance(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ctx.auction,
        "ZeroAddress"
      );
    });
  });
});
