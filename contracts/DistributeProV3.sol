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

// NOTE ON OPENZEPPELIN VERSION
// This repo has OZ ^4.9.6 installed, so these are the v4 import paths
// (security/ReentrancyGuard.sol, security/Pausable.sol) and Ownable takes no
// constructor argument. In OZ v5 both files move to utils/ and Ownable
// requires Ownable(initialOwner). Migrating to v5 is a deliberate, separate
// step — see docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 2.10. Do not let a
// stray `npm update` make that decision.
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./FeeSchedule.sol";

/**
 * DistributeProV3 — batch payouts by percentage, in one transaction.
 *
 * Written for the owner and a future session of Claude. 2026-09-11.
 * Nobody else has ever touched this code.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⛔ THE RULE THAT SHAPES EVERYTHING: THIS CONTRACT NEVER HOLDS YOUR MONEY.
 *
 * Owner's words: "Never hold 3rd party funds — pure blockchain splits."
 *
 * Every unit that enters in a transaction leaves in that same transaction.
 * Nothing accrues. There is no fee balance to withdraw, no pending claim, no
 * escrow. Both entry points END with an assertion that the contract's balance
 * is exactly what it was when the call started — if a single wei were left
 * behind, the whole transaction reverts.
 *
 * That is not decoration. V2.1's worst defect (brief section 2.2, measured:
 * an attacker paid 102 USDC and walked away with 10,000) only worked because
 * the contract was holding a balance to steal.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW IT WORKS
 *
 *   1. You give a list of recipients and their shares in basis points.
 *      Shares must total exactly 10000 (= 100%).
 *   2. You give the payout — the amount the recipients collectively receive.
 *   3. The fee is charged ON TOP: between 2% and 5%, split with a partner
 *      per FeeSchedule.sol. Paying out 100 at the 2% floor means sending 102.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS FIXED FROM V2.1, with the test that proves each one
 *
 *   2.1 / D1  Fee was decimals-blind — a 6-decimal token paid 2% while an
 *             18-decimal token paid 0.5% for the same nominal amount. Now
 *             basis points only; no absolute-unit constant exists anywhere.
 *   2.2 / D2  `total` was a caller parameter, never checked. Now every
 *             per-recipient amount is derived on-chain from the shares.
 *   2.3 / D3  `.transfer()` gave recipients 2,300 gas, so one Gnosis Safe in
 *             the list killed the whole batch. Now `.call`, behind a guard.
 *   2.5 / D4  Real mainnet USDT returns no bool and reverted every time.
 *             Now SafeERC20.
 *   2.6 / D5  Overpaid ETH was locked in forever — 0.5 ETH stranded in the
 *             test, with no withdraw function in the ABI. Now the value must
 *             be exact, so there is nothing to strand.
 *   2.7 / D6  Fee-on-transfer tokens failed deep inside the payout loop.
 *             Now a balance-delta check rejects them immediately, by name.
 *   2.9 / D7  A zero-address recipient silently BURNED the money — 1.0 ETH
 *             gone in the test, no revert. Now rejected, with the row index.
 *   2.8       Unbounded arrays could build a transaction too big for a
 *             block. Now capped by maxRecipients.
 */
contract DistributeProV3 is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// Absolute ceiling on maxRecipients. The owner may tune below this per
    /// chain; nobody can raise it past here without a redeploy.
    uint256 public constant MAX_RECIPIENTS_LIMIT = 500;

    /// Where Crypto Counsel's share goes.
    address public houseRecipient;

    /// Largest batch allowed in one transaction. Chains differ; the measured
    /// Base Sepolia per-transaction gas ceiling is 16,777,216 (2^24).
    uint256 public maxRecipients;

    /// Registered partners and the TOTAL fee each one charges, in bps.
    /// Owner-controlled: a partner rate is a commercial agreement, not a
    /// per-transaction choice a caller gets to invent.
    /// 0 = not registered.
    mapping(address => uint256) public partnerTotalBps;

    event HouseRecipientSet(address indexed previous, address indexed current);
    event MaxRecipientsSet(uint256 previous, uint256 current);
    event PartnerSet(address indexed partner, uint256 previousBps, uint256 totalBps);

    event DistributedNative(
        address indexed payer,
        address indexed partner,
        uint256 payout,
        uint256 totalFee,
        uint256 houseFee,
        uint256 partnerFee,
        uint256 recipientCount
    );

    event DistributedToken(
        address indexed payer,
        address indexed token,
        address indexed partner,
        uint256 payout,
        uint256 totalFee,
        uint256 houseFee,
        uint256 partnerFee,
        uint256 recipientCount
    );

    event Rescued(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ArrayLengthMismatch(uint256 recipients, uint256 shares);
    error NoRecipients();
    error TooManyRecipients(uint256 given, uint256 max);
    error MaxRecipientsOutOfRange(uint256 given, uint256 limit);
    error ZeroRecipient(uint256 index);
    error ZeroShare(uint256 index);
    error SharesMustTotal10000(uint256 given);
    error ZeroPayout();
    error UnknownPartner(address partner);
    error IncorrectNativeValue(uint256 sent, uint256 required);
    error FeeOnTransferTokenNotSupported(uint256 expected, uint256 received);
    error NativeTransferFailed(address to, uint256 amount);
    error AccountingMismatch(uint256 expected, uint256 actual);

    /**
     * The whole fee picture for one distribution, in a single memory struct.
     *
     * WHY A STRUCT AND NOT FIVE LOCAL VARIABLES. The first version of this
     * contract held totalBps / totalFee / houseFee / partnerFee / required as
     * five separate locals in each entry point, and solc 0.8.20 refused to
     * compile it: "Stack too deep" at the emit, because the EVM can only
     * reach 16 stack slots deep and the calldata arrays already eat several.
     * A memory struct is ONE stack slot (a pointer), so all five travel
     * together for the price of one. This is the standard fix and it is
     * better than reaching for viaIR, which compiles far slower and changes
     * code generation for the whole project to work around one function.
     */
    struct Quote {
        uint256 totalBps;
        uint256 totalFee;
        uint256 houseFee;
        uint256 partnerFee;
        uint256 required;
    }

    constructor(address _houseRecipient, uint256 _maxRecipients) Ownable() {
        if (_houseRecipient == address(0)) revert ZeroAddress();
        if (_maxRecipients == 0 || _maxRecipients > MAX_RECIPIENTS_LIMIT) {
            revert MaxRecipientsOutOfRange(_maxRecipients, MAX_RECIPIENTS_LIMIT);
        }
        houseRecipient = _houseRecipient;
        maxRecipients = _maxRecipients;
        emit HouseRecipientSet(address(0), _houseRecipient);
        emit MaxRecipientsSet(0, _maxRecipients);
    }

    // ─────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────

    function setHouseRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        emit HouseRecipientSet(houseRecipient, newRecipient);
        houseRecipient = newRecipient;
    }

    function setMaxRecipients(uint256 newMax) external onlyOwner {
        if (newMax == 0 || newMax > MAX_RECIPIENTS_LIMIT) {
            revert MaxRecipientsOutOfRange(newMax, MAX_RECIPIENTS_LIMIT);
        }
        emit MaxRecipientsSet(maxRecipients, newMax);
        maxRecipients = newMax;
    }

    /**
     * Register a partner, or change their rate.
     * `totalBps` must be within FeeSchedule's [200, 500] band — splitBps
     * reverts otherwise, so the 5% ceiling is enforced here too.
     * Pass 0 to de-register.
     */
    function setPartner(address partner, uint256 totalBps) external onlyOwner {
        if (partner == address(0)) revert ZeroAddress();
        if (totalBps != 0) {
            FeeSchedule.splitBps(totalBps); // reverts if out of range
        }
        emit PartnerSet(partner, partnerTotalBps[partner], totalBps);
        partnerTotalBps[partner] = totalBps;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────
    // QUOTES — so the frontend shows the same numbers the chain will charge
    // ─────────────────────────────────────────────────────────────────────

    /**
     * What a distribution will cost. Call this before sending anything.
     * `required` is the exact msg.value (native) or approval (token) needed.
     */
    function quote(uint256 payout, address partner)
        external
        view
        returns (
            uint256 totalBps,
            uint256 totalFee,
            uint256 houseFee,
            uint256 partnerFee,
            uint256 required
        )
    {
        Quote memory q = _quote(payout, partner);
        return (q.totalBps, q.totalFee, q.houseFee, q.partnerFee, q.required);
    }

    function _quote(uint256 payout, address partner) internal view returns (Quote memory q) {
        q.totalBps = _rateFor(partner);
        (q.totalFee, q.houseFee, q.partnerFee) = FeeSchedule.feesOn(payout, q.totalBps);
        q.required = payout + q.totalFee;
    }

    /// The exact amount each recipient receives, including where the dust lands.
    function previewAmounts(uint256 payout, uint256[] calldata shares)
        external
        pure
        returns (uint256[] memory amounts)
    {
        uint256 n = shares.length;
        amounts = new uint256[](n);
        uint256 sent;
        for (uint256 i; i < n; ++i) {
            uint256 amount = (i == n - 1) ? payout - sent : (payout * shares[i]) / BPS_DENOMINATOR;
            amounts[i] = amount;
            sent += amount;
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // DISTRIBUTION
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Split `msg.value` among recipients by percentage, in native coin.
     *
     * `payout` is a parameter, which may look like V2.1's defect 2.2 — it is
     * not, and the difference matters. In V2.1, `total` was a SECOND source of
     * truth that was never reconciled against the amounts, so the two could
     * disagree and the contract paid out on the larger one. Here `payout` is
     * the ONLY source of truth: every per-recipient amount is derived from it,
     * and msg.value must equal payout + fee EXACTLY. Nothing can disagree.
     */
    function distributeNative(
        address[] calldata recipients,
        uint256[] calldata shares,
        uint256 payout,
        address partner
    ) external payable nonReentrant whenNotPaused {
        _validate(recipients, shares, payout);

        Quote memory q = _quote(payout, partner);

        if (msg.value != q.required) revert IncorrectNativeValue(msg.value, q.required);

        {
            uint256 sent = _payOutNative(recipients, shares, payout);

            if (q.houseFee > 0) _sendNative(houseRecipient, q.houseFee);
            if (q.partnerFee > 0) _sendNative(partner, q.partnerFee);

        // ⛔ The hold-nothing rule, enforced rather than trusted.
        // Everything that came in must have gone out: what the recipients got,
        // plus the two fee legs, must equal msg.value to the wei.
        //
        // WHY THIS AND NOT A BALANCE CHECK. The obvious version — snapshot
        // address(this).balance and require it unchanged at the end — has a
        // griefing hole: any recipient can force coin into this contract
        // mid-transaction (selfdestruct still does it), the balance then no
        // longer matches, and a perfectly good distribution reverts. Counting
        // what we actually sent is exact, cheaper, and cannot be interfered
        // with from outside.
            uint256 accounted = sent + q.houseFee + q.partnerFee;
            if (accounted != msg.value) revert AccountingMismatch(msg.value, accounted);
        }

        _emitNative(partner, payout, q, recipients.length);
    }

    /**
     * Split an ERC-20 amount among recipients by percentage.
     * Caller must approve `payout + totalFee` first — see quote().
     */
    function distributeToken(
        IERC20 token,
        address[] calldata recipients,
        uint256[] calldata shares,
        uint256 payout,
        address partner
    ) external nonReentrant whenNotPaused {
        if (address(token) == address(0)) revert ZeroAddress();
        _validate(recipients, shares, payout);

        Quote memory q = _quote(payout, partner);

        // Each step is in its own block so its temporaries are released
        // before the next one. Keeps the live-variable count low — see the
        // note on the Quote struct above.
        {
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), q.required);
            uint256 delivered = token.balanceOf(address(this)) - balanceBefore;

            // Fail FAST and by NAME on taxing or rebasing tokens, rather than
            // running out of balance somewhere inside the payout loop. This is
            // defect 2.7 / test D6.
            if (delivered != q.required) {
                revert FeeOnTransferTokenNotSupported(q.required, delivered);
            }
        }

        {
            uint256 sent = _payOutToken(token, recipients, shares, payout);

            if (q.houseFee > 0) token.safeTransfer(houseRecipient, q.houseFee);
            if (q.partnerFee > 0) token.safeTransfer(partner, q.partnerFee);

            // ⛔ The hold-nothing rule, enforced rather than trusted. Same
            // reasoning as distributeNative: count what was sent rather than
            // re-reading the balance, because a token with a transfer hook
            // could otherwise push the balance around and revert an honest
            // payout.
            uint256 accounted = sent + q.houseFee + q.partnerFee;
            if (accounted != q.required) revert AccountingMismatch(q.required, accounted);
        }

        _emitToken(address(token), partner, payout, q, recipients.length);
    }

    /// Emitting from a helper keeps eight event arguments off the caller's stack.
    function _emitToken(
        address token,
        address partner,
        uint256 payout,
        Quote memory q,
        uint256 count
    ) private {
        emit DistributedToken(
            msg.sender, token, partner, payout, q.totalFee, q.houseFee, q.partnerFee, count
        );
    }

    /// Same reason as _emitToken.
    function _emitNative(
        address partner,
        uint256 payout,
        Quote memory q,
        uint256 count
    ) private {
        emit DistributedNative(
            msg.sender, partner, payout, q.totalFee, q.houseFee, q.partnerFee, count
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // RESCUE
    //
    // ⚠️ This is NOT a way to reach user funds. A distribution never leaves a
    // balance — both entry points revert if it would. These exist only for
    // assets that arrive OUTSIDE a distribution: a token sent to the contract
    // address by mistake, or native coin forced in by a selfdestruct (the
    // contract has no receive(), so ordinary sends already bounce).
    // ─────────────────────────────────────────────────────────────────────

    function rescueToken(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit Rescued(address(token), to, amount);
    }

    function rescueNative(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _sendNative(to, amount);
        emit Rescued(address(0), to, amount);
    }

    // ─────────────────────────────────────────────────────────────────────
    // INTERNALS
    // ─────────────────────────────────────────────────────────────────────

    function _rateFor(address partner) internal view returns (uint256) {
        if (partner == address(0)) {
            return FeeSchedule.MIN_TOTAL_BPS; // no partner: the 2% floor
        }
        uint256 registered = partnerTotalBps[partner];
        if (registered == 0) revert UnknownPartner(partner);
        return registered;
    }

    /**
     * All checks happen here, before a single unit moves.
     *
     * ON DUPLICATES — a deliberate decision, brief section 2.9.
     * Duplicate recipients are ALLOWED. Detecting them on-chain is O(n²):
     * at 250 recipients that is ~31,000 comparisons, which would cost more
     * gas than the payout itself. A payer may also legitimately pay one
     * address from two CSV rows. The frontend warns on duplicates instead.
     */
    function _validate(
        address[] calldata recipients,
        uint256[] calldata shares,
        uint256 payout
    ) internal view {
        uint256 n = recipients.length;
        if (n != shares.length) revert ArrayLengthMismatch(n, shares.length);
        if (n == 0) revert NoRecipients();
        if (n > maxRecipients) revert TooManyRecipients(n, maxRecipients);
        if (payout == 0) revert ZeroPayout();

        uint256 totalShares;
        for (uint256 i; i < n; ++i) {
            if (recipients[i] == address(0)) revert ZeroRecipient(i);
            if (shares[i] == 0) revert ZeroShare(i);
            totalShares += shares[i];
        }
        if (totalShares != BPS_DENOMINATOR) revert SharesMustTotal10000(totalShares);
    }

    /**
     * ON DUST — a deliberate decision, brief section 7.3.
     * Percentages plus integer division leave a remainder. In a contract that
     * holds nothing, the remainder cannot be left behind. The LAST recipient
     * receives `payout - everything already sent`, which absorbs it exactly.
     * previewAmounts() shows the frontend precisely where it lands.
     */
    function _payOutNative(
        address[] calldata recipients,
        uint256[] calldata shares,
        uint256 payout
    ) internal returns (uint256 sent) {
        uint256 n = recipients.length;
        for (uint256 i; i < n; ++i) {
            uint256 amount = (i == n - 1) ? payout - sent : (payout * shares[i]) / BPS_DENOMINATOR;
            sent += amount;
            _sendNative(recipients[i], amount);
        }
    }

    function _payOutToken(
        IERC20 token,
        address[] calldata recipients,
        uint256[] calldata shares,
        uint256 payout
    ) internal returns (uint256 sent) {
        uint256 n = recipients.length;
        for (uint256 i; i < n; ++i) {
            uint256 amount = (i == n - 1) ? payout - sent : (payout * shares[i]) / BPS_DENOMINATOR;
            sent += amount;
            token.safeTransfer(recipients[i], amount);
        }
    }

    /**
     * `.call` rather than `.transfer`. The 2,300-gas stipend that `.transfer`
     * forwards is not enough for a Gnosis Safe or any contract wallet doing
     * real work in receive() — defect 2.3, measured in test D3, where one
     * such address killed an entire three-recipient batch.
     *
     * `.call` forwards all remaining gas, which opens a reentrancy door. It
     * is closed by nonReentrant on both entry points, and by there being no
     * mutable accounting state to corrupt in the first place.
     */
    function _sendNative(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert NativeTransferFailed(to, amount);
    }

    // Deliberately NO receive() and NO fallback. This contract has no reason
    // to accept a bare transfer, and refusing them is one less way for money
    // to end up somewhere it does not belong.
}
