'npx hardhat clean' running (wd: <repository-root>)
'npx hardhat clean --global' running (wd: <repository-root>)
Unexpected output from Hardhat, trying to parse it anyway: ◇ injected env (0) from .env // tip: ◈ encrypted .env [www.dotenvx.com]
◇ injected env (0) from .env // tip: ⌘ enable debugging { debug: true }
{"root":"<repository-root>","configFile":"<repository-root>/hardhat.config.js","sources":"<repository-root>/contracts","cache":"<repository-root>/cache","artifacts":"<repository-root>/artifacts","tests":"<repository-root>/test","ignition":"<repository-root>/ignition"}

Problem deserializing hardhat configuration, using defaults: Expecting property name enclosed in double quotes: line 1 column 3 (char 2)
'npx hardhat compile --force' running (wd: <repository-root>)
**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [arbitrary-send-eth](#arbitrary-send-eth) (2 results) (High)
 - [divide-before-multiply](#divide-before-multiply) (2 results) (Medium)
 - [incorrect-equality](#incorrect-equality) (5 results) (Medium)
 - [unused-return](#unused-return) (1 results) (Medium)
 - [reentrancy-benign](#reentrancy-benign) (1 results) (Low)
 - [reentrancy-events](#reentrancy-events) (3 results) (Low)
 - [timestamp](#timestamp) (23 results) (Low)
 - [costly-loop](#costly-loop) (1 results) (Informational)
 - [cyclomatic-complexity](#cyclomatic-complexity) (1 results) (Informational)
 - [low-level-calls](#low-level-calls) (2 results) (Informational)
 - [unindexed-event-address](#unindexed-event-address) (4 results) (Informational)
## arbitrary-send-eth
Impact: High
Confidence: Medium
 - [ ] ID-0
[MockCrossChainRouter.withdrawFees(address)](contracts/crosschain/MockCrossChainRouter.sol#L139-L143) sends eth to arbitrary user
	Dangerous calls:
	- [(ok,None) = to.call{value: address(this).balance}()](contracts/crosschain/MockCrossChainRouter.sol#L141)

contracts/crosschain/MockCrossChainRouter.sol#L139-L143


 - [ ] ID-1
[CrossChainRegistry.sweep(address)](contracts/crosschain/CrossChainRegistry.sol#L216-L222) sends eth to arbitrary user
	Dangerous calls:
	- [(ok,None) = to.call{value: amount}()](contracts/crosschain/CrossChainRegistry.sol#L219)

contracts/crosschain/CrossChainRegistry.sol#L216-L222


## divide-before-multiply
Impact: Medium
Confidence: Medium
 - [ ] ID-2
[NexusAIToken._rollEpochIfNeeded()](contracts/token/NexusAIToken.sol#L114-L121) performs a multiplication on the result of a division:
	- [epochStart += (elapsed / EMISSION_EPOCH) * EMISSION_EPOCH](contracts/token/NexusAIToken.sol#L117)

contracts/token/NexusAIToken.sol#L114-L121


 - [ ] ID-3
[AIModelMarketplace._settlePayment(uint256)](contracts/marketplace/AIModelMarketplace.sol#L314-L322) performs a multiplication on the result of a division:
	- [fee = (price * protocolFeeBps) / BPS](contracts/marketplace/AIModelMarketplace.sol#L315)
	- [burnAmount = (fee * burnShareBps) / BPS](contracts/marketplace/AIModelMarketplace.sol#L316)

contracts/marketplace/AIModelMarketplace.sol#L314-L322


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-4
[AIPerformanceOracle.isUsable(bytes32)](contracts/oracle/AIPerformanceOracle.sol#L248-L253) uses a dangerous strict equality:
	- [a.updatedAt == 0](contracts/oracle/AIPerformanceOracle.sol#L250)

contracts/oracle/AIPerformanceOracle.sol#L248-L253


 - [ ] ID-5
[ComplianceRegistry.verifyAttribute(address,bytes32,bytes32[])](contracts/compliance/ComplianceRegistry.sol#L139-L147) uses a dangerous strict equality:
	- [a.issuedAt == 0 || a.revoked || a.expiresAt <= block.timestamp](contracts/compliance/ComplianceRegistry.sol#L145)

contracts/compliance/ComplianceRegistry.sol#L139-L147


 - [ ] ID-6
[AIPerformanceOracle.latestAggregate(bytes32)](contracts/oracle/AIPerformanceOracle.sol#L242-L246) uses a dangerous strict equality:
	- [a.updatedAt == 0](contracts/oracle/AIPerformanceOracle.sol#L244)

contracts/oracle/AIPerformanceOracle.sol#L242-L246


 - [ ] ID-7
[StakingVault.fundRewards(uint256,uint256)](contracts/staking/StakingVault.sol#L266-L286) uses a dangerous strict equality:
	- [rewardRate == 0](contracts/staking/StakingVault.sol#L281)

contracts/staking/StakingVault.sol#L266-L286


 - [ ] ID-8
[ComplianceRegistry.isEligible(address)](contracts/compliance/ComplianceRegistry.sol#L122-L130) uses a dangerous strict equality:
	- [a.issuedAt == 0](contracts/compliance/ComplianceRegistry.sol#L124)

contracts/compliance/ComplianceRegistry.sol#L122-L130


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-9
[AIModelMarketplace.purchaseLicence(bytes32,bytes32)](contracts/marketplace/AIModelMarketplace.sol#L265-L311) ignores return value by [(observed,None) = oracle.accuracyOf(modelId)](contracts/marketplace/AIModelMarketplace.sol#L291)

contracts/marketplace/AIModelMarketplace.sol#L265-L311


## reentrancy-benign
Impact: Low
Confidence: Medium
 - [ ] ID-10
Reentrancy in [AIModelMarketplace.purchaseLicence(bytes32,bytes32)](contracts/marketplace/AIModelMarketplace.sol#L265-L311):
	External calls:
	- [(fee,burnAmount) = _settlePayment(m.price)](contracts/marketplace/AIModelMarketplace.sol#L295)
		- [ERC20Burnable(address(paymentToken)).burn(burnAmount)](contracts/marketplace/AIModelMarketplace.sol#L320)
	State variables written after the call(s):
	- [_purchases[purchaseId] = Purchase({modelId:modelId,buyer:msg.sender,amount:uint96(m.price - fee),releaseAt:uint64(block.timestamp + disputeWindow),dispute:DisputeState.None,settled:false})](contracts/marketplace/AIModelMarketplace.sol#L299-L306)
	- [purchaseId = keccak256(bytes)(abi.encode(modelId,msg.sender,++ _seq,block.timestamp))](contracts/marketplace/AIModelMarketplace.sol#L298)
	- [grossRevenue[modelId] += m.price](contracts/marketplace/AIModelMarketplace.sol#L308)
	- [expiresAt = _extendLicence(modelId,msg.sender,m.licenceTerm)](contracts/marketplace/AIModelMarketplace.sol#L296)
		- [licenceExpiry[modelId][buyer] = expiresAt](contracts/marketplace/AIModelMarketplace.sol#L330)

contracts/marketplace/AIModelMarketplace.sol#L265-L311


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-11
Reentrancy in [MockCrossChainRouter.relayIn(uint64,address,uint64,address,bytes)](contracts/crosschain/MockCrossChainRouter.sol#L96-L107):
	External calls:
	- [ICrossChainReceiver(receiver).ccReceive(srcChainSelector,srcSender,nonce,payload)](contracts/crosschain/MockCrossChainRouter.sol#L105)
	Event emitted after the call(s):
	- [MessageDelivered(executionId,receiver,true)](contracts/crosschain/MockCrossChainRouter.sol#L106)

contracts/crosschain/MockCrossChainRouter.sol#L96-L107


 - [ ] ID-12
Reentrancy in [CrossChainRegistry.ccReceive(uint64,address,uint64,bytes)](contracts/crosschain/CrossChainRegistry.sol#L158-L179):
	External calls:
	- [_applyModel(abi.decode(body,(ModelPayload)),srcChainSelector)](contracts/crosschain/CrossChainRegistry.sol#L170)
		- [marketplace.mirrorModel(AIModelMarketplace.MirrorParams({modelId:p.modelId,provider:p.provider,price:p.price,weightsHash:p.weightsHash,metadataURI:p.metadataURI,minAccuracyBps:p.minAccuracyBps,licenceTerm:p.licenceTerm,requiresCompliance:p.requiresCompliance,srcChain:srcChain}))](contracts/crosschain/CrossChainRegistry.sol#L182-L194)
	- [marketplace.mirrorLicence(p.modelId,p.holder,p.expiresAt,srcChainSelector)](contracts/crosschain/CrossChainRegistry.sol#L173)
	Event emitted after the call(s):
	- [MessageConsumed(srcChainSelector,nonce,msgType)](contracts/crosschain/CrossChainRegistry.sol#L178)

contracts/crosschain/CrossChainRegistry.sol#L158-L179


 - [ ] ID-13
Reentrancy in [CrossChainRegistry.sweep(address)](contracts/crosschain/CrossChainRegistry.sol#L216-L222):
	External calls:
	- [(ok,None) = to.call{value: amount}()](contracts/crosschain/CrossChainRegistry.sol#L219)
	Event emitted after the call(s):
	- [Swept(to,amount)](contracts/crosschain/CrossChainRegistry.sol#L221)

contracts/crosschain/CrossChainRegistry.sol#L216-L222


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-14
[AIModelMarketplace.issueExclusiveLicence(bytes32,address,uint32)](contracts/marketplace/AIModelMarketplace.sol#L401-L419) uses timestamp for comparisons
	Dangerous comparisons:
	- [until > licenceExpiry[modelId][holder]](contracts/marketplace/AIModelMarketplace.sol#L416)

contracts/marketplace/AIModelMarketplace.sol#L401-L419


 - [ ] ID-15
[AIModelMarketplace.registerModel(string,bytes32,uint96,uint16,uint32,bool)](contracts/marketplace/AIModelMarketplace.sol#L194-L234) uses timestamp for comparisons
	Dangerous comparisons:
	- [unlockAt < block.timestamp + minBondLock](contracts/marketplace/AIModelMarketplace.sol#L212)

contracts/marketplace/AIModelMarketplace.sol#L194-L234


 - [ ] ID-16
[StakingVault.lastTimeRewardApplicable()](contracts/staking/StakingVault.sol#L134-L136) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < periodFinish](contracts/staking/StakingVault.sol#L135)

contracts/staking/StakingVault.sol#L134-L136


 - [ ] ID-17
[NexusAIToken.remainingEmission()](contracts/token/NexusAIToken.sol#L109-L112) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= epochStart + EMISSION_EPOCH](contracts/token/NexusAIToken.sol#L110)

contracts/token/NexusAIToken.sol#L109-L112


 - [ ] ID-18
[AIPerformanceOracle.isUsable(bytes32)](contracts/oracle/AIPerformanceOracle.sol#L248-L253) uses timestamp for comparisons
	Dangerous comparisons:
	- [a.updatedAt == 0](contracts/oracle/AIPerformanceOracle.sol#L250)
	- [block.timestamp <= uint256(a.updatedAt) + stalenessWindow](contracts/oracle/AIPerformanceOracle.sol#L252)

contracts/oracle/AIPerformanceOracle.sol#L248-L253


 - [ ] ID-19
[AIModelMarketplace._extendLicence(bytes32,address,uint32)](contracts/marketplace/AIModelMarketplace.sol#L325-L331) uses timestamp for comparisons
	Dangerous comparisons:
	- [current > block.timestamp](contracts/marketplace/AIModelMarketplace.sol#L327-L329)

contracts/marketplace/AIModelMarketplace.sol#L325-L331


 - [ ] ID-20
[StakingVault.claimRewards()](contracts/staking/StakingVault.sol#L225-L233) uses timestamp for comparisons
	Dangerous comparisons:
	- [reward > 0](contracts/staking/StakingVault.sol#L227)

contracts/staking/StakingVault.sol#L225-L233


 - [ ] ID-21
[SealedBidLicenceAuction.commitBid(uint256,bytes32)](contracts/privacy/SealedBidLicenceAuction.sol#L181-L196) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= a.commitEnd](contracts/privacy/SealedBidLicenceAuction.sol#L185)

contracts/privacy/SealedBidLicenceAuction.sol#L181-L196


 - [ ] ID-22
[NexusAIToken._rollEpochIfNeeded()](contracts/token/NexusAIToken.sol#L114-L121) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= epochStart + EMISSION_EPOCH](contracts/token/NexusAIToken.sol#L115)

contracts/token/NexusAIToken.sol#L114-L121


 - [ ] ID-23
[AIModelMarketplace.modelOf(bytes32)](contracts/marketplace/AIModelMarketplace.sol#L466-L470) uses timestamp for comparisons
	Dangerous comparisons:
	- [m.provider == address(0)](contracts/marketplace/AIModelMarketplace.sol#L468)

contracts/marketplace/AIModelMarketplace.sol#L466-L470


 - [ ] ID-24
[SealedBidLicenceAuction.settle(uint256)](contracts/privacy/SealedBidLicenceAuction.sol#L225-L257) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < a.revealEnd](contracts/privacy/SealedBidLicenceAuction.sol#L228)

contracts/privacy/SealedBidLicenceAuction.sol#L225-L257


 - [ ] ID-25
[ComplianceRegistry.attest(address,bytes32,uint16,uint64)](contracts/compliance/ComplianceRegistry.sol#L76-L93) uses timestamp for comparisons
	Dangerous comparisons:
	- [expiresAt <= block.timestamp](contracts/compliance/ComplianceRegistry.sol#L81)

contracts/compliance/ComplianceRegistry.sol#L76-L93


 - [ ] ID-26
[ComplianceRegistry.isEligible(address)](contracts/compliance/ComplianceRegistry.sol#L122-L130) uses timestamp for comparisons
	Dangerous comparisons:
	- [a.issuedAt == 0](contracts/compliance/ComplianceRegistry.sol#L124)
	- [a.expiresAt <= block.timestamp](contracts/compliance/ComplianceRegistry.sol#L126)

contracts/compliance/ComplianceRegistry.sol#L122-L130


 - [ ] ID-27
[AIModelMarketplace.releaseEscrow(bytes32)](contracts/marketplace/AIModelMarketplace.sol#L341-L353) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < p.releaseAt](contracts/marketplace/AIModelMarketplace.sol#L346)

contracts/marketplace/AIModelMarketplace.sol#L341-L353


 - [ ] ID-28
[AIModelMarketplace.openDispute(bytes32,string)](contracts/marketplace/AIModelMarketplace.sol#L355-L364) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= p.releaseAt](contracts/marketplace/AIModelMarketplace.sol#L360)

contracts/marketplace/AIModelMarketplace.sol#L355-L364


 - [ ] ID-29
[AIPerformanceOracle.latestAggregate(bytes32)](contracts/oracle/AIPerformanceOracle.sol#L242-L246) uses timestamp for comparisons
	Dangerous comparisons:
	- [a.updatedAt == 0](contracts/oracle/AIPerformanceOracle.sol#L244)

contracts/oracle/AIPerformanceOracle.sol#L242-L246


 - [ ] ID-30
[ComplianceRegistry.verifyAttribute(address,bytes32,bytes32[])](contracts/compliance/ComplianceRegistry.sol#L139-L147) uses timestamp for comparisons
	Dangerous comparisons:
	- [a.issuedAt == 0 || a.revoked || a.expiresAt <= block.timestamp](contracts/compliance/ComplianceRegistry.sol#L145)

contracts/compliance/ComplianceRegistry.sol#L139-L147


 - [ ] ID-31
[AIPerformanceOracle._aggregate(bytes32)](contracts/oracle/AIPerformanceOracle.sol#L166-L210) uses timestamp for comparisons
	Dangerous comparisons:
	- [r.ts == 0 || r.ts < cutoff](contracts/oracle/AIPerformanceOracle.sol#L177)
	- [block.timestamp > stalenessWindow](contracts/oracle/AIPerformanceOracle.sol#L173)

contracts/oracle/AIPerformanceOracle.sol#L166-L210


 - [ ] ID-32
[StakingVault.fundRewards(uint256,uint256)](contracts/staking/StakingVault.sol#L266-L286) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp >= periodFinish](contracts/staking/StakingVault.sol#L275)
	- [rewardRate == 0](contracts/staking/StakingVault.sol#L281)

contracts/staking/StakingVault.sol#L266-L286


 - [ ] ID-33
[SealedBidLicenceAuction.revealBid(uint256,uint96,bytes32)](contracts/privacy/SealedBidLicenceAuction.sol#L198-L222) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < a.commitEnd](contracts/privacy/SealedBidLicenceAuction.sol#L201)
	- [block.timestamp >= a.revealEnd](contracts/privacy/SealedBidLicenceAuction.sol#L202)

contracts/privacy/SealedBidLicenceAuction.sol#L198-L222


 - [ ] ID-34
[AIModelMarketplace.purchaseLicence(bytes32,bytes32)](contracts/marketplace/AIModelMarketplace.sol#L265-L311) uses timestamp for comparisons
	Dangerous comparisons:
	- [exclusiveUntil[modelId] > block.timestamp && exclusiveHolder[modelId] != msg.sender](contracts/marketplace/AIModelMarketplace.sol#L277)

contracts/marketplace/AIModelMarketplace.sol#L265-L311


 - [ ] ID-35
[StakingVault.unstake(uint256)](contracts/staking/StakingVault.sol#L205-L223) uses timestamp for comparisons
	Dangerous comparisons:
	- [block.timestamp < p.unlockAt](contracts/staking/StakingVault.sol#L210)

contracts/staking/StakingVault.sol#L205-L223


 - [ ] ID-36
[AIModelMarketplace.hasActiveLicence(bytes32,address)](contracts/marketplace/AIModelMarketplace.sol#L333-L335) uses timestamp for comparisons
	Dangerous comparisons:
	- [licenceExpiry[modelId][account] > block.timestamp](contracts/marketplace/AIModelMarketplace.sol#L334)

contracts/marketplace/AIModelMarketplace.sol#L333-L335


## costly-loop
Impact: Informational
Confidence: Medium
 - [ ] ID-37
[AIPerformanceOracle.removeReporter(address)](contracts/oracle/AIPerformanceOracle.sol#L110-L123) has costly operations inside a loop:
	- [_reporterSet.pop()](contracts/oracle/AIPerformanceOracle.sol#L118)

contracts/oracle/AIPerformanceOracle.sol#L110-L123


## cyclomatic-complexity
Impact: Informational
Confidence: High
 - [ ] ID-38
[SealedBidLicenceAuction.revealBid(uint256,uint96,bytes32)](contracts/privacy/SealedBidLicenceAuction.sol#L198-L222) has a high cyclomatic complexity (12).

contracts/privacy/SealedBidLicenceAuction.sol#L198-L222


## low-level-calls
Impact: Informational
Confidence: High
 - [ ] ID-39
Low level call in [CrossChainRegistry.sweep(address)](contracts/crosschain/CrossChainRegistry.sol#L216-L222):
	- [(ok,None) = to.call{value: amount}()](contracts/crosschain/CrossChainRegistry.sol#L219)

contracts/crosschain/CrossChainRegistry.sol#L216-L222


 - [ ] ID-40
Low level call in [MockCrossChainRouter.withdrawFees(address)](contracts/crosschain/MockCrossChainRouter.sol#L139-L143):
	- [(ok,None) = to.call{value: address(this).balance}()](contracts/crosschain/MockCrossChainRouter.sol#L141)

contracts/crosschain/MockCrossChainRouter.sol#L139-L143


## unindexed-event-address
Impact: Informational
Confidence: High
 - [ ] ID-41
Event [AIModelMarketplace.DependenciesUpdated(address,address,address,address)](contracts/marketplace/AIModelMarketplace.sol#L144) has address parameters but no indexed parameters

contracts/marketplace/AIModelMarketplace.sol#L144


 - [ ] ID-42
Event [CrossChainRegistry.RouterUpdated(address)](contracts/crosschain/CrossChainRegistry.sol#L74) has address parameters but no indexed parameters

contracts/crosschain/CrossChainRegistry.sol#L74


 - [ ] ID-43
Event [SealedBidLicenceAuction.MarketplaceUpdated(address)](contracts/privacy/SealedBidLicenceAuction.sol#L104) has address parameters but no indexed parameters

contracts/privacy/SealedBidLicenceAuction.sol#L104


 - [ ] ID-44
Event [SealedBidLicenceAuction.ComplianceUpdated(address)](contracts/privacy/SealedBidLicenceAuction.sol#L103) has address parameters but no indexed parameters

contracts/privacy/SealedBidLicenceAuction.sol#L103


