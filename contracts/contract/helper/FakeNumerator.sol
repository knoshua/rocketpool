pragma solidity 0.7.6;
pragma abicoder v2;

// SPDX-License-Identifier: GPL-3.0-only

import "../RocketBase.sol";

// Helper contract to manual set node average fee numerators
contract FakeNumerator is RocketBase {
    constructor(RocketStorageInterface _rocketStorageAddress) RocketBase(_rocketStorageAddress) {
        version = 1;
    }

    function setNumerator(address _nodeAddress, uint256 _numerator) external {
        bytes32 key = keccak256(abi.encodePacked("node.average.fee.numerator", _nodeAddress));
        setUint(key, _numerator);
    }
}
