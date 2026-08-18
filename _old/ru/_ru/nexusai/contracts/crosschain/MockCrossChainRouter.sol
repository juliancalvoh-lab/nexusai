// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ICrossChainRouter, ICrossChainReceiver} from "../interfaces/ICrossChainRouter.sol";

// Stand-in for CCIP / LayerZero used in tests and the local demo. Two instances
// with different chain selectors let one EVM fake a two chain flow.
// Not production transport.
contract MockCrossChainRouter is ICrossChainRouter, AccessControl {
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    struct Message {
        uint64 srcChainSelector;
        uint64 dstChainSelector;
        address sender;
        address receiver;
        uint64 nonce;
        bytes payload;
        bool delivered;
    }

    uint64 public immutable localChainSelector;
    uint256 public baseFee;
    uint64 private _nonce;

    mapping(bytes32 => Message) private _messages;
    bytes32[] private _messageIds;

    // dstChainSelector => router on that chain (local sim only)
    mapping(uint64 => address) public peerRouter;
    // replay guard, keyed by (srcChain, srcSender, receiver, nonce)
    mapping(bytes32 => bool) public inboundExecuted;

    event MessageDelivered(bytes32 indexed messageId, address indexed receiver, bool success);
    event MessageAcknowledged(bytes32 indexed messageId);
    event PeerRouterSet(uint64 indexed chainSelector, address router);

    error AlreadyDelivered();
    error UnknownMessage(bytes32 messageId);
    error InsufficientFee(uint256 sent, uint256 required);
    error WithdrawFailed();
    error ZeroAddress();

    constructor(uint64 localChainSelector_, uint256 baseFee_, address admin) {
        localChainSelector = localChainSelector_;
        baseFee = baseFee_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, admin);
    }

    function quoteFee(uint64, bytes calldata payload) public view returns (uint256) {
        return baseFee + payload.length * 1 gwei;
    }

    function sendMessage(uint64 dstChainSelector, address receiver, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId)
    {
        uint256 fee = quoteFee(dstChainSelector, payload);
        if (msg.value < fee) revert InsufficientFee(msg.value, fee);

        uint64 n = ++_nonce;
        messageId = keccak256(abi.encode(localChainSelector, dstChainSelector, msg.sender, receiver, n));

        _messages[messageId] = Message({
            srcChainSelector: localChainSelector,
            dstChainSelector: dstChainSelector,
            sender: msg.sender,
            receiver: receiver,
            nonce: n,
            payload: payload,
            delivered: false
        });
        _messageIds.push(messageId);

        emit MessageSent(messageId, dstChainSelector, msg.sender, receiver, n, payload);
    }

    // destination side execution, run by the relayer on the destination router.
    // same shape as ccip/layerzero, so a receiver only has to trust its own router.
    function relayIn(uint64 srcChainSelector, address srcSender, uint64 nonce, address receiver, bytes calldata payload)
        external
        onlyRole(RELAYER_ROLE)
        returns (bytes32 executionId)
    {
        executionId = keccak256(abi.encode(srcChainSelector, localChainSelector, srcSender, receiver, nonce));
        if (inboundExecuted[executionId]) revert AlreadyDelivered();
        inboundExecuted[executionId] = true;

        ICrossChainReceiver(receiver).ccReceive(srcChainSelector, srcSender, nonce, payload);
        emit MessageDelivered(executionId, receiver, true);
    }

    // source side bookkeeping once delivery is attested
    function acknowledge(bytes32 messageId) external onlyRole(RELAYER_ROLE) {
        Message storage m = _messages[messageId];
        if (m.sender == address(0)) revert UnknownMessage(messageId);
        if (m.delivered) revert AlreadyDelivered();
        m.delivered = true;
        emit MessageAcknowledged(messageId);
    }

    function setPeerRouter(uint64 chainSelector, address router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        peerRouter[chainSelector] = router;
        emit PeerRouterSet(chainSelector, router);
    }

    function setBaseFee(uint256 baseFee_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        baseFee = baseFee_;
    }

    function messageOf(bytes32 messageId) external view returns (Message memory) {
        return _messages[messageId];
    }

    function messageCount() external view returns (uint256) {
        return _messageIds.length;
    }

    function messageIdAt(uint256 i) external view returns (bytes32) {
        return _messageIds[i];
    }

    function withdrawFees(address payable to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: address(this).balance}("");
        if (!ok) revert WithdrawFailed();
    }
}
