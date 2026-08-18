const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, attest, DAY } = require("./helpers/fixtures");

describe("ComplianceRegistry", () => {
  it("rejects a zero admin", async () => {
    const Registry = await ethers.getContractFactory("ComplianceRegistry");
    await expect(Registry.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Registry, "ZeroAddress");
  });

  describe("attestation", () => {
    it("marks an attested account eligible and records only a root", async () => {
      const ctx = await loadFixture(deployFixture);
      const { root } = await attest(ctx, ctx.buyer);
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(true);

      const a = await ctx.compliance.attestationOf(ctx.buyer.address);
      expect(a.attributesRoot).to.equal(root);
      expect(a.jurisdiction).to.equal(840);
      expect(a.attester).to.equal(ctx.attester.address);
      expect(a.revoked).to.equal(false);
    });

    it("treats an unattested account as ineligible", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.compliance.isEligible(ctx.outsider.address)).to.equal(false);
    });

    it("only ATTESTER_ROLE may attest", async () => {
      const ctx = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(
        ctx.compliance.connect(ctx.outsider).attest(ctx.buyer.address, ethers.id("r"), 840, now + DAY)
      ).to.be.revertedWithCustomError(ctx.compliance, "AccessControlUnauthorizedAccount");
    });

    it("rejects a zero account or an expiry in the past", async () => {
      const ctx = await loadFixture(deployFixture);
      const now = await time.latest();
      await expect(
        ctx.compliance.connect(ctx.attester).attest(ethers.ZeroAddress, ethers.id("r"), 840, now + DAY)
      ).to.be.revertedWithCustomError(ctx.compliance, "ZeroAddress");
      await expect(
        ctx.compliance.connect(ctx.attester).attest(ctx.buyer.address, ethers.id("r"), 840, now - 1)
      ).to.be.revertedWithCustomError(ctx.compliance, "BadExpiry");
    });

    it("expires automatically", async () => {
      const ctx = await loadFixture(deployFixture);
      await attest(ctx, ctx.buyer, 840, 10 * DAY);
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(true);
      await time.increase(11 * DAY);
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(false);
    });
  });

  describe("revocation & denial", () => {
    it("revokes instantly, by attester or by compliance admin", async () => {
      const ctx = await loadFixture(deployFixture);
      await attest(ctx, ctx.buyer);
      await expect(ctx.compliance.connect(ctx.attester).revoke(ctx.buyer.address, "credential withdrawn")).to.emit(
        ctx.compliance,
        "Revoked"
      );
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(false);

      await attest(ctx, ctx.provider);
      await expect(ctx.compliance.revoke(ctx.provider.address, "admin action")).to.emit(ctx.compliance, "Revoked");
    });

    it("refuses revocation from an unauthorised caller or for an unknown account", async () => {
      const ctx = await loadFixture(deployFixture);
      await attest(ctx, ctx.buyer);
      await expect(
        ctx.compliance.connect(ctx.outsider).revoke(ctx.buyer.address, "nope")
      ).to.be.revertedWithCustomError(ctx.compliance, "AccessControlUnauthorizedAccount");
      await expect(ctx.compliance.revoke(ctx.outsider.address, "nope")).to.be.revertedWithCustomError(
        ctx.compliance,
        "NoAttestation"
      );
    });

    it("blocks a jurisdiction without touching the credential", async () => {
      const ctx = await loadFixture(deployFixture);
      await attest(ctx, ctx.buyer, 408); // DPRK
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(true);
      await expect(ctx.compliance.setBlockedJurisdiction(408, true)).to.emit(ctx.compliance, "JurisdictionBlocked");
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(false);
      await ctx.compliance.setBlockedJurisdiction(408, false);
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(true);
    });

    it("supports an address-level denylist", async () => {
      const ctx = await loadFixture(deployFixture);
      await attest(ctx, ctx.buyer);
      await expect(ctx.compliance.setDenied(ctx.buyer.address, true, "sanctions screening hit")).to.emit(
        ctx.compliance,
        "Denied"
      );
      expect(await ctx.compliance.isEligible(ctx.buyer.address)).to.equal(false);
    });

    it("gates admin actions behind COMPLIANCE_ADMIN_ROLE", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.compliance.connect(ctx.outsider).setBlockedJurisdiction(1, true)
      ).to.be.revertedWithCustomError(ctx.compliance, "AccessControlUnauthorizedAccount");
      await expect(
        ctx.compliance.connect(ctx.outsider).setDenied(ctx.buyer.address, true, "x")
      ).to.be.revertedWithCustomError(ctx.compliance, "AccessControlUnauthorizedAccount");
    });
  });

  describe("selective disclosure", () => {
    it("verifies a single disclosed attribute against the stored root", async () => {
      const ctx = await loadFixture(deployFixture);
      const { leafA, proofForA, leafB, proofForB } = await attest(ctx, ctx.buyer);

      expect(await ctx.compliance.verifyAttribute(ctx.buyer.address, leafA, proofForA)).to.equal(true);
      expect(await ctx.compliance.verifyAttribute(ctx.buyer.address, leafB, proofForB)).to.equal(true);
    });

    it("rejects a forged leaf or a proof from a different tree", async () => {
      const ctx = await loadFixture(deployFixture);
      const { proofForA } = await attest(ctx, ctx.buyer);
      const forged = ethers.id("accredited=true-but-made-up");
      expect(await ctx.compliance.verifyAttribute(ctx.buyer.address, forged, proofForA)).to.equal(false);
    });

    it("returns false once the credential is revoked or expired", async () => {
      const ctx = await loadFixture(deployFixture);
      const { leafA, proofForA } = await attest(ctx, ctx.buyer, 840, 10 * DAY);
      await ctx.compliance.connect(ctx.attester).revoke(ctx.buyer.address, "revoked");
      expect(await ctx.compliance.verifyAttribute(ctx.buyer.address, leafA, proofForA)).to.equal(false);

      const other = await attest(ctx, ctx.provider, 840, 10 * DAY);
      await time.increase(11 * DAY);
      expect(await ctx.compliance.verifyAttribute(ctx.provider.address, other.leafA, other.proofForA)).to.equal(
        false
      );
    });

    it("returns false for an account that was never attested", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.compliance.verifyAttribute(ctx.outsider.address, ethers.id("x"), [])).to.equal(false);
    });
  });
});
