const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFixture } = require("./helpers/fixtures");

describe("NexusAIToken", () => {
  describe("deployment", () => {
    it("sets metadata, cap and the genesis allocation", async () => {
      const { token, deployer, CONFIG } = await loadFixture(deployFixture);
      expect(await token.name()).to.equal("NexusAI");
      expect(await token.symbol()).to.equal("NEXA");
      expect(await token.cap()).to.equal(ethers.parseEther("1000000000"));
      expect(await token.totalSupply()).to.equal(CONFIG.genesisMint);
      // deployer was the treasury in the fixture and has since funded test accounts
      expect(await token.balanceOf(deployer.address)).to.be.gt(0);
    });

    it("does not charge the genesis mint against the epoch emission budget", async () => {
      const { token } = await loadFixture(deployFixture);
      expect(await token.remainingEmission()).to.equal(await token.emissionCeiling());
    });

    it("grants the admin roles to the deployer", async () => {
      const { token, deployer } = await loadFixture(deployFixture);
      expect(await token.hasRole(await token.MINTER_ROLE(), deployer.address)).to.equal(true);
      expect(await token.hasRole(await token.EMISSION_MANAGER_ROLE(), deployer.address)).to.equal(true);
    });

    it("reverts when constructed with a zero treasury or admin", async () => {
      const Token = await ethers.getContractFactory("NexusAIToken");
      const [deployer] = await ethers.getSigners();
      await expect(Token.deploy(ethers.ZeroAddress, 0, deployer.address)).to.be.revertedWithCustomError(
        Token,
        "ZeroAddress"
      );
      await expect(Token.deploy(deployer.address, 0, ethers.ZeroAddress)).to.be.revertedWithCustomError(
        Token,
        "ZeroAddress"
      );
    });

    it("supports a zero genesis mint (the spoke-chain configuration)", async () => {
      const Token = await ethers.getContractFactory("NexusAIToken");
      const [deployer] = await ethers.getSigners();
      const spokeToken = await Token.deploy(deployer.address, 0, deployer.address);
      expect(await spokeToken.totalSupply()).to.equal(0);
    });
  });

  describe("emissions", () => {
    it("mints within the epoch ceiling", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      const amount = ethers.parseEther("1000000");
      await expect(token.mint(buyer.address, amount)).to.changeTokenBalance(token, buyer, amount);
      expect(await token.remainingEmission()).to.equal((await token.emissionCeiling()) - amount);
    });

    it("rejects a mint that exceeds the remaining epoch budget", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      const tooMuch = (await token.emissionCeiling()) + 1n;
      await expect(token.mint(buyer.address, tooMuch)).to.be.revertedWithCustomError(
        token,
        "EmissionCeilingExceeded"
      );
    });

    it("rolls the epoch and restores the budget after 30 days", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      const ceiling = await token.emissionCeiling();
      await token.mint(buyer.address, ceiling);
      expect(await token.remainingEmission()).to.equal(0);

      await time.increase(31 * 24 * 3600);
      expect(await token.remainingEmission()).to.equal(ceiling);
      await expect(token.mint(buyer.address, ceiling)).to.emit(token, "EpochRolled");
    });

    it("only lets MINTER_ROLE mint", async () => {
      const { token, outsider } = await loadFixture(deployFixture);
      await expect(token.connect(outsider).mint(outsider.address, 1n)).to.be.revertedWithCustomError(
        token,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("lets governance lower the ceiling but never raise it past the hard bound", async () => {
      const { token } = await loadFixture(deployFixture);
      const lower = ethers.parseEther("1000000");
      await expect(token.setEmissionCeiling(lower)).to.emit(token, "EmissionCeilingUpdated");
      expect(await token.emissionCeiling()).to.equal(lower);

      const tooHigh = (await token.MAX_EPOCH_EMISSION()) + 1n;
      await expect(token.setEmissionCeiling(tooHigh)).to.be.revertedWithCustomError(
        token,
        "EmissionCeilingTooHigh"
      );
    });

    it("clamps to zero when the ceiling is lowered below what was already minted", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      await token.mint(buyer.address, ethers.parseEther("5000000"));
      await token.setEmissionCeiling(ethers.parseEther("1000000"));
      expect(await token.remainingEmission()).to.equal(0);
      await expect(token.mint(buyer.address, 1n)).to.be.revertedWithCustomError(token, "EmissionCeilingExceeded");
    });

    it("enforces the absolute cap", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      // Drain toward the cap epoch by epoch, then prove the cap itself binds.
      const ceiling = await token.emissionCeiling();
      for (let i = 0; i < 48; i++) {
        const remainingToCap = (await token.cap()) - (await token.totalSupply());
        if (remainingToCap === 0n) break;
        const amount = remainingToCap < ceiling ? remainingToCap : ceiling;
        await token.mint(buyer.address, amount);
        await time.increase(31 * 24 * 3600);
      }
      expect(await token.totalSupply()).to.equal(await token.cap());
      await expect(token.mint(buyer.address, 1n)).to.be.revertedWithCustomError(token, "ERC20ExceededCap");
    });
  });

  describe("votes & clock", () => {
    it("reports a timestamp-based clock", async () => {
      const { token } = await loadFixture(deployFixture);
      expect(await token.CLOCK_MODE()).to.equal("mode=timestamp");
      expect(await token.clock()).to.equal(BigInt(await time.latest()));
    });

    it("checkpoints voting power on delegation", async () => {
      const { token, provider } = await loadFixture(deployFixture);
      expect(await token.getVotes(provider.address)).to.equal(0);
      await token.connect(provider).delegate(provider.address);
      expect(await token.getVotes(provider.address)).to.equal(await token.balanceOf(provider.address));
    });

    it("exposes past votes for the governor snapshot", async () => {
      const { token, provider } = await loadFixture(deployFixture);
      await token.connect(provider).delegate(provider.address);
      const at = await time.latest();
      await time.increase(10);
      await token.connect(provider).transfer(ethers.Wallet.createRandom().address, ethers.parseEther("1000"));
      expect(await token.getPastVotes(provider.address, at)).to.equal(ethers.parseEther("1000000"));
    });
  });

  describe("burn & permit", () => {
    it("burns from the holder and reduces total supply", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      const before = await token.totalSupply();
      await token.connect(buyer).burn(ethers.parseEther("100"));
      expect(await token.totalSupply()).to.equal(before - ethers.parseEther("100"));
    });

    it("exposes an ERC-2612 nonce", async () => {
      const { token, buyer } = await loadFixture(deployFixture);
      expect(await token.nonces(buyer.address)).to.equal(0);
    });
  });
});
