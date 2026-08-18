// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

// NEXA token. ERC20 with a 1B cap, votes for governance, burnable.
// Minting is rate limited per epoch and only the timelock holds MINTER_ROLE.
contract NexusAIToken is ERC20, ERC20Burnable, ERC20Capped, ERC20Permit, ERC20Votes, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant EMISSION_MANAGER_ROLE = keccak256("EMISSION_MANAGER_ROLE");

    uint256 public constant MAX_SUPPLY = 1_000_000_000 ether;
    uint256 public constant EMISSION_EPOCH = 30 days;
    // hard bound governance can never raise the ceiling past
    uint256 public constant MAX_EPOCH_EMISSION = 12_500_000 ether;

    uint256 public emissionCeiling;
    uint256 public epochStart;
    uint256 public mintedThisEpoch;

    event EmissionCeilingUpdated(uint256 oldCeiling, uint256 newCeiling);
    event EpochRolled(uint256 newEpochStart);

    error EmissionCeilingTooHigh(uint256 requested, uint256 maximum);
    error EmissionCeilingExceeded(uint256 requested, uint256 remaining);
    error ZeroAddress();

    constructor(address treasury, uint256 genesisMint, address admin)
        ERC20("NexusAI", "NEXA")
        ERC20Capped(MAX_SUPPLY)
        ERC20Permit("NexusAI")
    {
        if (treasury == address(0) || admin == address(0)) revert ZeroAddress();

        emissionCeiling = MAX_EPOCH_EMISSION;
        epochStart = block.timestamp;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
        _grantRole(EMISSION_MANAGER_ROLE, admin);

        // genesis mint is not charged to the epoch budget, otherwise
        // mintedThisEpoch > emissionCeiling and remainingEmission() underflows
        if (genesisMint > 0) {
            _mint(treasury, genesisMint);
        }
    }

    // mint inside the current epoch budget. MINTER_ROLE is the timelock in prod.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _rollEpochIfNeeded();
        // ceiling can be lowered below what was already minted, so clamp at 0
        uint256 remaining = mintedThisEpoch >= emissionCeiling ? 0 : emissionCeiling - mintedThisEpoch;
        if (amount > remaining) revert EmissionCeilingExceeded(amount, remaining);
        mintedThisEpoch += amount;
        _mint(to, amount);
    }

    // set the per-epoch budget, anywhere from 0 up to MAX_EPOCH_EMISSION
    function setEmissionCeiling(uint256 newCeiling) external onlyRole(EMISSION_MANAGER_ROLE) {
        if (newCeiling > MAX_EPOCH_EMISSION) revert EmissionCeilingTooHigh(newCeiling, MAX_EPOCH_EMISSION);
        uint256 old = emissionCeiling;
        emissionCeiling = newCeiling;
        emit EmissionCeilingUpdated(old, newCeiling);
    }

    function remainingEmission() external view returns (uint256) {
        if (block.timestamp >= epochStart + EMISSION_EPOCH) return emissionCeiling;
        return mintedThisEpoch >= emissionCeiling ? 0 : emissionCeiling - mintedThisEpoch;
    }

    function _rollEpochIfNeeded() internal {
        if (block.timestamp >= epochStart + EMISSION_EPOCH) {
            uint256 elapsed = block.timestamp - epochStart;
            epochStart += (elapsed / EMISSION_EPOCH) * EMISSION_EPOCH;
            mintedThisEpoch = 0;
            emit EpochRolled(epochStart);
        }
    }

    // overrides the compiler makes us write because of multiple inheritance

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Capped, ERC20Votes)
    {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }
}
