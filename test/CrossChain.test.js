const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture, bondProvider, registerModel, reportAccuracy, DAY } = require("./helpers/fixtures");

const E = ethers.parseEther;
const KEY_REF = ethers.id("ipfs://key");

// hub = Sepolia, spoke = Base Sepolia, with the relayer delivering messages by hand
async function crossChainFixture() {
  const ctx = await loadFixture(deployFixture);
  await bondProvider(ctx);
  const modelId = await registerModel(ctx);
  await reportAccuracy(ctx, modelId, 9600);
  return { ...ctx, modelId };
}

function messageSentEvent(router, receipt) {
  return receipt.logs
    .map((l) => {
      try {
        return router.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((e) => e && e.name === "MessageSent");
}

// send on the source router, execute on the destination router
async function relay(srcRouter, dstRouter, tx) {
  const receipt = await tx.wait();
  const ev = messageSentEvent(srcRouter, receipt);
  const srcSelector = await srcRouter.localChainSelector();
  await dstRouter.relayIn(srcSelector, ev.args.sender, ev.args.nonce, ev.args.receiver, ev.args.payload);
  await srcRouter.acknowledge(ev.args.messageId);
  return ev.args;
}

describe("Cross-chain", () => {
  describe("MockCrossChainRouter", () => {
    it("quotes a fee that scales with payload size and rejects underpayment", async () => {
      const ctx = await loadFixture(deployFixture);
      const payload = "0x" + "ab".repeat(64);
      const fee = await ctx.hubRouter.quoteFee(ctx.CONFIG.spokeSelector, payload);
      expect(fee).to.be.gt(await ctx.hubRouter.baseFee());
      await expect(
        ctx.hubRouter.sendMessage(ctx.CONFIG.spokeSelector, ctx.deployer.address, payload, { value: 0 })
      ).to.be.revertedWithCustomError(ctx.hubRouter, "InsufficientFee");
    });

    it("records a message, executes it once on the destination, and acknowledges it", async () => {
      const ctx = await crossChainFixture();
      const tx = await ctx.hubRegistry.publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") });
      const args = await relay(ctx.hubRouter, ctx.spokeRouter, tx);

      expect(await ctx.hubRouter.messageCount()).to.equal(1);
      expect(await ctx.hubRouter.messageIdAt(0)).to.equal(args.messageId);
      const m = await ctx.hubRouter.messageOf(args.messageId);
      expect(m.delivered).to.equal(true);
      expect(m.srcChainSelector).to.equal(ctx.CONFIG.hubSelector);

      // Replaying the same (srcChain, sender, receiver, nonce) tuple is rejected.
      await expect(
        ctx.spokeRouter.relayIn(ctx.CONFIG.hubSelector, args.sender, args.nonce, args.receiver, args.payload)
      ).to.be.revertedWithCustomError(ctx.spokeRouter, "AlreadyDelivered");

      await expect(ctx.hubRouter.acknowledge(args.messageId)).to.be.revertedWithCustomError(
        ctx.hubRouter,
        "AlreadyDelivered"
      );
      await expect(ctx.hubRouter.acknowledge(ethers.id("nope"))).to.be.revertedWithCustomError(
        ctx.hubRouter,
        "UnknownMessage"
      );
    });

    it("restricts destination execution to RELAYER_ROLE", async () => {
      const ctx = await crossChainFixture();
      const tx = await ctx.hubRegistry.publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") });
      const ev = messageSentEvent(ctx.hubRouter, await tx.wait());
      await expect(
        ctx.spokeRouter
          .connect(ctx.outsider)
          .relayIn(ctx.CONFIG.hubSelector, ev.args.sender, ev.args.nonce, ev.args.receiver, ev.args.payload)
      ).to.be.revertedWithCustomError(ctx.spokeRouter, "AccessControlUnauthorizedAccount");
    });

    it("lets the admin retune the fee, set peers and sweep the balance", async () => {
      const ctx = await loadFixture(deployFixture);
      await ctx.hubRouter.setBaseFee(1234);
      expect(await ctx.hubRouter.baseFee()).to.equal(1234);
      await expect(ctx.hubRouter.setPeerRouter(ctx.CONFIG.spokeSelector, await ctx.spokeRouter.getAddress())).to.emit(
        ctx.hubRouter,
        "PeerRouterSet"
      );
      expect(await ctx.hubRouter.peerRouter(ctx.CONFIG.spokeSelector)).to.equal(await ctx.spokeRouter.getAddress());

      await ctx.hubRouter.sendMessage(ctx.CONFIG.spokeSelector, ctx.deployer.address, "0x", { value: E("1") });
      await expect(ctx.hubRouter.withdrawFees(ctx.outsider.address)).to.changeEtherBalance(ctx.outsider, E("1"));
    });
  });

  describe("model mirroring hub to spoke", () => {
    it("mirrors a listing onto the spoke marketplace", async () => {
      const ctx = await crossChainFixture();
      const tx = await ctx.hubRegistry.publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") });
      await relay(ctx.hubRouter, ctx.spokeRouter, tx);

      const mirrored = await ctx.spokeMarketplace.modelOf(ctx.modelId);
      expect(mirrored.provider).to.equal(ctx.provider.address);
      expect(mirrored.price).to.equal(E("1000"));
      expect(mirrored.originChain).to.equal(ctx.CONFIG.hubSelector);
      expect(mirrored.active).to.equal(true);
      expect(await ctx.spokeMarketplace.modelCount()).to.equal(1);
    });

    it("is idempotent, re-mirroring does not duplicate the index entry", async () => {
      const ctx = await crossChainFixture();
      await relay(
        ctx.hubRouter,
        ctx.spokeRouter,
        await ctx.hubRegistry.publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") })
      );
      await relay(
        ctx.hubRouter,
        ctx.spokeRouter,
        await ctx.hubRegistry.publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") })
      );
      expect(await ctx.spokeMarketplace.modelCount()).to.equal(1);
    });

    it("reverts when no trusted remote is configured for the destination", async () => {
      const ctx = await crossChainFixture();
      await expect(
        ctx.hubRegistry.publishModel(ctx.modelId, 999999, { value: E("1") })
      ).to.be.revertedWithCustomError(ctx.hubRegistry, "NoTrustedRemote");
    });

    it("gates publishing behind PUBLISHER_ROLE", async () => {
      const ctx = await crossChainFixture();
      await expect(
        ctx.hubRegistry.connect(ctx.outsider).publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") })
      ).to.be.revertedWithCustomError(ctx.hubRegistry, "AccessControlUnauthorizedAccount");
    });
  });

  describe("licence mirroring spoke to hub", () => {
    it("carries an entitlement bought on one chain back to the canonical registry", async () => {
      const ctx = await crossChainFixture();
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);
      const expiry = await ctx.marketplace.licenceExpiry(ctx.modelId, ctx.buyer.address);

      await relay(
        ctx.hubRouter,
        ctx.spokeRouter,
        await ctx.hubRegistry.publishLicence(ctx.modelId, ctx.buyer.address, ctx.CONFIG.spokeSelector, {
          value: E("1"),
        })
      );

      expect(await ctx.spokeMarketplace.licenceExpiry(ctx.modelId, ctx.buyer.address)).to.equal(expiry);
      expect(await ctx.spokeMarketplace.hasActiveLicence(ctx.modelId, ctx.buyer.address)).to.equal(true);
    });

    it("never shortens an existing entitlement, so out-of-order delivery is safe", async () => {
      const ctx = await crossChainFixture();
      await ctx.token.connect(ctx.buyer).approve(await ctx.marketplace.getAddress(), E("100000"));
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF);

      // Deliver the long entitlement first...
      await time.increase(3600);
      await reportAccuracy(ctx, ctx.modelId, 9600);
      await ctx.marketplace.connect(ctx.buyer).purchaseLicence(ctx.modelId, KEY_REF); // now 60 days
      const long = await ctx.marketplace.licenceExpiry(ctx.modelId, ctx.buyer.address);
      const msgLong = await ctx.hubRegistry.publishLicence(
        ctx.modelId,
        ctx.buyer.address,
        ctx.CONFIG.spokeSelector,
        { value: E("1") }
      );
      await relay(ctx.hubRouter, ctx.spokeRouter, msgLong);
      expect(await ctx.spokeMarketplace.licenceExpiry(ctx.modelId, ctx.buyer.address)).to.equal(long);

      // ...then a stale, shorter one. It must not roll the entitlement back.
      await ctx.spokeMarketplace.grantRole(
        await ctx.spokeMarketplace.CROSSCHAIN_ROLE(),
        ctx.deployer.address
      );
      await ctx.spokeMarketplace.mirrorLicence(ctx.modelId, ctx.buyer.address, 1n, ctx.CONFIG.hubSelector);
      expect(await ctx.spokeMarketplace.licenceExpiry(ctx.modelId, ctx.buyer.address)).to.equal(long);
    });

    it("reverts when the holder has no licence to publish", async () => {
      const ctx = await crossChainFixture();
      await expect(
        ctx.hubRegistry.publishLicence(ctx.modelId, ctx.outsider.address, ctx.CONFIG.spokeSelector, {
          value: E("1"),
        })
      ).to.be.revertedWithCustomError(ctx.hubRegistry, "NoLicence");
    });
  });

  describe("inbound authentication", () => {
    it("rejects a call that does not come from the configured router", async () => {
      const ctx = await crossChainFixture();
      await expect(
        ctx.spokeRegistry.connect(ctx.outsider).ccReceive(ctx.CONFIG.hubSelector, ctx.outsider.address, 1, "0x")
      ).to.be.revertedWithCustomError(ctx.spokeRegistry, "UntrustedRouter");
    });

    it("rejects a message from an untrusted remote on a known chain", async () => {
      const ctx = await crossChainFixture();
      // An attacker deploys their own registry and sends from it.
      const Registry = await ethers.getContractFactory("CrossChainRegistry");
      const rogue = await Registry.deploy(
        await ctx.hubRouter.getAddress(),
        await ctx.marketplace.getAddress(),
        ctx.CONFIG.hubSelector,
        ctx.outsider.address
      );
      await rogue.connect(ctx.outsider).setTrustedRemote(ctx.CONFIG.spokeSelector, await ctx.spokeRegistry.getAddress());
      await ctx.marketplace.grantRole(await ctx.marketplace.CROSSCHAIN_ROLE(), await rogue.getAddress());

      const tx = await rogue
        .connect(ctx.outsider)
        .publishModel(ctx.modelId, ctx.CONFIG.spokeSelector, { value: E("1") });
      const ev = messageSentEvent(ctx.hubRouter, await tx.wait());

      await expect(
        ctx.spokeRouter.relayIn(ctx.CONFIG.hubSelector, ev.args.sender, ev.args.nonce, ev.args.receiver, ev.args.payload)
      ).to.be.revertedWithCustomError(ctx.spokeRegistry, "UntrustedRemote");
    });

    it("rejects an unknown message type", async () => {
      const ctx = await crossChainFixture();
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes"], [99, "0x"]);
      await ctx.spokeRegistry.setRouter(ctx.deployer.address); // impersonate the router
      await expect(
        ctx.spokeRegistry.ccReceive(ctx.CONFIG.hubSelector, await ctx.hubRegistry.getAddress(), 7, payload)
      ).to.be.revertedWithCustomError(ctx.spokeRegistry, "UnknownMessageType");
    });

    it("consumes each (chain, nonce) pair exactly once", async () => {
      const ctx = await crossChainFixture();
      const payload = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "bytes"],
        [
          2,
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["tuple(bytes32,address,uint64)"],
            [[ctx.modelId, ctx.buyer.address, 9999999999n]]
          ),
        ]
      );
      await ctx.spokeRegistry.setRouter(ctx.deployer.address);

      await expect(
        ctx.spokeRegistry.ccReceive(ctx.CONFIG.hubSelector, await ctx.hubRegistry.getAddress(), 42, payload)
      ).to.emit(ctx.spokeRegistry, "MessageConsumed");
      expect(await ctx.spokeRegistry.consumedNonce(ctx.CONFIG.hubSelector, 42)).to.equal(true);

      await expect(
        ctx.spokeRegistry.ccReceive(ctx.CONFIG.hubSelector, await ctx.hubRegistry.getAddress(), 42, payload)
      ).to.be.revertedWithCustomError(ctx.spokeRegistry, "ReplayedNonce");
    });
  });

  describe("registry admin", () => {
    it("rejects zero-address construction and setters", async () => {
      const ctx = await loadFixture(deployFixture);
      const Registry = await ethers.getContractFactory("CrossChainRegistry");
      await expect(
        Registry.deploy(ethers.ZeroAddress, await ctx.marketplace.getAddress(), 1, ctx.deployer.address)
      ).to.be.revertedWithCustomError(Registry, "ZeroAddress");
      await expect(
        Registry.deploy(await ctx.hubRouter.getAddress(), ethers.ZeroAddress, 1, ctx.deployer.address)
      ).to.be.revertedWithCustomError(Registry, "ZeroAddress");
      await expect(ctx.hubRegistry.setRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        ctx.hubRegistry,
        "ZeroAddress"
      );
    });

    it("gates trusted-remote configuration behind BRIDGE_ADMIN_ROLE", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(
        ctx.hubRegistry.connect(ctx.outsider).setTrustedRemote(1, ctx.outsider.address)
      ).to.be.revertedWithCustomError(ctx.hubRegistry, "AccessControlUnauthorizedAccount");
      await expect(ctx.hubRegistry.setTrustedRemote(1, ctx.outsider.address)).to.emit(
        ctx.hubRegistry,
        "TrustedRemoteSet"
      );
    });

    it("quotes the publish fee through the router", async () => {
      const ctx = await loadFixture(deployFixture);
      expect(await ctx.hubRegistry.quotePublishFee(ctx.CONFIG.spokeSelector, "0x1234")).to.be.gt(0);
    });
  });
});
