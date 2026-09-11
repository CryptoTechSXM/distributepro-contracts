// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DistributePro is Ownable {
    address public feeRecipient;

    event DistributedETH(address indexed sender, uint256 totalAmount, uint256 fee, uint256 recipients);
    event DistributedToken(address indexed sender, address indexed token, uint256 totalAmount, uint256 fee, uint256 recipients);
    event FeeApplied(address indexed payer, uint256 amount, uint256 fee, address feeRecipient);

    constructor(address _feeRecipient) Ownable() {
        require(_feeRecipient != address(0), "Invalid fee recipient");
        feeRecipient = _feeRecipient;
    }

    function setFeeRecipient(address _newRecipient) external onlyOwner {
        require(_newRecipient != address(0), "Invalid recipient");
        feeRecipient = _newRecipient;
    }

    // Linear fee calculation between 2% (below 10k) and 0.5% (above 1M)
    function calculateFee(uint256 amount) public pure returns (uint256) {
        uint256 minAmount = 10_000 ether;    // 10k
        uint256 maxAmount = 1_000_000 ether; // 1M
        uint256 maxFeeBps = 200; // 2%
        uint256 minFeeBps = 50;  // 0.5%

        if (amount <= minAmount) {
            return (amount * maxFeeBps) / 10_000;
        } else if (amount >= maxAmount) {
            return (amount * minFeeBps) / 10_000;
        } else {
            // Smooth linear decrease between 10k and 1M
            uint256 slope = ((maxFeeBps - minFeeBps) * 1e18) / (maxAmount - minAmount);
            uint256 feeBps = maxFeeBps - (((amount - minAmount) * slope) / 1e18);
            return (amount * feeBps) / 10_000;
        }
    }

    // ✅ ETH distribution
    function processETH(address[] calldata recipients, uint256[] calldata amounts) external payable {
        require(recipients.length == amounts.length, "Mismatched arrays");

        uint256 total;
        for (uint256 i = 0; i < amounts.length; i++) {
            total += amounts[i];
        }

        uint256 fee = calculateFee(total);

        // ✅ FIX: allow small rounding difference
        require(msg.value >= total + fee, "Invalid distribution amounts");

        // Pay fee
        payable(feeRecipient).transfer(fee);
        emit FeeApplied(msg.sender, total, fee, feeRecipient);

        // Distribute ETH
        for (uint256 i = 0; i < recipients.length; i++) {
            payable(recipients[i]).transfer(amounts[i]);
        }

        emit DistributedETH(msg.sender, total, fee, recipients.length);
    }

    // ✅ ERC20 distribution
    function processToken(address token, address[] calldata recipients, uint256[] calldata amounts, uint256 total) external {
        require(recipients.length == amounts.length, "Mismatched arrays");

        IERC20 erc20 = IERC20(token);
        uint256 fee = calculateFee(total);

        // Transfer from sender
        require(erc20.transferFrom(msg.sender, address(this), total + fee), "Transfer failed");

        // Pay fee
        require(erc20.transfer(feeRecipient, fee), "Fee transfer failed");
        emit FeeApplied(msg.sender, total, fee, feeRecipient);

        // Distribute tokens
        for (uint256 i = 0; i < recipients.length; i++) {
            require(erc20.transfer(recipients[i], amounts[i]), "Distribution failed");
        }

        emit DistributedToken(msg.sender, token, total, fee, recipients.length);
    }
}
