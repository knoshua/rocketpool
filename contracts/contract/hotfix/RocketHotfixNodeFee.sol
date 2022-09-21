pragma solidity 0.7.6;
pragma abicoder v2;

// SPDX-License-Identifier: GPL-3.0-only

import "../RocketBase.sol";

struct Error {
    address nodeAddress;
    int256 amount;
}

contract RocketHotfixNodeFee is RocketBase {
    // Save deployer to limit access to set functions
    address immutable deployer;

    // Whether the adjustment has been performed or not
    bool public executed;

    // Whether the adjustments have been locked from further changes
    bool public locked;

    // Array of errors
    Error[] public errors;

    // Construct
    constructor(RocketStorageInterface _rocketStorageAddress) RocketBase(_rocketStorageAddress) {
        // Version
        version = 1;
        deployer = msg.sender;
    }

    // Returns the total number of errors in the list
    function errorCount() external view returns (uint256) {
        return errors.length;
    }

    // Adds an array of errors to the list
    function addErrors(Error[] memory _errors) external {
        require(msg.sender == deployer, "Only deployer can set");
        require(!locked, "State is locked");

        for (uint256 i = 0; i < _errors.length; i++) {
            errors.push(_errors[i]);
        }
    }

    // Locks the current list of errors
    function lock() external {
        require(msg.sender == deployer, "Only deployer can lock");
        locked = true;
    }

    // Once this contract has been voted in by oDAO, guardian can perform the adjustments
    function execute() external onlyGuardian {
        require(!executed, "Already executed");
        executed = true;
        Error memory error;
        // Loop over list of errors and adjust by error amounts
        for (uint256 i = 0; i < errors.length; i++) {
            error = errors[i];
            bytes32 key = keccak256(abi.encodePacked("node.average.fee.numerator", error.nodeAddress));
            uint256 currentValue = getUint(key);
            uint256 newValue = uint256(int256(currentValue) + error.amount);
            setUint(key, newValue);
        }
    }
}