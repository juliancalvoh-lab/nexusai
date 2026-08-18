// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ICrossChainRouter, ICrossChainReceiver} from "../interfaces/ICrossChainRouter.sol";
import {AIModelMarketplace} from "../marketplace/AIModelMarketplace.sol";

// Hub and spoke sync of model listings and licences between chains. Outbound
// messages go out through the router. Inbound ones only count if they came from
// the router, from the trusted remote for that chain, and with an unused nonce.
contract CrossChainRegistry is AccessControl, ReentrancyGuard, ICrossChainReceiver {
    bytes32 public constant BRIDGE_ADMIN_ROLE = keccak256("BRIDGE_ADMIN_ROLE");
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");

    uint8 public constant MSG_MODEL = 1;
    uint8 public constant MSG_LICENCE = 2;

    // wire format for a mirrored listing
    struct ModelPayload {
        bytes32 modelId;
        address provider;
        uint96 price;
        bytes32 weightsHash;
        string metadataURI;
        uint16 minAccuracyBps;
        uint32 licenceTerm;
        bool requiresCompliance;
    }

    struct LicencePayload {
        bytes32 modelId;
        address holder;
        uint64 expiresAt;
    }

    ICrossChainRouter public router;
    // immutable, otherwise a compromised admin could point mirroring at a
    // marketplace they control
    AIModelMarketplace public immutable marketplace;
    uint64 public immutable localChainSelector;

    // chainSelector => trusted registry on that chain
    mapping(uint64 => address) public trustedRemote;
    // chainSelector => nonce => already used
    mapping(uint64 => mapping(uint64 => bool)) public consumedNonce;

    event TrustedRemoteSet(uint64 indexed chainSelector, address remote);
    event RouterUpdated(address router);
    event ModelPublished(bytes32 indexed modelId, uint64 indexed dstChain, bytes32 messageId);
    event LicencePublished(bytes32 indexed modelId, address indexed holder, uint64 indexed dstChain, bytes32 messageId);
    event MessageConsumed(uint64 indexed srcChain, uint64 indexed nonce, uint8 msgType);
    event Swept(address indexed to, uint256 amount);

    error ZeroAddress();
    error UntrustedRouter(address caller);
    error UntrustedRemote(uint64 srcChain, address srcSender);
    error ReplayedNonce(uint64 srcChain, uint64 nonce);
    error UnknownMessageType(uint8 msgType);
    error NoTrustedRemote(uint64 dstChain);
    error NoLicence(bytes32 modelId, address holder);
    error SweepFailed();

    constructor(ICrossChainRouter router_, AIModelMarketplace marketplace_, uint64 localChainSelector_, address admin) {
        if (address(router_) == address(0) || address(marketplace_) == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        router = router_;
        marketplace = marketplace_;
        localChainSelector = localChainSelector_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BRIDGE_ADMIN_ROLE, admin);
        _grantRole(PUBLISHER_ROLE, admin);
    }

    function publishModel(bytes32 modelId, uint64 dstChain)
        external
        payable
        onlyRole(PUBLISHER_ROLE)
        nonReentrant
        returns (bytes32 messageId)
    {
        address remote = trustedRemote[dstChain];
        if (remote == address(0)) revert NoTrustedRemote(dstChain);

        AIModelMarketplace.Model memory m = marketplace.modelOf(modelId);
        ModelPayload memory p = ModelPayload({
            modelId: modelId,
            provider: m.provider,
            price: m.price,
            weightsHash: m.weightsHash,
            metadataURI: m.metadataURI,
            minAccuracyBps: m.minAccuracyBps,
            licenceTerm: m.licenceTerm,
            requiresCompliance: m.requiresCompliance
        });

        messageId =
            router.sendMessage{value: msg.value}(dstChain, remote, abi.encode(MSG_MODEL, abi.encode(p)));
        emit ModelPublished(modelId, dstChain, messageId);
    }

    function publishLicence(bytes32 modelId, address holder, uint64 dstChain)
        external
        payable
        onlyRole(PUBLISHER_ROLE)
        nonReentrant
        returns (bytes32 messageId)
    {
        address remote = trustedRemote[dstChain];
        if (remote == address(0)) revert NoTrustedRemote(dstChain);

        uint64 expiresAt = marketplace.licenceExpiry(modelId, holder);
        if (expiresAt == 0) revert NoLicence(modelId, holder);

        LicencePayload memory p = LicencePayload({modelId: modelId, holder: holder, expiresAt: expiresAt});
        messageId = router.sendMessage{value: msg.value}(dstChain, remote, abi.encode(MSG_LICENCE, abi.encode(p)));
        emit LicencePublished(modelId, holder, dstChain, messageId);
    }

    function quotePublishFee(uint64 dstChain, bytes calldata payload) external view returns (uint256) {
        return router.quoteFee(dstChain, payload);
    }

    function ccReceive(uint64 srcChainSelector, address srcSender, uint64 nonce, bytes calldata payload) external {
        if (msg.sender != address(router)) revert UntrustedRouter(msg.sender);

        address expected = trustedRemote[srcChainSelector];
        if (expected == address(0) || expected != srcSender) revert UntrustedRemote(srcChainSelector, srcSender);

        if (consumedNonce[srcChainSelector][nonce]) revert ReplayedNonce(srcChainSelector, nonce);
        consumedNonce[srcChainSelector][nonce] = true;

        (uint8 msgType, bytes memory body) = abi.decode(payload, (uint8, bytes));

        if (msgType == MSG_MODEL) {
            _applyModel(abi.decode(body, (ModelPayload)), srcChainSelector);
        } else if (msgType == MSG_LICENCE) {
            LicencePayload memory p = abi.decode(body, (LicencePayload));
            marketplace.mirrorLicence(p.modelId, p.holder, p.expiresAt, srcChainSelector);
        } else {
            revert UnknownMessageType(msgType);
        }

        emit MessageConsumed(srcChainSelector, nonce, msgType);
    }

    function _applyModel(ModelPayload memory p, uint64 srcChain) internal {
        marketplace.mirrorModel(
            AIModelMarketplace.MirrorParams({
                modelId: p.modelId,
                provider: p.provider,
                price: p.price,
                weightsHash: p.weightsHash,
                metadataURI: p.metadataURI,
                minAccuracyBps: p.minAccuracyBps,
                licenceTerm: p.licenceTerm,
                requiresCompliance: p.requiresCompliance,
                srcChain: srcChain
            })
        );
    }

    function setTrustedRemote(uint64 chainSelector, address remote) external onlyRole(BRIDGE_ADMIN_ROLE) {
        trustedRemote[chainSelector] = remote;
        emit TrustedRemoteSet(chainSelector, remote);
    }

    function setRouter(ICrossChainRouter router_) external onlyRole(BRIDGE_ADMIN_ROLE) {
        if (address(router_) == address(0)) revert ZeroAddress();
        router = router_;
        emit RouterUpdated(address(router_));
    }

    // get back native currency prefunded here for message fees, otherwise
    // anything sent to receive() is stuck
    function sweep(address payable to) external onlyRole(BRIDGE_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert SweepFailed();
        emit Swept(to, amount);
    }

    receive() external payable {}
}
