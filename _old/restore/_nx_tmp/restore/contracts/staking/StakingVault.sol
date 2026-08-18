// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IStakingVault} from "../interfaces/IStakingVault.sol";

// Locked NEXA staking. Longer lock tiers get a bigger weight multiplier, and
// rewards stream on weight using the usual Synthetix accounting. Provider bonds
// live here too, so governance can slash them.
contract StakingVault is AccessControl, ReentrancyGuard, Pausable, IStakingVault {
    using SafeERC20 for IERC20;

    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 public constant REWARD_MANAGER_ROLE = keccak256("REWARD_MANAGER_ROLE");
    bytes32 public constant VAULT_ADMIN_ROLE = keccak256("VAULT_ADMIN_ROLE");

    uint256 public constant PRECISION = 1e18;
    uint16 public constant MAX_SLASH_BPS = 3_000; // 30% ceiling per slash event
    uint16 public constant BPS = 10_000;

    struct Tier {
        uint32 lockPeriod;
        uint16 multiplierBps;
        bool enabled;
    }

    struct Position {
        uint128 amount;
        uint128 weight;
        uint64 unlockAt;
        uint8 tier;
    }

    IERC20 public immutable stakingToken;
    address public treasury;

    Tier[] public tiers;
    mapping(address => Position) private _positions;

    uint256 public totalStaked;
    uint256 public totalWeight;

    uint256 public rewardRate; // NEXA per second
    uint256 public periodFinish;
    uint256 public lastUpdateTime;
    uint256 public rewardPerWeightStored;
    uint256 public rewardsEscrowed; // funded-but-undistributed rewards held by this contract

    mapping(address => uint256) public userRewardPerWeightPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed account, uint256 amount, uint8 tier, uint64 unlockAt, uint256 weight);
    event Unstaked(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardFunded(uint256 amount, uint256 duration, uint256 rewardRate);
    event Slashed(address indexed account, uint256 amount, uint16 bps, string reason);
    event TierConfigured(uint8 indexed tierId, uint32 lockPeriod, uint16 multiplierBps, bool enabled);
    event TreasuryUpdated(address indexed treasury);
    event EmergencyWithdrawn(address indexed account, uint256 amount, uint256 forfeitedRewards);

    error ZeroAmount();
    error ZeroAddress();
    error UnknownTier(uint8 tier);
    error TierDisabled(uint8 tier);
    error TierDowngrade(uint8 current, uint8 requested);
    error StillLocked(uint64 unlockAt);
    error InsufficientStake(uint256 requested, uint256 available);
    error SlashTooLarge(uint16 bps);
    error RewardTooHigh();
    error NoPosition();

    constructor(IERC20 stakingToken_, address treasury_, address admin) {
        if (address(stakingToken_) == address(0) || treasury_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        stakingToken = stakingToken_;
        treasury = treasury_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VAULT_ADMIN_ROLE, admin);
        _grantRole(REWARD_MANAGER_ROLE, admin);

        // tier 0 flexible, then 90d / 180d / 365d
        tiers.push(Tier({lockPeriod: 0, multiplierBps: 10_000, enabled: true}));
        tiers.push(Tier({lockPeriod: 90 days, multiplierBps: 12_500, enabled: true}));
        tiers.push(Tier({lockPeriod: 180 days, multiplierBps: 16_000, enabled: true}));
        tiers.push(Tier({lockPeriod: 365 days, multiplierBps: 22_000, enabled: true}));
    }

    modifier updateReward(address account) {
        rewardPerWeightStored = rewardPerWeight();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerWeightPaid[account] = rewardPerWeightStored;
        }
        _;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerWeight() public view returns (uint256) {
        if (totalWeight == 0) return rewardPerWeightStored;
        return rewardPerWeightStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * PRECISION) / totalWeight;
    }

    function earned(address account) public view returns (uint256) {
        Position memory p = _positions[account];
        return (uint256(p.weight) * (rewardPerWeight() - userRewardPerWeightPaid[account])) / PRECISION
            + rewards[account];
    }

    function stakedOf(address account) external view returns (uint256) {
        return _positions[account].amount;
    }

    function weightOf(address account) external view returns (uint256) {
        return _positions[account].weight;
    }

    function bondOf(address account) external view returns (uint256 amount, uint64 unlockAt) {
        Position memory p = _positions[account];
        return (p.amount, p.unlockAt);
    }

    function positionOf(address account) external view returns (Position memory) {
        return _positions[account];
    }

    function tierCount() external view returns (uint256) {
        return tiers.length;
    }

    // topping up an existing position needs the same or a longer tier, and it
    // restarts the lock
    function stake(uint256 amount, uint8 tier) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (tier >= tiers.length) revert UnknownTier(tier);
        Tier memory t = tiers[tier];
        if (!t.enabled) revert TierDisabled(tier);

        Position storage p = _positions[msg.sender];
        if (p.amount > 0 && tier < p.tier) revert TierDowngrade(p.tier, tier);

        stakingToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 newAmount = uint256(p.amount) + amount;
        uint256 newWeight = (newAmount * t.multiplierBps) / BPS;

        totalStaked += amount;
        totalWeight = totalWeight - p.weight + newWeight;

        uint64 unlockAt = uint64(block.timestamp + t.lockPeriod);
        p.amount = uint128(newAmount);
        p.weight = uint128(newWeight);
        p.tier = tier;
        p.unlockAt = unlockAt;

        emit Staked(msg.sender, amount, tier, unlockAt, newWeight);
    }

    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        Position storage p = _positions[msg.sender];
        if (p.amount == 0) revert NoPosition();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.amount) revert InsufficientStake(amount, p.amount);
        if (block.timestamp < p.unlockAt) revert StillLocked(p.unlockAt);

        uint256 newAmount = uint256(p.amount) - amount;
        uint256 newWeight = (newAmount * tiers[p.tier].multiplierBps) / BPS;

        totalStaked -= amount;
        totalWeight = totalWeight - p.weight + newWeight;

        p.amount = uint128(newAmount);
        p.weight = uint128(newWeight);

        stakingToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    function claimRewards() public nonReentrant updateReward(msg.sender) returns (uint256 reward) {
        reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsEscrowed -= reward;
            stakingToken.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    // paused-only escape hatch. gets principal out but you lose accrued rewards.
    // paused-only so nobody uses it to skip a lock in normal operation
    function emergencyWithdraw() external nonReentrant whenPaused {
        Position storage p = _positions[msg.sender];
        uint256 amount = p.amount;
        if (amount == 0) revert NoPosition();

        uint256 forfeited = earned(msg.sender);

        totalStaked -= amount;
        totalWeight -= p.weight;
        delete _positions[msg.sender];
        rewards[msg.sender] = 0;
        userRewardPerWeightPaid[msg.sender] = rewardPerWeight();

        stakingToken.safeTransfer(msg.sender, amount);
        emit EmergencyWithdrawn(msg.sender, amount, forfeited);
    }

    // pulls the tokens up front so the schedule is always fully funded
    function fundRewards(uint256 amount, uint256 duration)
        external
        onlyRole(REWARD_MANAGER_ROLE)
        updateReward(address(0))
    {
        if (amount == 0 || duration == 0) revert ZeroAmount();
        stakingToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardsEscrowed += amount;

        if (block.timestamp >= periodFinish) {
            rewardRate = amount / duration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            rewardRate = (amount + leftover) / duration;
        }
        if (rewardRate == 0) revert RewardTooHigh();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + duration;
        emit RewardFunded(amount, duration, rewardRate);
    }

    // slash part of a bond to the treasury. SLASHER_ROLE is the timelock in prod.
    function slash(address account, uint16 bps, string calldata reason)
        external
        onlyRole(SLASHER_ROLE)
        updateReward(account)
        returns (uint256 slashed)
    {
        if (bps == 0 || bps > MAX_SLASH_BPS) revert SlashTooLarge(bps);
        Position storage p = _positions[account];
        if (p.amount == 0) revert NoPosition();

        slashed = (uint256(p.amount) * bps) / BPS;
        uint256 newAmount = uint256(p.amount) - slashed;
        uint256 newWeight = (newAmount * tiers[p.tier].multiplierBps) / BPS;

        totalStaked -= slashed;
        totalWeight = totalWeight - p.weight + newWeight;

        p.amount = uint128(newAmount);
        p.weight = uint128(newWeight);

        stakingToken.safeTransfer(treasury, slashed);
        emit Slashed(account, slashed, bps, reason);
    }

    function configureTier(uint8 tierId, uint32 lockPeriod, uint16 multiplierBps, bool enabled)
        external
        onlyRole(VAULT_ADMIN_ROLE)
    {
        if (tierId > tiers.length) revert UnknownTier(tierId);
        if (tierId == tiers.length) {
            tiers.push(Tier({lockPeriod: lockPeriod, multiplierBps: multiplierBps, enabled: enabled}));
        } else {
            tiers[tierId] = Tier({lockPeriod: lockPeriod, multiplierBps: multiplierBps, enabled: enabled});
        }
        emit TierConfigured(tierId, lockPeriod, multiplierBps, enabled);
    }

    function setTreasury(address treasury_) external onlyRole(VAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function pause() external onlyRole(VAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(VAULT_ADMIN_ROLE) {
        _unpause();
    }
}
