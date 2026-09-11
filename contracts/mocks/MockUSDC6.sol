// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * MockUSDC6 — a token with SIX decimals, like real USDC and USDT.
 *
 * ⚠️ NEW FINDING 2026-09-11, not in the original audit:
 * `contracts/MockUSDC.sol` in this repo does NOT override decimals(), so it
 * inherits OpenZeppelin's default of 18. It is an 18-decimal token wearing
 * the USDC name. It therefore cannot reproduce the decimals class of bug
 * either — the same blind spot as MockUSDT.
 *
 * This is the real thing: 6 decimals, so the fee maths can be measured
 * honestly against it.
 *
 * See docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 2.1.
 */
contract MockUSDC6 is ERC20 {
    constructor(uint256 initialSupply) ERC20("Mock USD Coin (6dp)", "USDC6") {
        _mint(msg.sender, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
