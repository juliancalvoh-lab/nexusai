// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// consumer side of the model performance oracle
interface IAIPerformanceOracle {
    struct Aggregate {
        uint32 accuracyBps; // holdout accuracy, basis points (10000 = 100%)
        uint32 latencyMs; // p95 inference latency
        uint32 driftBps; // population-stability drift vs. training distribution
        uint64 updatedAt; // block timestamp of the aggregation
        uint32 roundId;
        uint16 reportCount;
    }

    // reverts if the model was never reported on
    function latestAggregate(bytes32 modelId) external view returns (Aggregate memory);

    // exists + fresh + breaker not tripped
    function isUsable(bytes32 modelId) external view returns (bool);

    function accuracyOf(bytes32 modelId) external view returns (uint32 accuracyBps, uint64 updatedAt);
}
