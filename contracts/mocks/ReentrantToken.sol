// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

interface IPurchaseTarget {
    function purchaseLicence(bytes32 modelId, bytes32 keyReference) external returns (bytes32);
}

// test only. hostile ERC20 that calls back into the marketplace from inside
// transferFrom, so the reentrancy guard on the payment path gets exercised.
contract ReentrantToken is ERC20, ERC20Burnable {
    address public target;
    bytes32 public modelId;
    bool public armed;

    constructor() ERC20("Hostile", "HOSTILE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes32 modelId_) external {
        target = target_;
        modelId = modelId_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (armed && msg.sender == target) {
            armed = false;
            IPurchaseTarget(target).purchaseLicence(modelId, bytes32(0));
        }
        return super.transferFrom(from, to, amount);
    }
}
