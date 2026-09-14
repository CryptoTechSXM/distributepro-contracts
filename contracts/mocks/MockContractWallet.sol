// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * MockContractWallet
 *
 * Stands in for a Gnosis Safe, a multisig, or any smart-contract wallet.
 *
 * Why: `.transfer()` forwards a 2,300-gas stipend. A cold SSTORE alone costs
 * 20,000. So any recipient that does real work in receive() reverts, and in
 * DistributePro V2.1 one such address anywhere in the list kills the ENTIRE
 * distribution. For a batch payout tool aimed at businesses this is the most
 * likely real-world failure.
 *
 * This wallet does nothing exotic — it just records what it received, which
 * is already far more than 2,300 gas.
 *
 * See docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 2.3.
 */
contract MockContractWallet {
    uint256 public totalReceived;
    uint256 public payments;

    event Received(address indexed from, uint256 amount);

    receive() external payable {
        totalReceived += msg.value; // cold SSTORE: ~20,000 gas, blows the stipend
        payments += 1;
        emit Received(msg.sender, msg.value);
    }
}
