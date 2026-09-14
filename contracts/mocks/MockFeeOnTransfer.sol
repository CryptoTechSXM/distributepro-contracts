// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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

    /**
     * ⛔⛔ REWRITTEN FOR OPENZEPPELIN v5, 2026-09-13. This used to override
     * `_transfer`. In v5 `_transfer` is `internal` but NO LONGER `virtual`
     * — checked in the published v5.6.1 ERC20.sol, not recalled — so that
     * override does not compile at all. v5's single extension point is
     * `_update`, which IS virtual.
     *
     * ⚠️ THE TWO ARE NOT INTERCHANGEABLE, AND GETTING THIS WRONG WOULD HAVE
     * BEEN SILENT. `_transfer` only ever saw user transfers. `_update` is
     * ALSO called by `_mint` and `_burn`, so a naive port would tax the
     * constructor's own mint and every balance in the D6 test would start
     * 1% short — a mock that lies about the thing it exists to reproduce.
     * The from/to zero-address guard below is what keeps the behaviour
     * identical to the v4 version: mints and burns pass through untaxed.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value); // mint or burn — never taxed
            return;
        }
        uint256 tax = (value * feeBps) / 10_000;
        if (tax > 0) {
            super._update(from, SINK, tax);
        }
        super._update(from, to, value - tax);
    }
}
