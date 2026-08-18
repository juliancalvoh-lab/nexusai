// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IComplianceRegistry} from "../interfaces/IComplianceRegistry.sol";

// Compliance registry that stores no personal data. An attester writes a merkle
// root of salted attribute hashes plus a jurisdiction code and an expiry, and a
// holder can later reveal one attribute with a proof.
contract ComplianceRegistry is AccessControl, IComplianceRegistry {
    bytes32 public constant ATTESTER_ROLE = keccak256("ATTESTER_ROLE");
    bytes32 public constant COMPLIANCE_ADMIN_ROLE = keccak256("COMPLIANCE_ADMIN_ROLE");

    struct Attestation {
        bytes32 attributesRoot; // Merkle root of salted attribute leaves
        uint16 jurisdiction; // ISO-3166 numeric country code
        uint64 issuedAt;
        uint64 expiresAt;
        address attester;
        bool revoked;
    }

    mapping(address => Attestation) private _attestations;
    // jurisdictions we will not serve
    mapping(uint16 => bool) public blockedJurisdiction;
    // per-address denylist
    mapping(address => bool) public denied;

    event Attested(
        address indexed account, address indexed attester, bytes32 attributesRoot, uint16 jurisdiction, uint64 expiresAt
    );
    event Revoked(address indexed account, address indexed by, string reason);
    event JurisdictionBlocked(uint16 indexed jurisdiction, bool blocked);
    event Denied(address indexed account, bool denied_, string reason);

    error ZeroAddress();
    error BadExpiry();
    error NoAttestation(address account);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(COMPLIANCE_ADMIN_ROLE, admin);
    }

    function attest(address account, bytes32 attributesRoot, uint16 jurisdiction, uint64 expiresAt)
        external
        onlyRole(ATTESTER_ROLE)
    {
        if (account == address(0)) revert ZeroAddress();
        if (expiresAt <= block.timestamp) revert BadExpiry();

        _attestations[account] = Attestation({
            attributesRoot: attributesRoot,
            jurisdiction: jurisdiction,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            attester: msg.sender,
            revoked: false
        });

        emit Attested(account, msg.sender, attributesRoot, jurisdiction, expiresAt);
    }

    function revoke(address account, string calldata reason) external {
        if (!hasRole(ATTESTER_ROLE, msg.sender) && !hasRole(COMPLIANCE_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, ATTESTER_ROLE);
        }
        if (_attestations[account].issuedAt == 0) revert NoAttestation(account);
        _attestations[account].revoked = true;
        emit Revoked(account, msg.sender, reason);
    }

    function setBlockedJurisdiction(uint16 jurisdiction, bool blocked) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        blockedJurisdiction[jurisdiction] = blocked;
        emit JurisdictionBlocked(jurisdiction, blocked);
    }

    function setDenied(address account, bool denied_, string calldata reason) external onlyRole(COMPLIANCE_ADMIN_ROLE) {
        denied[account] = denied_;
        emit Denied(account, denied_, reason);
    }

    function isEligible(address account) public view returns (bool) {
        Attestation memory a = _attestations[account];
        if (a.issuedAt == 0) return false;
        if (a.revoked) return false;
        if (a.expiresAt <= block.timestamp) return false;
        if (blockedJurisdiction[a.jurisdiction]) return false;
        if (denied[account]) return false;
        return true;
    }

    // attributeLeaf is keccak256(abi.encode(key, value, salt)) for the single
    // attribute the holder decided to reveal
    function verifyAttribute(address account, bytes32 attributeLeaf, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Attestation memory a = _attestations[account];
        if (a.issuedAt == 0 || a.revoked || a.expiresAt <= block.timestamp) return false;
        return MerkleProof.verify(proof, a.attributesRoot, attributeLeaf);
    }

    function attestationOf(address account) external view returns (Attestation memory) {
        return _attestations[account];
    }
}
