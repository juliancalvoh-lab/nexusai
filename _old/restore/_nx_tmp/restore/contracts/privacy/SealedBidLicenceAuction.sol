// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IComplianceRegistry} from "../interfaces/IComplianceRegistry.sol";
import {AIModelMarketplace} from "../marketplace/AIModelMarketplace.sol";

// Commit-reveal sealed bid auction for exclusive model licences. Every bidder
// posts the same collateral with their commitment so the deposit gives nothing
// away, then reveals, then the highest bid wins. Not revealing costs a penalty.
contract SealedBidLicenceAuction is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant AUCTION_ADMIN_ROLE = keccak256("AUCTION_ADMIN_ROLE");
    uint16 public constant BPS = 10_000;

    enum Phase {
        None,
        Commit,
        Reveal,
        Settled,
        Cancelled
    }

    struct Auction {
        bytes32 modelId;
        address seller;
        uint96 reservePrice;
        uint96 collateral; // uniform deposit every bidder must post
        uint64 commitEnd;
        uint64 revealEnd;
        address highBidder;
        uint96 highBid;
        uint32 exclusivityTerm; // seconds of exclusivity granted to the winner
        bool requiresCompliance;
        Phase phase;
    }

    struct Bid {
        bytes32 commitment;
        uint96 deposit;
        uint96 revealedAmount;
        bool revealed;
        bool withdrawn;
    }

    IERC20 public immutable paymentToken;
    IComplianceRegistry public compliance;
    // optional. when set, settling issues the exclusive licence on-chain.
    AIModelMarketplace public marketplace;
    uint16 public noRevealPenaltyBps = 2_000; // 20% of collateral

    uint256 private _auctionSeq;
    mapping(uint256 => Auction) private _auctions;
    mapping(uint256 => mapping(address => Bid)) private _bids;
    mapping(uint256 => uint256) public bidderCount;

    event AuctionCreated(
        uint256 indexed auctionId,
        bytes32 indexed modelId,
        address indexed seller,
        uint96 reservePrice,
        uint96 collateral,
        uint64 commitEnd,
        uint64 revealEnd
    );
    event BidCommitted(uint256 indexed auctionId, address indexed bidder, bytes32 commitment, uint96 deposit);
    event BidRevealed(uint256 indexed auctionId, address indexed bidder, uint96 amount, bool isHighest);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint96 winningBid);
    event AuctionCancelled(uint256 indexed auctionId, string reason);
    event CollateralWithdrawn(uint256 indexed auctionId, address indexed bidder, uint256 refunded, uint256 penalty);
    event PenaltyUpdated(uint16 bps);
    event ComplianceUpdated(address compliance);
    event MarketplaceUpdated(address marketplace);
    event ExclusiveLicenceIssued(uint256 indexed auctionId, bytes32 indexed modelId, address indexed winner);
    event ExclusiveLicenceIssuanceFailed(uint256 indexed auctionId, bytes32 indexed modelId, address indexed winner);

    error ZeroAddress();
    error BadWindow();
    error UnknownAuction(uint256 auctionId);
    error WrongPhase(Phase expected, Phase actual);
    error CommitClosed();
    error RevealClosed();
    error RevealNotOpen();
    error AlreadyCommitted();
    error NoCommitment();
    error AlreadyRevealed();
    error BadReveal();
    error BidExceedsDeposit(uint96 amount, uint96 deposit);
    error BelowReserve(uint96 amount, uint96 reserve);
    error NotCompliant(address account);
    error NotSeller();
    error AlreadyWithdrawn();
    error WinnerCannotWithdraw();
    error InvalidPenalty(uint16 bps);
    error AuctionNotOver();

    constructor(IERC20 paymentToken_, IComplianceRegistry compliance_, address admin) {
        if (address(paymentToken_) == address(0) || address(compliance_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        paymentToken = paymentToken_;
        compliance = compliance_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUCTION_ADMIN_ROLE, admin);
    }

    function createAuction(
        bytes32 modelId,
        uint96 reservePrice,
        uint96 collateral,
        uint64 commitDuration,
        uint64 revealDuration,
        uint32 exclusivityTerm,
        bool requiresCompliance
    ) external returns (uint256 auctionId) {
        if (commitDuration == 0 || revealDuration == 0) revert BadWindow();
        if (collateral < reservePrice) revert BadWindow();

        auctionId = ++_auctionSeq;
        uint64 commitEnd = uint64(block.timestamp) + commitDuration;
        uint64 revealEnd = commitEnd + revealDuration;

        _auctions[auctionId] = Auction({
            modelId: modelId,
            seller: msg.sender,
            reservePrice: reservePrice,
            collateral: collateral,
            commitEnd: commitEnd,
            revealEnd: revealEnd,
            highBidder: address(0),
            highBid: 0,
            exclusivityTerm: exclusivityTerm,
            requiresCompliance: requiresCompliance,
            phase: Phase.Commit
        });

        emit AuctionCreated(auctionId, modelId, msg.sender, reservePrice, collateral, commitEnd, revealEnd);
    }

    // commitment is keccak256(abi.encode(msg.sender, amount, salt)). the sender
    // goes in the hash so nobody can copy someone else's commitment.
    function commitBid(uint256 auctionId, bytes32 commitment) external nonReentrant {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert UnknownAuction(auctionId);
        if (a.phase != Phase.Commit) revert WrongPhase(Phase.Commit, a.phase);
        if (block.timestamp >= a.commitEnd) revert CommitClosed();
        if (a.requiresCompliance && !compliance.isEligible(msg.sender)) revert NotCompliant(msg.sender);
        if (_bids[auctionId][msg.sender].commitment != bytes32(0)) revert AlreadyCommitted();

        paymentToken.safeTransferFrom(msg.sender, address(this), a.collateral);

        _bids[auctionId][msg.sender] =
            Bid({commitment: commitment, deposit: a.collateral, revealedAmount: 0, revealed: false, withdrawn: false});
        bidderCount[auctionId] += 1;

        emit BidCommitted(auctionId, msg.sender, commitment, a.collateral);
    }

    function revealBid(uint256 auctionId, uint96 amount, bytes32 salt) external nonReentrant {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert UnknownAuction(auctionId);
        if (block.timestamp < a.commitEnd) revert RevealNotOpen();
        if (block.timestamp >= a.revealEnd) revert RevealClosed();
        if (a.phase == Phase.Commit) a.phase = Phase.Reveal;
        if (a.phase != Phase.Reveal) revert WrongPhase(Phase.Reveal, a.phase);

        Bid storage b = _bids[auctionId][msg.sender];
        if (b.commitment == bytes32(0)) revert NoCommitment();
        if (b.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encode(msg.sender, amount, salt)) != b.commitment) revert BadReveal();
        if (amount > b.deposit) revert BidExceedsDeposit(amount, b.deposit);
        if (amount < a.reservePrice) revert BelowReserve(amount, a.reservePrice);

        b.revealed = true;
        b.revealedAmount = amount;

        bool isHighest = amount > a.highBid;
        if (isHighest) {
            a.highBid = amount;
            a.highBidder = msg.sender;
        }
        emit BidRevealed(auctionId, msg.sender, amount, isHighest);
    }

    // close after the reveal window and pay the seller
    function settle(uint256 auctionId) external nonReentrant {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert UnknownAuction(auctionId);
        if (block.timestamp < a.revealEnd) revert AuctionNotOver();
        if (a.phase == Phase.Settled || a.phase == Phase.Cancelled) revert WrongPhase(Phase.Reveal, a.phase);

        a.phase = Phase.Settled;

        if (a.highBidder != address(0)) {
            Bid storage w = _bids[auctionId][a.highBidder];
            uint256 refund = uint256(w.deposit) - uint256(a.highBid);
            w.withdrawn = true;
            paymentToken.safeTransfer(a.seller, a.highBid);
            if (refund > 0) paymentToken.safeTransfer(a.highBidder, refund);

            // issue the licence, best effort only. the model might not be listed
            // on this chain and settlement should not brick over that, so a
            // failure just emits an event.
            if (address(marketplace) != address(0)) {
                try marketplace.issueExclusiveLicence(a.modelId, a.highBidder, a.exclusivityTerm) {
                    emit ExclusiveLicenceIssued(auctionId, a.modelId, a.highBidder);
                } catch {
                    emit ExclusiveLicenceIssuanceFailed(auctionId, a.modelId, a.highBidder);
                }
            }
        }

        emit AuctionSettled(auctionId, a.highBidder, a.highBid);
    }

    // losers get their collateral back, non-revealers lose the penalty cut
    function withdrawCollateral(uint256 auctionId) external nonReentrant {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert UnknownAuction(auctionId);
        if (a.phase != Phase.Settled && a.phase != Phase.Cancelled) revert WrongPhase(Phase.Settled, a.phase);
        if (msg.sender == a.highBidder && a.phase == Phase.Settled) revert WinnerCannotWithdraw();

        Bid storage b = _bids[auctionId][msg.sender];
        if (b.commitment == bytes32(0)) revert NoCommitment();
        if (b.withdrawn) revert AlreadyWithdrawn();

        b.withdrawn = true;
        uint256 deposit = b.deposit;
        uint256 penalty = 0;

        if (!b.revealed && a.phase == Phase.Settled) {
            penalty = (deposit * noRevealPenaltyBps) / BPS;
            if (penalty > 0) paymentToken.safeTransfer(a.seller, penalty);
        }

        uint256 refund = deposit - penalty;
        if (refund > 0) paymentToken.safeTransfer(msg.sender, refund);
        emit CollateralWithdrawn(auctionId, msg.sender, refund, penalty);
    }

    // seller can only cancel during commit, then everyone gets collateral back
    function cancelAuction(uint256 auctionId, string calldata reason) external {
        Auction storage a = _auctions[auctionId];
        if (a.seller == address(0)) revert UnknownAuction(auctionId);
        if (a.seller != msg.sender && !hasRole(AUCTION_ADMIN_ROLE, msg.sender)) revert NotSeller();
        if (a.phase != Phase.Commit) revert WrongPhase(Phase.Commit, a.phase);
        a.phase = Phase.Cancelled;
        emit AuctionCancelled(auctionId, reason);
    }

    function auctionOf(uint256 auctionId) external view returns (Auction memory) {
        return _auctions[auctionId];
    }

    function bidOf(uint256 auctionId, address bidder) external view returns (Bid memory) {
        return _bids[auctionId][bidder];
    }

    // helper so clients hash the commitment the same way we do
    function computeCommitment(address bidder, uint96 amount, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(bidder, amount, salt));
    }

    function setNoRevealPenalty(uint16 bps) external onlyRole(AUCTION_ADMIN_ROLE) {
        if (bps > 5_000) revert InvalidPenalty(bps);
        noRevealPenaltyBps = bps;
        emit PenaltyUpdated(bps);
    }

    function setCompliance(IComplianceRegistry compliance_) external onlyRole(AUCTION_ADMIN_ROLE) {
        if (address(compliance_) == address(0)) revert ZeroAddress();
        compliance = compliance_;
        emit ComplianceUpdated(address(compliance_));
    }

    function setMarketplace(AIModelMarketplace marketplace_) external onlyRole(AUCTION_ADMIN_ROLE) {
        marketplace = marketplace_;
        emit MarketplaceUpdated(address(marketplace_));
    }
}
