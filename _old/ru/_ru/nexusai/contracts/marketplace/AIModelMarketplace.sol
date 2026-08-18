// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAIPerformanceOracle} from "../interfaces/IAIPerformanceOracle.sol";
import {IComplianceRegistry} from "../interfaces/IComplianceRegistry.sol";
import {IStakingVault} from "../interfaces/IStakingVault.sol";

// Registry and settlement for AI model licences. Providers list against a bond,
// buyers pay in NEXA if they pass the compliance and oracle accuracy gates, and
// the provider's cut sits in escrow until the dispute window closes.
contract AIModelMarketplace is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");
    bytes32 public constant ARBITER_ROLE = keccak256("ARBITER_ROLE");
    bytes32 public constant CROSSCHAIN_ROLE = keccak256("CROSSCHAIN_ROLE");
    // held by SealedBidLicenceAuction so a won auction can issue a licence
    bytes32 public constant LICENCE_ISSUER_ROLE = keccak256("LICENCE_ISSUER_ROLE");

    uint16 public constant BPS = 10_000;
    uint16 public constant MAX_PROTOCOL_FEE_BPS = 1_000; // 10% hard ceiling

    enum DisputeState {
        None,
        Open,
        RefundedToBuyer,
        ReleasedToProvider
    }

    struct Model {
        address provider;
        uint96 price; // NEXA per licence
        bytes32 weightsHash; // integrity commitment over the model artifact
        string metadataURI; // ipfs://... model card, eval protocol, licence terms
        uint16 minAccuracyBps; // quality floor enforced against the oracle
        uint32 licenceTerm; // seconds of entitlement per purchase
        bool requiresCompliance;
        bool active;
        uint64 listedAt;
        uint64 originChain; // chain selector where the model was first registered
    }

    // param bundle for mirrorModel
    struct MirrorParams {
        bytes32 modelId;
        address provider;
        uint96 price;
        bytes32 weightsHash;
        string metadataURI;
        uint16 minAccuracyBps;
        uint32 licenceTerm;
        bool requiresCompliance;
        uint64 srcChain;
    }

    struct Purchase {
        bytes32 modelId;
        address buyer;
        uint96 amount; // provider share held in escrow
        uint64 releaseAt;
        DisputeState dispute;
        bool settled;
    }

    IERC20 public immutable paymentToken;
    IAIPerformanceOracle public oracle;
    IComplianceRegistry public compliance;
    IStakingVault public stakingVault;

    address public treasury;
    uint16 public protocolFeeBps = 500; // 5%
    uint16 public burnShareBps = 3_000; // 30% of the fee is burned
    uint32 public disputeWindow = 7 days;
    // how much a provider has to have staked before listing
    uint256 public minProviderBond = 10_000 ether;
    // and it has to stay locked at least this long after listing
    uint32 public minBondLock = 90 days;

    uint256 private _seq;

    mapping(bytes32 => Model) private _models;
    bytes32[] private _modelIds;
    // modelId => buyer => licence expiry
    mapping(bytes32 => mapping(address => uint64)) public licenceExpiry;
    mapping(bytes32 => Purchase) private _purchases;
    // lifetime revenue per model, only used for analytics
    mapping(bytes32 => uint256) public grossRevenue;
    // modelId => when the exclusive licence runs out
    mapping(bytes32 => uint64) public exclusiveUntil;
    // modelId => exclusive licence holder
    mapping(bytes32 => address) public exclusiveHolder;

    event ModelRegistered(
        bytes32 indexed modelId, address indexed provider, uint96 price, uint16 minAccuracyBps, string metadataURI
    );
    event ModelUpdated(bytes32 indexed modelId, uint96 price, uint16 minAccuracyBps, bool active);
    event ModelDelisted(bytes32 indexed modelId, string reason);
    event LicencePurchased(
        bytes32 indexed purchaseId,
        bytes32 indexed modelId,
        address indexed buyer,
        uint256 price,
        uint256 fee,
        uint256 burned,
        uint64 expiresAt,
        bytes32 keyReference
    );
    event EscrowReleased(bytes32 indexed purchaseId, address indexed provider, uint256 amount);
    event DisputeOpened(bytes32 indexed purchaseId, address indexed buyer, string reason);
    event DisputeResolved(bytes32 indexed purchaseId, DisputeState outcome, uint256 amount);
    event ExclusiveLicenceIssued(bytes32 indexed modelId, address indexed holder, uint64 until);
    event MirroredLicence(bytes32 indexed modelId, address indexed holder, uint64 expiresAt, uint64 srcChain);
    event MirroredModel(bytes32 indexed modelId, uint64 srcChain, address provider);
    event ParametersUpdated(
        uint16 protocolFeeBps, uint16 burnShareBps, uint32 disputeWindow, uint256 minProviderBond, uint32 minBondLock
    );
    event DependenciesUpdated(address oracle, address compliance, address stakingVault, address treasury);

    error ZeroAddress();
    error InvalidFee(uint16 bps);
    error UnknownModel(bytes32 modelId);
    error NotProvider(address caller);
    error ModelInactive(bytes32 modelId);
    error InsufficientBond(uint256 have, uint256 need);
    error BondNotLocked(uint64 unlockAt, uint64 required);
    error NotCompliant(address account);
    error QualityGateFailed(bytes32 modelId, uint32 observedBps, uint16 requiredBps);
    error OracleUnusable(bytes32 modelId);
    error UnknownPurchase(bytes32 purchaseId);
    error EscrowNotMature(uint64 releaseAt);
    error AlreadySettled();
    error DisputeWindowClosed();
    error NotBuyer();
    error NoOpenDispute();
    error InvalidAccuracy(uint16 bps);
    error ExclusivelyLicensed(bytes32 modelId, address holder, uint64 until);

    constructor(
        IERC20 paymentToken_,
        IAIPerformanceOracle oracle_,
        IComplianceRegistry compliance_,
        IStakingVault stakingVault_,
        address treasury_,
        address admin
    ) {
        if (
            address(paymentToken_) == address(0) || address(oracle_) == address(0)
                || address(compliance_) == address(0) || address(stakingVault_) == address(0) || treasury_ == address(0)
                || admin == address(0)
        ) revert ZeroAddress();

        paymentToken = paymentToken_;
        oracle = oracle_;
        compliance = compliance_;
        stakingVault = stakingVault_;
        treasury = treasury_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_ADMIN_ROLE, admin);
        _grantRole(ARBITER_ROLE, admin);
    }

    function registerModel(
        string calldata metadataURI,
        bytes32 weightsHash,
        uint96 price,
        uint16 minAccuracyBps,
        uint32 licenceTerm,
        bool requiresCompliance
    ) external whenNotPaused returns (bytes32 modelId) {
        if (minAccuracyBps > BPS) revert InvalidAccuracy(minAccuracyBps);

        // has to be a locked position, otherwise a provider could stake, list and
        // unstake straight away and leave nothing to slash.
        // a bond of 0 turns bonding off, spoke chains only mirror listings anyway
        if (minProviderBond > 0) {
            (uint256 bond, uint64 unlockAt) = stakingVault.bondOf(msg.sender);
            if (bond < minProviderBond) revert InsufficientBond(bond, minProviderBond);
            if (unlockAt < block.timestamp + minBondLock) {
                revert BondNotLocked(unlockAt, uint64(block.timestamp) + minBondLock);
            }
        }

        modelId = keccak256(abi.encode(msg.sender, weightsHash, ++_seq, block.chainid));

        _models[modelId] = Model({
            provider: msg.sender,
            price: price,
            weightsHash: weightsHash,
            metadataURI: metadataURI,
            minAccuracyBps: minAccuracyBps,
            licenceTerm: licenceTerm,
            requiresCompliance: requiresCompliance,
            active: true,
            listedAt: uint64(block.timestamp),
            originChain: uint64(block.chainid)
        });
        _modelIds.push(modelId);

        emit ModelRegistered(modelId, msg.sender, price, minAccuracyBps, metadataURI);
    }

    function updateModel(bytes32 modelId, uint96 price, uint16 minAccuracyBps, bool active) external {
        Model storage m = _models[modelId];
        if (m.provider == address(0)) revert UnknownModel(modelId);
        if (m.provider != msg.sender) revert NotProvider(msg.sender);
        if (minAccuracyBps > BPS) revert InvalidAccuracy(minAccuracyBps);

        m.price = price;
        m.minAccuracyBps = minAccuracyBps;
        m.active = active;
        emit ModelUpdated(modelId, price, minAccuracyBps, active);
    }

    // admin kill switch for one listing
    function delistModel(bytes32 modelId, string calldata reason) external onlyRole(MARKET_ADMIN_ROLE) {
        Model storage m = _models[modelId];
        if (m.provider == address(0)) revert UnknownModel(modelId);
        m.active = false;
        emit ModelDelisted(modelId, reason);
    }

    // keyReference is an IPFS CID of the encrypted artifact key, so the key
    // itself never goes on-chain
    function purchaseLicence(bytes32 modelId, bytes32 keyReference)
        external
        nonReentrant
        whenNotPaused
        returns (bytes32 purchaseId)
    {
        Model memory m = _models[modelId];
        if (m.provider == address(0)) revert UnknownModel(modelId);
        if (!m.active) revert ModelInactive(modelId);

        // an auction winner holds the model exclusively for the term
        if (exclusiveUntil[modelId] > block.timestamp && exclusiveHolder[modelId] != msg.sender) {
            revert ExclusivelyLicensed(modelId, exclusiveHolder[modelId], exclusiveUntil[modelId]);
        }

        // compliance
        if (m.requiresCompliance && !compliance.isEligible(msg.sender)) revert NotCompliant(msg.sender);

        // accuracy floor from the oracle
        if (m.minAccuracyBps > 0) {
            if (!oracle.isUsable(modelId)) revert OracleUnusable(modelId);
            // drop the timestamp, isUsable() above already covers staleness
            // and the breaker
            (uint32 observed,) = oracle.accuracyOf(modelId);
            if (observed < m.minAccuracyBps) revert QualityGateFailed(modelId, observed, m.minAccuracyBps);
        }

        (uint256 fee, uint256 burnAmount) = _settlePayment(m.price);
        uint64 expiresAt = _extendLicence(modelId, msg.sender, m.licenceTerm);

        purchaseId = keccak256(abi.encode(modelId, msg.sender, ++_seq, block.timestamp));
        _purchases[purchaseId] = Purchase({
            modelId: modelId,
            buyer: msg.sender,
            amount: uint96(m.price - fee),
            releaseAt: uint64(block.timestamp + disputeWindow),
            dispute: DisputeState.None,
            settled: false
        });

        grossRevenue[modelId] += m.price;

        emit LicencePurchased(purchaseId, modelId, msg.sender, m.price, fee, burnAmount, expiresAt, keyReference);
    }

    // pulls the price in, burns part of the fee, rest goes to the treasury
    function _settlePayment(uint256 price) internal returns (uint256 fee, uint256 burnAmount) {
        fee = (price * protocolFeeBps) / BPS;
        burnAmount = (fee * burnShareBps) / BPS;
        uint256 treasuryAmount = fee - burnAmount;

        paymentToken.safeTransferFrom(msg.sender, address(this), price);
        if (burnAmount > 0) ERC20Burnable(address(paymentToken)).burn(burnAmount);
        if (treasuryAmount > 0) paymentToken.safeTransfer(treasury, treasuryAmount);
    }

    // buying again while a licence is live stacks the term instead of resetting it
    function _extendLicence(bytes32 modelId, address buyer, uint32 licenceTerm) internal returns (uint64 expiresAt) {
        uint64 current = licenceExpiry[modelId][buyer];
        expiresAt = current > block.timestamp
            ? current + licenceTerm
            : uint64(block.timestamp) + licenceTerm;
        licenceExpiry[modelId][buyer] = expiresAt;
    }

    function hasActiveLicence(bytes32 modelId, address account) external view returns (bool) {
        return licenceExpiry[modelId][account] > block.timestamp;
    }

    function releaseEscrow(bytes32 purchaseId) external nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        if (p.buyer == address(0)) revert UnknownPurchase(purchaseId);
        if (p.settled) revert AlreadySettled();
        if (p.dispute == DisputeState.Open) revert NoOpenDispute();
        if (block.timestamp < p.releaseAt) revert EscrowNotMature(p.releaseAt);

        p.settled = true;
        address provider = _models[p.modelId].provider;
        uint256 amount = p.amount;
        paymentToken.safeTransfer(provider, amount);
        emit EscrowReleased(purchaseId, provider, amount);
    }

    function openDispute(bytes32 purchaseId, string calldata reason) external {
        Purchase storage p = _purchases[purchaseId];
        if (p.buyer == address(0)) revert UnknownPurchase(purchaseId);
        if (p.buyer != msg.sender) revert NotBuyer();
        if (p.settled) revert AlreadySettled();
        if (block.timestamp >= p.releaseAt) revert DisputeWindowClosed();

        p.dispute = DisputeState.Open;
        emit DisputeOpened(purchaseId, msg.sender, reason);
    }

    // refundBuyer true pays the buyer back out of escrow, false pays the provider.
    // slashing the bond is a separate governance call on StakingVault.
    function resolveDispute(bytes32 purchaseId, bool refundBuyer) external onlyRole(ARBITER_ROLE) nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        if (p.buyer == address(0)) revert UnknownPurchase(purchaseId);
        if (p.settled) revert AlreadySettled();
        if (p.dispute != DisputeState.Open) revert NoOpenDispute();

        p.settled = true;
        uint256 amount = p.amount;

        if (refundBuyer) {
            p.dispute = DisputeState.RefundedToBuyer;
            licenceExpiry[p.modelId][p.buyer] = uint64(block.timestamp);
            paymentToken.safeTransfer(p.buyer, amount);
        } else {
            p.dispute = DisputeState.ReleasedToProvider;
            paymentToken.safeTransfer(_models[p.modelId].provider, amount);
        }
        emit DisputeResolved(purchaseId, p.dispute, amount);
    }

    // called by the auction contract after someone wins
    function issueExclusiveLicence(bytes32 modelId, address holder, uint32 term)
        external
        onlyRole(LICENCE_ISSUER_ROLE)
    {
        Model memory m = _models[modelId];
        if (m.provider == address(0)) revert UnknownModel(modelId);

        // recheck the model's own compliance flag. the auction has its own flag
        // and the seller sets that one.
        if (m.requiresCompliance && !compliance.isEligible(holder)) revert NotCompliant(holder);

        uint64 until = uint64(block.timestamp) + term;
        exclusiveUntil[modelId] = until;
        exclusiveHolder[modelId] = holder;
        if (until > licenceExpiry[modelId][holder]) licenceExpiry[modelId][holder] = until;

        emit ExclusiveLicenceIssued(modelId, holder, until);
    }

    // mirror a model that was registered on another chain. takes a struct because
    // the flat arg list hit the stack limit.
    function mirrorModel(MirrorParams calldata p) external onlyRole(CROSSCHAIN_ROLE) {
        Model storage existing = _models[p.modelId];
        bool isNew = existing.provider == address(0);
        if (isNew) _modelIds.push(p.modelId);

        // keep the local active flag and listedAt on an update, so a local
        // delisting does not get undone by the next mirror
        _models[p.modelId] = Model({
            provider: p.provider,
            price: p.price,
            weightsHash: p.weightsHash,
            metadataURI: p.metadataURI,
            minAccuracyBps: p.minAccuracyBps,
            licenceTerm: p.licenceTerm,
            requiresCompliance: p.requiresCompliance,
            active: isNew ? true : existing.active,
            listedAt: isNew ? uint64(block.timestamp) : existing.listedAt,
            originChain: p.srcChain
        });
        emit MirroredModel(p.modelId, p.srcChain, p.provider);
    }

    // licence that was paid for on some other chain
    function mirrorLicence(bytes32 modelId, address holder, uint64 expiresAt, uint64 srcChain)
        external
        onlyRole(CROSSCHAIN_ROLE)
    {
        if (expiresAt > licenceExpiry[modelId][holder]) {
            licenceExpiry[modelId][holder] = expiresAt;
        }
        emit MirroredLicence(modelId, holder, expiresAt, srcChain);
    }

    function modelOf(bytes32 modelId) external view returns (Model memory) {
        Model memory m = _models[modelId];
        if (m.provider == address(0)) revert UnknownModel(modelId);
        return m;
    }

    function purchaseOf(bytes32 purchaseId) external view returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    function modelCount() external view returns (uint256) {
        return _modelIds.length;
    }

    function modelIdAt(uint256 index) external view returns (bytes32) {
        return _modelIds[index];
    }

    function setParameters(
        uint16 protocolFeeBps_,
        uint16 burnShareBps_,
        uint32 disputeWindow_,
        uint256 minProviderBond_,
        uint32 minBondLock_
    ) external onlyRole(MARKET_ADMIN_ROLE) {
        if (protocolFeeBps_ > MAX_PROTOCOL_FEE_BPS) revert InvalidFee(protocolFeeBps_);
        if (burnShareBps_ > BPS) revert InvalidFee(burnShareBps_);
        protocolFeeBps = protocolFeeBps_;
        burnShareBps = burnShareBps_;
        disputeWindow = disputeWindow_;
        minProviderBond = minProviderBond_;
        minBondLock = minBondLock_;
        emit ParametersUpdated(protocolFeeBps_, burnShareBps_, disputeWindow_, minProviderBond_, minBondLock_);
    }

    function setDependencies(
        IAIPerformanceOracle oracle_,
        IComplianceRegistry compliance_,
        IStakingVault stakingVault_,
        address treasury_
    ) external onlyRole(MARKET_ADMIN_ROLE) {
        if (
            address(oracle_) == address(0) || address(compliance_) == address(0) || address(stakingVault_) == address(0)
                || treasury_ == address(0)
        ) revert ZeroAddress();
        oracle = oracle_;
        compliance = compliance_;
        stakingVault = stakingVault_;
        treasury = treasury_;
        emit DependenciesUpdated(address(oracle_), address(compliance_), address(stakingVault_), treasury_);
    }

    function pause() external onlyRole(MARKET_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(MARKET_ADMIN_ROLE) {
        _unpause();
    }
}
