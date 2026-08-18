// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAIPerformanceOracle} from "../interfaces/IAIPerformanceOracle.sol";

// Puts off-chain model eval results (accuracy, p95 latency, drift) on-chain.
// Reporters submit, consumers read the median once there are enough fresh
// reports, and a big jump versus the last round trips a per-model breaker.
contract AIPerformanceOracle is AccessControl, IAIPerformanceOracle {
    bytes32 public constant REPORTER_ROLE = keccak256("REPORTER_ROLE");
    bytes32 public constant ORACLE_ADMIN_ROLE = keccak256("ORACLE_ADMIN_ROLE");

    uint32 public constant BPS = 10_000;
    uint256 public constant MAX_REPORTERS = 31;

    struct Report {
        uint32 accuracyBps;
        uint32 latencyMs;
        uint32 driftBps;
        uint64 ts;
    }

    // modelId => reporter => latest report
    mapping(bytes32 => mapping(address => Report)) private _reports;
    // modelId => aggregate
    mapping(bytes32 => Aggregate) private _aggregates;
    // modelId => breaker tripped
    mapping(bytes32 => bool) public circuitBroken;

    address[] private _reporterSet;
    mapping(address => bool) public isReporter;

    uint16 public minQuorum;
    uint32 public stalenessWindow;
    uint32 public maxDeviationBps;

    event ReporterAdded(address indexed reporter);
    event ReporterRemoved(address indexed reporter);
    event ReportSubmitted(
        bytes32 indexed modelId, address indexed reporter, uint32 accuracyBps, uint32 latencyMs, uint32 driftBps
    );
    event AggregateUpdated(
        bytes32 indexed modelId, uint32 indexed roundId, uint32 accuracyBps, uint32 latencyMs, uint32 driftBps, uint16 reportCount
    );
    event CircuitBroken(bytes32 indexed modelId, uint32 previousAccuracyBps, uint32 newAccuracyBps);
    event CircuitCleared(bytes32 indexed modelId);
    event ParametersUpdated(uint16 minQuorum, uint32 stalenessWindow, uint32 maxDeviationBps);

    error InvalidBps(uint32 value);
    error NoAggregate(bytes32 modelId);
    error AlreadyReporter(address reporter);
    error NotReporter(address reporter);
    error TooManyReporters();
    error InvalidQuorum();
    error ZeroAddress();

    constructor(address admin, uint16 minQuorum_, uint32 stalenessWindow_, uint32 maxDeviationBps_) {
        if (admin == address(0)) revert ZeroAddress();
        if (minQuorum_ == 0) revert InvalidQuorum();
        if (maxDeviationBps_ > BPS) revert InvalidBps(maxDeviationBps_);

        minQuorum = minQuorum_;
        stalenessWindow = stalenessWindow_;
        maxDeviationBps = maxDeviationBps_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ADMIN_ROLE, admin);
    }

    function addReporter(address reporter) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (reporter == address(0)) revert ZeroAddress();
        if (isReporter[reporter]) revert AlreadyReporter(reporter);
        if (_reporterSet.length >= MAX_REPORTERS) revert TooManyReporters();
        isReporter[reporter] = true;
        _reporterSet.push(reporter);
        _grantRole(REPORTER_ROLE, reporter);
        emit ReporterAdded(reporter);
    }

    function removeReporter(address reporter) external onlyRole(ORACLE_ADMIN_ROLE) {
        if (!isReporter[reporter]) revert NotReporter(reporter);
        isReporter[reporter] = false;
        _revokeRole(REPORTER_ROLE, reporter);
        uint256 len = _reporterSet.length;
        for (uint256 i; i < len; ++i) {
            if (_reporterSet[i] == reporter) {
                _reporterSet[i] = _reporterSet[len - 1];
                _reporterSet.pop();
                break;
            }
        }
        emit ReporterRemoved(reporter);
    }

    function reporterCount() external view returns (uint256) {
        return _reporterSet.length;
    }

    function setParameters(uint16 minQuorum_, uint32 stalenessWindow_, uint32 maxDeviationBps_)
        external
        onlyRole(ORACLE_ADMIN_ROLE)
    {
        if (minQuorum_ == 0) revert InvalidQuorum();
        if (maxDeviationBps_ > BPS) revert InvalidBps(maxDeviationBps_);
        minQuorum = minQuorum_;
        stalenessWindow = stalenessWindow_;
        maxDeviationBps = maxDeviationBps_;
        emit ParametersUpdated(minQuorum_, stalenessWindow_, maxDeviationBps_);
    }

    // one reporter's numbers for a model. accuracy and drift in bps, latency in ms.
    function submitReport(bytes32 modelId, uint32 accuracyBps, uint32 latencyMs, uint32 driftBps)
        external
        onlyRole(REPORTER_ROLE)
    {
        if (accuracyBps > BPS) revert InvalidBps(accuracyBps);
        if (driftBps > BPS) revert InvalidBps(driftBps);

        _reports[modelId][msg.sender] =
            Report({accuracyBps: accuracyBps, latencyMs: latencyMs, driftBps: driftBps, ts: uint64(block.timestamp)});

        emit ReportSubmitted(modelId, msg.sender, accuracyBps, latencyMs, driftBps);
        _aggregate(modelId);
    }

    function _aggregate(bytes32 modelId) internal {
        uint256 n = _reporterSet.length;
        uint32[] memory acc = new uint32[](n);
        uint32[] memory lat = new uint32[](n);
        uint32[] memory drf = new uint32[](n);
        uint256 count = 0; // how many fresh reports we found

        uint64 cutoff = block.timestamp > stalenessWindow ? uint64(block.timestamp - stalenessWindow) : 0;

        for (uint256 i; i < n; ++i) {
            Report memory r = _reports[modelId][_reporterSet[i]];
            if (r.ts == 0 || r.ts < cutoff) continue;
            acc[count] = r.accuracyBps;
            lat[count] = r.latencyMs;
            drf[count] = r.driftBps;
            ++count;
        }

        if (count < minQuorum) return; // not enough fresh reports, keep the old aggregate

        uint32 medAcc = _median(acc, count);
        uint32 medLat = _median(lat, count);
        uint32 medDrf = _median(drf, count);

        Aggregate memory prev = _aggregates[modelId];

        if (prev.updatedAt != 0) {
            uint32 delta = medAcc > prev.accuracyBps ? medAcc - prev.accuracyBps : prev.accuracyBps - medAcc;
            if (delta > maxDeviationBps) {
                circuitBroken[modelId] = true;
                emit CircuitBroken(modelId, prev.accuracyBps, medAcc);
            }
        }

        _aggregates[modelId] = Aggregate({
            accuracyBps: medAcc,
            latencyMs: medLat,
            driftBps: medDrf,
            updatedAt: uint64(block.timestamp),
            roundId: prev.roundId + 1,
            reportCount: uint16(count)
        });

        emit AggregateUpdated(modelId, prev.roundId + 1, medAcc, medLat, medDrf, uint16(count));
    }

    // insertion sort then take the middle. n is capped at 31 so the gas is fine.
    function _median(uint32[] memory arr, uint256 n) internal pure returns (uint32) {
        for (uint256 i = 1; i < n; ++i) {
            uint32 key = arr[i];
            uint256 j = i;
            while (j > 0 && arr[j - 1] > key) {
                arr[j] = arr[j - 1];
                unchecked {
                    --j;
                }
            }
            arr[j] = key;
        }
        if (n % 2 == 1) return arr[n / 2];
        return uint32((uint256(arr[n / 2 - 1]) + uint256(arr[n / 2])) / 2);
    }

    function clearCircuit(bytes32 modelId) external onlyRole(ORACLE_ADMIN_ROLE) {
        circuitBroken[modelId] = false;
        emit CircuitCleared(modelId);
    }

    function latestAggregate(bytes32 modelId) external view returns (Aggregate memory) {
        Aggregate memory a = _aggregates[modelId];
        if (a.updatedAt == 0) revert NoAggregate(modelId);
        return a;
    }

    function isUsable(bytes32 modelId) public view returns (bool) {
        Aggregate memory a = _aggregates[modelId];
        if (a.updatedAt == 0) return false;
        if (circuitBroken[modelId]) return false;
        return block.timestamp <= uint256(a.updatedAt) + stalenessWindow;
    }

    function accuracyOf(bytes32 modelId) external view returns (uint32 accuracyBps, uint64 updatedAt) {
        Aggregate memory a = _aggregates[modelId];
        return (a.accuracyBps, a.updatedAt);
    }

    function reportOf(bytes32 modelId, address reporter) external view returns (Report memory) {
        return _reports[modelId][reporter];
    }
}
