// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// eligibility checks. no PII on-chain, the registry only keeps a merkle root of
// hashed attributes so one attribute can be revealed on its own.
interface IComplianceRegistry {
    function isEligible(address account) external view returns (bool);

    function verifyAttribute(address account, bytes32 attributeLeaf, bytes32[] calldata proof)
        external
        view
        returns (bool);
}
