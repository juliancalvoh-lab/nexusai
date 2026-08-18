// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// small message passing surface. prod would bind this to CCIP or LayerZero,
// local and CI bind it to MockCrossChainRouter.
interface ICrossChainRouter {
    event MessageSent(
        bytes32 indexed messageId,
        uint64 indexed dstChainSelector,
        address indexed sender,
        address receiver,
        uint64 nonce,
        bytes payload
    );

    function sendMessage(uint64 dstChainSelector, address receiver, bytes calldata payload)
        external
        payable
        returns (bytes32 messageId);

    function quoteFee(uint64 dstChainSelector, bytes calldata payload) external view returns (uint256);
}

// implemented by apps that accept messages from the router
interface ICrossChainReceiver {
    function ccReceive(uint64 srcChainSelector, address srcSender, uint64 nonce, bytes calldata payload) external;
}
