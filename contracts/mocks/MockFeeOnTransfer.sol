// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * MockFeeOnTransfer
 *
 * A token that taxes every transfer. Sending 100 delivers 99 (at 100 bps).
 *
 * Why: DistributePro V2.1 pulls `total + fee` with transferFrom and then
 * assumes it actually received all of it. With a taxing token it receives
 * less, then tries to pay out the full amounts and either reverts partway
 * through the loop or dips into whatever balance the contract holds.
 *
 * See docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 2.7.
 */
contract MockFeeOnTransfer is ERC20 {
    uint256 public immutable feeBps;
    address public constant SINK = address(0xdEaD);

    constructor(uint256 _feeBps, uint256 initialSupply) ERC20("Mock Fee On Transfer", "FOT") {
        require(_feeBps < 10_000, "FOT: fee too high");
        feeBps = _feeBps;
        _mint(msg.sender, initialSupply);
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        uint256 tax = (amount * feeBps) / 10_000;
        if (tax > 0) {
            super._transfer(from, SINK, tax);
        }
        super._transfer(from, to, amount - tax);
    }
}
