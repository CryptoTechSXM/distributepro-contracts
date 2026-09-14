// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../FeeSchedule.sol";

/**
 * FeeScheduleHarness — test-only wrapper.
 *
 * FeeSchedule's functions are `internal`, so they are inlined at compile time
 * and cannot be called from a test directly. This exposes them as public so
 * the schedule can be measured on-chain rather than trusted on paper.
 *
 * ⛔ TEST ONLY. Never deploy this to a live chain.
 */
contract FeeScheduleHarness {
    function splitBps(uint256 totalBps)
        external
        pure
        returns (uint256 houseBps, uint256 partnerBps)
    {
        return FeeSchedule.splitBps(totalBps);
    }

    function feesOn(uint256 payout, uint256 totalBps)
        external
        pure
        returns (uint256 totalFee, uint256 houseFee, uint256 partnerFee)
    {
        return FeeSchedule.feesOn(payout, totalBps);
    }

    function minTotalBps() external pure returns (uint256) {
        return FeeSchedule.MIN_TOTAL_BPS;
    }

    function maxTotalBps() external pure returns (uint256) {
        return FeeSchedule.MAX_TOTAL_BPS;
    }
}
