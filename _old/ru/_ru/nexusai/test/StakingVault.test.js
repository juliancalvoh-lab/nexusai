const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;

async function staked(ctx, who, amount, tier) {
  await ctx.token.connect(who).approve(await ctx.vault.getAddress(), amount);
  return ctx.vault.connect(who).stake(amount, tier);
}

describe("StakingVault", () => {
  describe("deployment", () => {
    it("seeds four lock tiers with increasing multipliers", async () => {
      const { vault } = await loadFixture(deployFixture);
      expect(await vault.tierCount()).to.equal(4);
      const t0 = await vault.tiers(0);
      const t3 = await vault.tiers(3);
      expect(t0.multiplierBps).to.equal(10000);
      expect(t3.multiplierBps).to.equal(22000);
      expect(t3.lockPeriod).to.equal(365 * DAY);
    });

    it("rejects zero-address constructor arguments", async () => {
      const { token, deployer } = await loadFixture(deployFixture);
      const Vault = await ethers.getContractFactory("StakingVault");
      await expect(
        Vault.deploy(ethers.ZeroAddress, deployer.address, deployer.address)
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
      await expect(
        Vault.deploy(await token.getAddress(), ethers.ZeroAddress, deployer.address)
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
      await expect(
        Vault.deploy(await token.getAddress(), deployer.address, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
    });
  });

  describe("staking", () => {
    it("records amount, weight and unlock time", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      const p = await ctx.vault.positionOf(ctx.provider.address);
      expect(p.amount).to.equal(E("1000"));
      expect(p.weight).to.equal((E("1000") * 16000n) / 10000n);
      expect(p.unlockAt).to.be.closeTo(BigInt(await time.latest()) + BigInt(180 * DAY), 5n);
      expect(await ctx.vault.totalStaked()).to.equal(E("1000"));
      expect(await ctx.vault.totalWeight()).to.equal(E("1600"));
    });

    it("emits Staked with the resulting weight", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.token.connect(ctx.provider).approve(await ctx.vault.getAddress(), E("500"));
      await expect(ctx.vault.connect(ctx.provider).stake(E("500"), 1)).to.emit(ctx.vault, "Staked");
    });

    it("rejects zero amounts, unknown tiers and disabled tiers", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.token.connect(ctx.provider).approve(await ctx.vault.getAddress(), E("1000"));
      await expect(ctx.vault.connect(ctx.provider).stake(0, 0)).to.be.revertedWithCustomError(
        ctx.vault,
        "ZeroAmount"
      );
      await expect(ctx.vault.connect(ctx.provider).stake(E("1"), 9)).to.be.revertedWithCustomError(
        ctx.vault,
        "UnknownTier"
      );
      await ctx.vault.configureTier(1, 90 * DAY, 12500, false);
      await expect(ctx.vault.connect(ctx.provider).stake(E("1"), 1)).to.be.revertedWithCustomError(
        ctx.vault,
        "TierDisabled"
      );
    });

    it("refuses to downgrade an existing position to a shorter tier", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      await ctx.token.connect(ctx.provider).approve(await ctx.vault.getAddress(), E("1000"));
      await expect(ctx.vault.connect(ctx.provider).stake(E("1000"), 1)).to.be.revertedWithCustomError(
        ctx.vault,
        "TierDowngrade"
      );
    });

    it("allows topping up and re-arms the lock", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      await time.increase(30 * DAY);
      await staked(ctx, ctx.provider, E("500"), 3);
      const p = await ctx.vault.positionOf(ctx.provider.address);
      expect(p.amount).to.equal(E("1500"));
      expect(p.tier).to.equal(3);
      expect(p.unlockAt).to.be.closeTo(BigInt(await time.latest()) + BigInt(365 * DAY), 5n);
    });

    it("blocks staking while paused", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.vault.pause();
      await ctx.token.connect(ctx.provider).approve(await ctx.vault.getAddress(), E("1"));
      await expect(ctx.vault.connect(ctx.provider).stake(E("1"), 0)).to.be.revertedWithCustomError(
        ctx.vault,
        "EnforcedPause"
      );
      await ctx.vault.unpause();
      await expect(ctx.vault.connect(ctx.provider).stake(E("1"), 0)).to.emit(ctx.vault, "Staked");
    });
  });

  describe("unstaking", () => {
    it("refuses to unstake before the lock expires", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 1);
      await expect(ctx.vault.connect(ctx.provider).unstake(E("1"))).to.be.revertedWithCustomError(
        ctx.vault,
        "StillLocked"
      );
    });

    it("releases principal after the lock and updates weight", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 1);
      await time.increase(91 * DAY);
      await expect(ctx.vault.connect(ctx.provider).unstake(E("400"))).to.changeTokenBalance(
        ctx.token,
        ctx.provider,
        E("400")
      );
      const p = await ctx.vault.positionOf(ctx.provider.address);
      expect(p.amount).to.equal(E("600"));
      expect(p.weight).to.equal((E("600") * 12500n) / 10000n);
    });

    it("rejects unstaking more than staked, zero, or with no position", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.vault.connect(ctx.provider).unstake(E("1"))).to.be.revertedWithCustomError(
        ctx.vault,
        "NoPosition"
      );
      await staked(ctx, ctx.provider, E("1000"), 0);
      await expect(ctx.vault.connect(ctx.provider).unstake(0)).to.be.revertedWithCustomError(
        ctx.vault,
        "ZeroAmount"
      );
      await expect(ctx.vault.connect(ctx.provider).unstake(E("2000"))).to.be.revertedWithCustomError(
        ctx.vault,
        "InsufficientStake"
      );
    });
  });

  describe("reward streaming", () => {
    it("streams rewards proportionally to weight", async () => {
      const ctx = await loadFixture(deployFixture);
      // provider: 1000 @ tier0 (1.0x) ; buyer: 1000 @ tier3 (2.2x)
      await staked(ctx, ctx.provider, E("1000"), 0);
      await staked(ctx, ctx.buyer, E("1000"), 3);

      await ctx.token.approve(await ctx.vault.getAddress(), E("32000"));
      await ctx.vault.fundRewards(E("32000"), 32 * DAY);

      await time.increase(16 * DAY);
      const a = await ctx.vault.earned(ctx.provider.address);
      const b = await ctx.vault.earned(ctx.buyer.address);
      expect(b).to.be.gt(a);
      // ratio should track the 1.0 : 2.2 weight ratio within rounding
      expect((b * 1000n) / a).to.be.closeTo(2200n, 20n);
    });

    it("pays out claimed rewards and zeroes the accrual", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 0);
      await ctx.token.approve(await ctx.vault.getAddress(), E("1000"));
      await ctx.vault.fundRewards(E("1000"), 10 * DAY);
      await time.increase(10 * DAY);

      const earned = await ctx.vault.earned(ctx.provider.address);
      expect(earned).to.be.gt(0);
      await expect(ctx.vault.connect(ctx.provider).claimRewards()).to.emit(ctx.vault, "RewardPaid");
      expect(await ctx.vault.earned(ctx.provider.address)).to.equal(0);
    });

    it("claiming with nothing earned is a no-op rather than a revert", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.vault.connect(ctx.outsider).claimRewards()).to.not.be.reverted;
    });

    it("extends an in-flight schedule when topped up", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 0);
      await ctx.token.approve(await ctx.vault.getAddress(), E("2000"));
      await ctx.vault.fundRewards(E("1000"), 10 * DAY);
      await time.increase(5 * DAY);
      await expect(ctx.vault.fundRewards(E("1000"), 10 * DAY)).to.emit(ctx.vault, "RewardFunded");
      expect(await ctx.vault.periodFinish()).to.be.gt(BigInt(await time.latest()));
    });

    it("rejects zero funding and dust rates", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.token.approve(await ctx.vault.getAddress(), E("1000"));
      await expect(ctx.vault.fundRewards(0, 10)).to.be.revertedWithCustomError(ctx.vault, "ZeroAmount");
      await expect(ctx.vault.fundRewards(E("1"), 0)).to.be.revertedWithCustomError(ctx.vault, "ZeroAmount");
      await expect(ctx.vault.fundRewards(1n, 10 * DAY)).to.be.revertedWithCustomError(ctx.vault, "RewardTooHigh");
    });

    it("only REWARD_MANAGER_ROLE can fund", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.vault.connect(ctx.outsider).fundRewards(E("1"), 10)).to.be.revertedWithCustomError(
        ctx.vault,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("accrues nothing while total weight is zero", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.token.approve(await ctx.vault.getAddress(), E("1000"));
      await ctx.vault.fundRewards(E("1000"), 10 * DAY);
      const before = await ctx.vault.rewardPerWeight();
      await time.increase(DAY);
      expect(await ctx.vault.rewardPerWeight()).to.equal(before);
    });
  });

  describe("slashing", () => {
    it("moves the slashed principal to the treasury and rescales weight", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      const treasury = await ctx.timelock.getAddress();

      await expect(ctx.vault.slash(ctx.provider.address, 1000, "misreported accuracy")).to.changeTokenBalance(
        ctx.token,
        { getAddress: async () => treasury },
        E("100")
      );

      const p = await ctx.vault.positionOf(ctx.provider.address);
      expect(p.amount).to.equal(E("900"));
      expect(p.weight).to.equal((E("900") * 16000n) / 10000n);
      expect(await ctx.vault.totalStaked()).to.equal(E("900"));
    });

    it("caps a single slash at 30% and rejects zero", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      await expect(ctx.vault.slash(ctx.provider.address, 3001, "x")).to.be.revertedWithCustomError(
        ctx.vault,
        "SlashTooLarge"
      );
      await expect(ctx.vault.slash(ctx.provider.address, 0, "x")).to.be.revertedWithCustomError(
        ctx.vault,
        "SlashTooLarge"
      );
    });

    it("reverts when the target has no position", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.vault.slash(ctx.outsider.address, 100, "x")).to.be.revertedWithCustomError(
        ctx.vault,
        "NoPosition"
      );
    });

    it("is gated by SLASHER_ROLE", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      await expect(
        ctx.vault.connect(ctx.outsider).slash(ctx.provider.address, 100, "x")
      ).to.be.revertedWithCustomError(ctx.vault, "AccessControlUnauthorizedAccount");
    });
  });

  describe("emergency withdrawal", () => {
    it("is only available while paused, and forfeits rewards", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 3);
      await ctx.token.approve(await ctx.vault.getAddress(), E("1000"));
      await ctx.vault.fundRewards(E("1000"), 10 * DAY);
      await time.increase(5 * DAY);

      await expect(ctx.vault.connect(ctx.provider).emergencyWithdraw()).to.be.revertedWithCustomError(
        ctx.vault,
        "ExpectedPause"
      );

      await ctx.vault.pause();
      const balBefore = await ctx.token.balanceOf(ctx.provider.address);
      await expect(ctx.vault.connect(ctx.provider).emergencyWithdraw()).to.emit(ctx.vault, "EmergencyWithdrawn");
      expect(await ctx.token.balanceOf(ctx.provider.address)).to.equal(balBefore + E("1000"));

      expect(await ctx.vault.earned(ctx.provider.address)).to.equal(0);
      expect(await ctx.vault.totalStaked()).to.equal(0);
    });

    it("reverts with no position", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.vault.pause();
      await expect(ctx.vault.connect(ctx.outsider).emergencyWithdraw()).to.be.revertedWithCustomError(
        ctx.vault,
        "NoPosition"
      );
    });
  });

  describe("admin", () => {
    it("configures an existing tier and appends a new one", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.vault.configureTier(0, 7 * DAY, 10500, true)).to.emit(ctx.vault, "TierConfigured");
      await ctx.vault.configureTier(4, 730 * DAY, 30000, true);
      expect(await ctx.vault.tierCount()).to.equal(5);
      await expect(ctx.vault.configureTier(9, 1, 1, true)).to.be.revertedWithCustomError(ctx.vault, "UnknownTier");
    });

    it("updates the treasury and rejects the zero address", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(ctx.vault.setTreasury(ctx.outsider.address)).to.emit(ctx.vault, "TreasuryUpdated");
      await expect(ctx.vault.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ctx.vault,
        "ZeroAddress"
      );
    });

    it("exposes the bond view used by the marketplace", async () => {
      const ctx = await loadFixture(deployFixture);
      await staked(ctx, ctx.provider, E("1000"), 2);
      const [amount, unlockAt] = await ctx.vault.bondOf(ctx.provider.address);
      expect(amount).to.equal(E("1000"));
      expect(unlockAt).to.be.gt(BigInt(await time.latest()));
      expect(await ctx.vault.stakedOf(ctx.provider.address)).to.equal(E("1000"));
      expect(await ctx.vault.weightOf(ctx.provider.address)).to.equal(E("1600"));
    });
  });
});
