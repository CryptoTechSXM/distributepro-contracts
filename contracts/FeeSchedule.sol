// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ⛔ SOLC PINNED TO 0.8.19, NOT 0.8.20 — AND THE REASON IS MEASURED.
//
// The BTC20 explorer (scan.bitcoincode.technology, an old Blockscout) REFUSED
// to verify this contract twice under 0.8.20 — once with viaIR and once
// without — always "Fail - Unable to verify".
//
// scripts/probe_verify.js then measured the decisive fact: the owner's LIVE V1
// contract IS verified on that explorer, under v0.8.19+commit.7dd6d404. So
// verification works there; the explorer's compiler list simply appears to
// stop at 0.8.19. One version short.
//
// That also retires the viaIR theory. viaIR was never the cause — two
// deployments, with and without it, failed identically. The redeploy that
// tested it was not wasted (it proved viaIR is unnecessary: 73 tests pass
// without it) but the verification reasoning behind it was wrong.
//
// ⚠️ DO NOT RAISE THIS PRAGMA back to ^0.8.20 without re-measuring what the
// explorer supports. Nothing here needs 0.8.20: its only notable change was
// defaulting the EVM target to Shanghai, which this repo overrides to berlin
// anyway (see hardhat.config.js), and OpenZeppelin 4.9 requires only ^0.8.0.

/**
 * FeeSchedule — the owner's V3 fee model, as executable code.
 *
 * Written for the owner and a future session of Claude. 2026-09-11.
 * Decision recorded in docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 7.2.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MODEL
 *
 * A partner (reseller / white-label) sets a TOTAL fee between 2% and 5%.
 * Crypto Counsel takes the first 2%; above a 4% total the two split evenly.
 *
 *   Total   Crypto Counsel   Partner
 *   2.0%        2.00%         0.00%
 *   2.5%        2.00%         0.50%
 *   3.0%        2.00%         1.00%
 *   3.5%        2.00%         1.50%
 *   4.0%        2.00%         2.00%
 *   4.5%        2.25%         2.25%
 *   5.0%        2.50%         2.50%
 *
 * That table is not a lookup — it is a closed form:
 *
 *   houseBps = max(200, ceil(totalBps / 2))
 *   partnerBps = totalBps - houseBps
 *
 * All seven rows satisfy it, so any total in range works, not only the
 * half-point steps. The frontend can still offer the steps as presets.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ceil AND NOT floor
 *
 * Only matters for an odd bps value, e.g. 401. With floor, the house gets
 * 200 and the partner 201 — the partner would out-earn Crypto Counsel above
 * the 4% line, which inverts the intent. ceil keeps the invariant
 * "house >= partner, always". Both agree on every row of the owner's table.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY ONE SIDE IS A REMAINDER, AND WHY IT IS THE HOUSE
 *
 * `houseFee` is derived as `totalFee - partnerFee`, never computed from bps
 * independently. Two independent percentage calculations would each round
 * down and leave a wei or two behind on every single distribution — and in a
 * contract required to hold NOTHING at rest (section 7.3), stray dust is a
 * correctness bug, not a rounding detail. Deriving one side as the remainder
 * makes `houseFee + partnerFee == totalFee` exact by construction.
 *
 * It has to be the HOUSE that absorbs the remainder, not the partner. If the
 * partner took the remainder instead, integer rounding could hand the partner
 * one wei more than the house on tiny payouts — inverting the intent. Giving
 * the house the remainder makes `houseFee >= partnerFee` provably always true.
 */
library FeeSchedule {
    /// Lowest total fee a partner may set — Crypto Counsel's floor.
    uint256 internal constant MIN_TOTAL_BPS = 200; // 2.0%
    /// Hard ceiling. The V2.0 contract allowed up to 100%; that must never ship.
    uint256 internal constant MAX_TOTAL_BPS = 500; // 5.0%
    /// Crypto Counsel's guaranteed minimum share.
    uint256 internal constant HOUSE_FLOOR_BPS = 200; // 2.0%

    uint256 internal constant BPS_DENOMINATOR = 10_000;

    error TotalFeeOutOfRange(uint256 totalBps);

    /**
     * Split a total fee rate into the house share and the partner share.
     * Reverts if totalBps is outside [200, 500].
     */
    function splitBps(uint256 totalBps)
        internal
        pure
        returns (uint256 houseBps, uint256 partnerBps)
    {
        if (totalBps < MIN_TOTAL_BPS || totalBps > MAX_TOTAL_BPS) {
            revert TotalFeeOutOfRange(totalBps);
        }

        uint256 half = (totalBps + 1) / 2; // ceil
        houseBps = half > HOUSE_FLOOR_BPS ? half : HOUSE_FLOOR_BPS;
        partnerBps = totalBps - houseBps;
    }

    /**
     * Compute the actual fee amounts owed on a payout.
     *
     * `payout` is what the recipients collectively receive. The fee is charged
     * ON TOP of it, so the caller must supply payout + totalFee.
     *
     * Guarantees, both relied on by the never-hold-funds rule:
     *   houseFee + partnerFee == totalFee   (exact, no dust)
     *   houseFee >= partnerFee              (always)
     */
    function feesOn(uint256 payout, uint256 totalBps)
        internal
        pure
        returns (uint256 totalFee, uint256 houseFee, uint256 partnerFee)
    {
        (, uint256 partnerBps) = splitBps(totalBps);

        totalFee = (payout * totalBps) / BPS_DENOMINATOR;
        partnerFee = (payout * partnerBps) / BPS_DENOMINATOR;
        houseFee = totalFee - partnerFee; // remainder, so nothing is left behind
    }
}
