module.exports = {
  // mocks/ only holds the hostile ERC-20 for the reentrancy test, which is never deployed
  skipFiles: ["mocks/"],
  configureYulOptimizer: true,
  mocha: {
    timeout: 200000,
  },
};
