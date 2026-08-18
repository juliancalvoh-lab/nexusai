// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// the parts of the staking vault the marketplace and governance need
interface IStakingVault {
    function stakedOf(address account) external view returns (uint256);

    function weightOf(address account) external view returns (uint256);

    // principal plus when it unlocks. the marketplace needs locked capital,
    // otherwise stake -> list -> unstake leaves nothing to slash (H-01)
    function bondOf(address account) external view returns (uint256 amount, uint64 unlockAt);

    function slash(address account, uint16 bps, string calldata reason) external returns (uint256 slashed);
}
