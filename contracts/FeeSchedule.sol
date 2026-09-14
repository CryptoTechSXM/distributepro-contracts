// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ⛔⛔ SOLC 0.8.20 — RAISED FROM 0.8.19 ON 2026-09-13 (V3.1). THE REASON THE
// OLD PIN EXISTED IS MEASURED DEAD, AND THAT IS WHY THIS IS ALLOWED.
//
// THE OLD PIN, AND WHY IT LOOKED RIGHT. On 2026-09-11 the BTC20 explorer
// refused to verify this contract under 0.8.20, while the owner's LIVE V1
// contract IS verified there under v0.8.19+commit.7dd6d404. The whole repo
// was dropped to 0.8.19 to match. ⚠️ That inference — "the explorer's
// compiler list stops one version short of ours" — was a HYPOTHESIS, and the
// redeploy that tested it failed identically.
//
// WHAT ACTUALLY SETTLED IT (brief §20.1): the explorer's own verification
// form was loaded and read. Its compiler dropdown is EMPTY — zero options in
// the DOM, still zero after waiting for an async load. An explorer with no
// compilers cannot recompile source, so it cannot verify anything at ANY
// version. V1's verified status is a relic from when it still had compilers.
// ▶ The pin bought nothing. It never had.
//
// WHY IT MOVED NOW: OpenZeppelin v5 requires ^0.8.20 — read off the published
// v5.6.1 source, not recalled. And the raise is free here: 0.8.20's headline
// change is defaulting the EVM target to Shanghai, which hardhat.config.js
// overrides to berlin regardless. ⛔ Better than free — deploys #1 and #2 in
// the ledger were BUILT AT 0.8.20 AND LANDED ON BTC20 MAINNET, so this exact
// compiler-and-chain combination is already proven, not merely expected.
//
// ⚠️ DO NOT RAISE IT FURTHER. 0.8.20 is the minimum OZ v5 accepts; anything
// newer buys nothing measured, and every version costs a build cycle to test.

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

    /**
     * ⛔⛔ V3.1 RENAME, 2026-09-13 — was `BPS_DENOMINATOR`, VALUE UNCHANGED.
     *
     * DistributeProV3 also had a constant called `BPS_DENOMINATOR`. The two
     * were never used together, so V3.0 was correct — but they measure
     * different things, and a single confident rename by a future session
     * would have broken the fee model silently while every test stayed green.
     *
     *   FEE space (here)       10,000 = 100%      200 = the 2% floor
     *   SHARE space (V3.1)  1,000,000 = 100%    1 unit = 0.0001%
     *
     * ⛔ THIS ONE DID NOT CHANGE VALUE AND MUST NOT BE "MADE CONSISTENT" WITH
     * THE OTHER. Every partner rate ever registered on-chain, every figure in
     * the owner's fee table, set_partner.js, admin.html and the site copy are
     * all in this 10,000 space. Changing it is a commercial decision, not a
     * tidy-up, and nothing has asked for it.
     */
    uint256 internal constant FEE_BPS_DENOMINATOR = 10_000;

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

        totalFee = (payout * totalBps) / FEE_BPS_DENOMINATOR;
        partnerFee = (payout * partnerBps) / FEE_BPS_DENOMINATOR;
        houseFee = totalFee - partnerFee; // remainder, so nothing is left behind
    }
}
