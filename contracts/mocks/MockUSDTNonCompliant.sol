// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * MockUSDTNonCompliant
 *
 * Reproduces real Tether (USDT) on Ethereum mainnet.
 *
 * Why this file exists: `contracts/MockUSDT.sol` in this repo is a plain
 * OpenZeppelin ERC20, which DOES return a bool from transfer/transferFrom.
 * Real mainnet USDT does NOT — it violates ERC-20 by returning nothing.
 * Solidity's ABI decoder then reverts when a caller tries to read a bool
 * that was never returned.
 *
 * So the existing mock CANNOT reproduce the bug. Tests against it pass and
 * mainnet fails. This mock is the instrument that exposes it.
 *
 * Written for the owner and a future session of Claude. Nobody else touches
 * this code. See docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 2.5.
 */
contract MockUSDTNonCompliant {
    string public name = "Mock Tether (non-compliant)";
    string public symbol = "USDT";
    uint8 public constant decimals = 6;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    // ⛔ DELIBERATELY returns nothing. This is the whole point of the mock.
    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    // ⛔ DELIBERATELY returns nothing.
    function transferFrom(address from, address to, uint256 value) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "USDT: allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _move(from, to, value);
    }

    // approve DOES return a bool, matching real USDT.
    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(to != address(0), "USDT: to zero");
        require(balanceOf[from] >= value, "USDT: balance");
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
