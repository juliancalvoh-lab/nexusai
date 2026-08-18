const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;

// per-network settings. role decides what gets deployed: full stack on a hub,
// marketplace + compliance only on a spoke.
const NETWORKS = {
  hardhat: { role: "local", chainSelector: 31337n, label: "Hardhat" },
  localhost: { role: "local", chainSelector: 31337n, label: "Localhost" },
  sepolia: { role: "hub", chainSelector: 11155111n, label: "Ethereum Sepolia" },
  baseSepolia: { role: "spoke", chainSelector: 84532n, label: "Base Sepolia" },
  arbitrumSepolia: { role: "spoke", chainSelector: 421614n, label: "Arbitrum Sepolia" },
  amoy: { role: "spoke", chainSelector: 80002n, label: "Polygon Amoy" },
  hoodi: { role: "spoke", chainSelector: 560048n, label: "Ethereum Hoodi" },
};

const PARAMS = {
  token: {
    genesisMint: ethers.parseEther("400000000"), // hub only
  },
  timelock: {
    minDelay: 2 * DAY,
  },
  governor: {
    votingDelay: DAY,
    votingPeriod: 5 * DAY,
    proposalThreshold: ethers.parseEther("250000"),
    quorumPercent: 4,
  },
  oracle: {
    minQuorum: 3,
    stalenessWindow: DAY,
    maxDeviationBps: 1500,
  },
  marketplace: {
    protocolFeeBps: 500,
    burnShareBps: 3000,
    disputeWindow: 7 * DAY,
    minProviderBond: ethers.parseEther("10000"),
    minBondLock: 90 * DAY,
  },
  router: {
    baseFee: ethers.parseEther("0.0001"),
  },
};

module.exports = { NETWORKS, PARAMS, DAY };
