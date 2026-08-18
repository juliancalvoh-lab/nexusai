const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;

const ProposalState = {
  Pending: 0,
  Active: 1,
  Canceled: 2,
  Defeated: 3,
  Succeeded: 4,
  Queued: 5,
  Expired: 6,
  Executed: 7,
};

// give the timelock real power and let the governor propose
async function governedFixture() {
  const ctx = await loadFixture(deployFixture);
  const governorAddr = await ctx.governor.getAddress();
  const timelockAddr = await ctx.timelock.getAddress();

  await ctx.timelock.grantRole(await ctx.timelock.PROPOSER_ROLE(), governorAddr);
  await ctx.timelock.grantRole(await ctx.timelock.CANCELLER_ROLE(), governorAddr);
  await ctx.timelock.grantRole(await ctx.timelock.EXECUTOR_ROLE(), ethers.ZeroAddress); // open execution

  // The Timelock becomes the protocol admin.
  await ctx.marketplace.grantRole(await ctx.marketplace.MARKET_ADMIN_ROLE(), timelockAddr);
  await ctx.vault.grantRole(await ctx.vault.VAULT_ADMIN_ROLE(), timelockAddr);
  await ctx.vault.grantRole(await ctx.vault.SLASHER_ROLE(), timelockAddr);
  await ctx.oracle.grantRole(await ctx.oracle.ORACLE_ADMIN_ROLE(), timelockAddr);
  await ctx.token.grantRole(await ctx.token.EMISSION_MANAGER_ROLE(), timelockAddr);

  // Voting power: the deployer still holds the bulk of the genesis allocation.
  await ctx.token.delegate(ctx.deployer.address);
  await ctx.token.connect(ctx.provider).delegate(ctx.provider.address);
  await mine();
  return ctx;
}

async function propose(ctx, target, calldata, description, proposer) {
  const signer = proposer ?? ctx.deployer;
  const tx = await ctx.governor.connect(signer).propose([target], [0], [calldata], description);
  const receipt = await tx.wait();
  const ev = receipt.logs
    .map((l) => {
      try {
        return ctx.governor.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "ProposalCreated");
  return ev.args.proposalId;
}

describe("Governance", () => {
  describe("configuration", () => {
    it("exposes the configured settings", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.governor.votingDelay()).to.equal(DAY);
      expect(await ctx.governor.votingPeriod()).to.equal(5 * DAY);
      expect(await ctx.governor.proposalThreshold()).to.equal(E("250000"));
      expect(await ctx.governor.name()).to.equal("NexusAI Governor");
    });

    it("computes quorum as 4% of the past total supply", async () => {
      const ctx = await loadFixture(deployFixture);
      await time.increase(10);
      const at = (await time.latest()) - 1;
      const q = await ctx.governor.quorum(at);
      expect(q).to.equal((await ctx.token.getPastTotalSupply(at)) * 4n / 100n);
    });

    it("uses the token's timestamp clock", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.governor.CLOCK_MODE()).to.equal("mode=timestamp");
    });
  });

  describe("proposal lifecycle", () => {
    it("runs propose -> vote -> queue -> execute against a live protocol parameter", async () => {
      const ctx = await governedFixture();
      const calldata = ctx.marketplace.interface.encodeFunctionData("setParameters", [
        250, // protocolFeeBps 2.5%
        5000, // burnShareBps 50%
        3 * DAY,
        E("25000"),
        180 * DAY,
      ]);
      const description = "NIP-1: halve the protocol fee and raise the burn share";
      const proposalId = await propose(ctx, await ctx.marketplace.getAddress(), calldata, description);

      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Pending);
      await time.increase(DAY + 1);
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Active);

      await ctx.governor.castVote(proposalId, 1); // For
      await time.increase(5 * DAY + 1);
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Succeeded);

      const descHash = ethers.id(description);
      await ctx.governor.queue([await ctx.marketplace.getAddress()], [0], [calldata], descHash);
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Queued);

      await expect(
        ctx.governor.execute([await ctx.marketplace.getAddress()], [0], [calldata], descHash)
      ).to.be.reverted; // timelock delay not yet elapsed

      await time.increase(2 * DAY + 1);
      await ctx.governor.execute([await ctx.marketplace.getAddress()], [0], [calldata], descHash);

      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Executed);
      expect(await ctx.marketplace.protocolFeeBps()).to.equal(250);
      expect(await ctx.marketplace.burnShareBps()).to.equal(5000);
      expect(await ctx.marketplace.minProviderBond()).to.equal(E("25000"));
    });

    it("defeats a proposal that fails to reach quorum", async () => {
      const ctx = await governedFixture();
      const calldata = ctx.marketplace.interface.encodeFunctionData("setParameters", [
        100,
        1000,
        DAY,
        0,
        0,
      ]);
      // provider holds 1M of ~400M supply, far below the 4% quorum
      const proposalId = await propose(
        ctx,
        await ctx.marketplace.getAddress(),
        calldata,
        "NIP-2: low turnout",
        ctx.deployer
      );
      await time.increase(DAY + 1);
      await ctx.governor.connect(ctx.provider).castVote(proposalId, 1);
      await time.increase(5 * DAY + 1);
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("defeats a proposal that reaches quorum but is voted down", async () => {
      const ctx = await governedFixture();
      const calldata = ctx.marketplace.interface.encodeFunctionData("setParameters", [900, 1000, DAY, 0, 0]);
      const proposalId = await propose(ctx, await ctx.marketplace.getAddress(), calldata, "NIP-3: raise the fee");
      await time.increase(DAY + 1);
      await ctx.governor.castVote(proposalId, 0); // Against
      await time.increase(5 * DAY + 1);
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("counts abstentions toward quorum without deciding the outcome", async () => {
      const ctx = await governedFixture();
      const calldata = ctx.marketplace.interface.encodeFunctionData("setParameters", [300, 1000, DAY, 0, 0]);
      const proposalId = await propose(ctx, await ctx.marketplace.getAddress(), calldata, "NIP-4: abstain");
      await time.increase(DAY + 1);
      await ctx.governor.castVote(proposalId, 2); // Abstain
      await time.increase(5 * DAY + 1);
      // Quorum met by the abstention, but zero For votes means it does not succeed.
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Defeated);
    });

    it("rejects a proposal from an account below the threshold", async () => {
      const ctx = await governedFixture();
      await ctx.token.connect(ctx.buyer).delegate(ctx.buyer.address);
      await mine();
      const calldata = ctx.marketplace.interface.encodeFunctionData("pause", []);
      await expect(
        ctx.governor.connect(ctx.outsider).propose([await ctx.marketplace.getAddress()], [0], [calldata], "spam")
      ).to.be.revertedWithCustomError(ctx.governor, "GovernorInsufficientProposerVotes");
    });

    it("lets the proposer cancel while the vote is still pending", async () => {
      const ctx = await governedFixture();
      const calldata = ctx.marketplace.interface.encodeFunctionData("pause", []);
      const description = "NIP-5: emergency pause";
      const proposalId = await propose(ctx, await ctx.marketplace.getAddress(), calldata, description);
      await ctx.governor.cancel([await ctx.marketplace.getAddress()], [0], [calldata], ethers.id(description));
      expect(await ctx.governor.state(proposalId)).to.equal(ProposalState.Canceled);
    });
  });

  describe("timelock as the protocol admin", () => {
    it("can retune emissions through a passed proposal", async () => {
      const ctx = await governedFixture();
      const newCeiling = E("5000000");
      const calldata = ctx.token.interface.encodeFunctionData("setEmissionCeiling", [newCeiling]);
      const description = "NIP-6: cut emissions";
      const proposalId = await propose(ctx, await ctx.token.getAddress(), calldata, description);

      await time.increase(DAY + 1);
      await ctx.governor.castVote(proposalId, 1);
      await time.increase(5 * DAY + 1);
      await ctx.governor.queue([await ctx.token.getAddress()], [0], [calldata], ethers.id(description));
      await time.increase(2 * DAY + 1);
      await ctx.governor.execute([await ctx.token.getAddress()], [0], [calldata], ethers.id(description));

      expect(await ctx.token.emissionCeiling()).to.equal(newCeiling);
    });

    it("holds the delay so holders always get an exit window", async () => {
      const ctx = await governedFixture();
      expect(await ctx.timelock.getMinDelay()).to.equal(2 * DAY);
    });

    it("refuses direct privileged calls from an EOA once the timelock owns the role", async () => {
      const ctx = await governedFixture();
      await ctx.marketplace.revokeRole(await ctx.marketplace.MARKET_ADMIN_ROLE(), ctx.deployer.address);
      await expect(ctx.marketplace.setParameters(100, 100, DAY, 0, 0)).to.be.revertedWithCustomError(
        ctx.marketplace,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("flash-loan resistance", () => {
    it("gives zero weight to voting power acquired after the snapshot", async () => {
      const ctx = await governedFixture();
      const calldata = ctx.marketplace.interface.encodeFunctionData("pause", []);
      const proposalId = await propose(ctx, await ctx.marketplace.getAddress(), calldata, "NIP-7: snapshot test");

      await time.increase(DAY + 1); // snapshot has been taken

      // The attacker "borrows" a large balance only now.
      await ctx.token.transfer(ctx.outsider.address, E("50000000"));
      await ctx.token.connect(ctx.outsider).delegate(ctx.outsider.address);
      await mine();

      await ctx.governor.connect(ctx.outsider).castVote(proposalId, 1);
      const votes = await ctx.governor.proposalVotes(proposalId);
      expect(votes.forVotes).to.equal(0); // borrowed weight carries nothing
    });
  });
});
