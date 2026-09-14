/**
 * share_denominator.js — ask the CHAIN what a "100%" share list adds up to.
 *
 * Written for the owner and a future session of Claude. 2026-09-13 (V3.1).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 *
 * V3.1 moved the share denominator from 10,000 to 1,000,000 so that a
 * percentage can carry four decimal places. Every run script used to check
 * the caller's shares against a hand-typed `10000`.
 *
 * Hand-typing the new number instead would have been the same mistake in a
 * new coat, and this repo has already been burned by it twice — DeployBench
 * printing "viaIR true" from a literal rather than the config, and
 * deploy_v3.js writing that same literal into the only durable record of how
 * the deployed bytecode was produced (brief §20.4). ▶ THE RULE THIS REPO
 * RUNS ON: never hand-write into a check, a report or a record a value that
 * can be read from the live config or the chain.
 *
 * So the scripts now ask the contract they are about to spend money through.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⛔ AND IT REFUSES RATHER THAN ADAPTING
 *
 * The live V3.0 contract (0x51bEeDc0…700C79) exposes BPS_DENOMINATOR = 10,000.
 * V3.1 exposes SHARE_DENOMINATOR = 1,000,000. It would be easy to detect
 * which one is there and quietly work with either.
 *
 * That is exactly what must NOT happen. A script that silently accepts both
 * is a script that will one day pay a list of basis-point shares through a
 * millionths contract, or the reverse, and the operator will not know which
 * contract they hit until the money has moved. So: V3.0 is detected, NAMED,
 * and refused. One denominator per script run, read off the address in the
 * deployment record, printed before anything is signed.
 *
 * (The contract itself makes a mismatch loud rather than silent — a 1,000,000
 * list against a 10,000 contract underflows in previewAmounts and reverts,
 * measured 2026-09-13. This is the belt to that pair of braces: it fails
 * BEFORE gas is paid, and it says why in words.)
 */

const { ethers } = require("hardhat");

const LEGACY_V30_ABI = ["function BPS_DENOMINATOR() view returns (uint256)"];

/**
 * Read the share denominator off the deployed contract.
 *
 * @param {string} address  the contract address from the deployment record
 * @param {object} dp       the connected DistributeProV3 instance (V3.1 ABI)
 * @param {function} say    the script's own logger
 * @param {function} fail   the script's own fatal-exit function
 * @returns {bigint} the denominator a share list must total to
 */
async function readShareDenominator(address, dp, say, fail) {
  try {
    const denom = await dp.SHARE_DENOMINATOR();
    say(`        share denominator  ${denom.toLocaleString("en-US")}  ` +
        `[read off the contract at ${address}]`);
    say(`        one share unit     ${(100 / Number(denom)).toFixed(4)}%  ` +
        `— percentages to four decimal places`);
    return denom;
  } catch (e) {
    // Not V3.1. Before saying anything else, find out whether this is the
    // OLD contract or a genuinely broken read — those deserve different
    // answers, and guessing between them is how a real fault gets hidden.
    let legacy = null;
    try {
      const old = new ethers.Contract(address, LEGACY_V30_ABI, ethers.provider);
      legacy = await old.BPS_DENOMINATOR();
    } catch (_) {
      /* neither function answered — fall through to the generic failure */
    }

    if (legacy !== null) {
      fail(
        `The contract at ${address} is V3.0, not V3.1.\n` +
        `  It exposes BPS_DENOMINATOR = ${legacy} — its shares are BASIS POINTS,\n` +
        `  where 10000 = 100% and the finest share is 0.01%.\n` +
        `  This script speaks V3.1's SHARE_DENOMINATOR = 1,000,000 (0.0001%).\n` +
        `\n` +
        `  ⛔ Refusing rather than adapting, on purpose: a script that handles\n` +
        `     both would eventually pay the wrong list through the wrong\n` +
        `     contract and nobody would notice until the money had moved.\n` +
        `\n` +
        `  ▶ Either deploy V3.1 (scripts/deploy_v3.js) so the deployment record\n` +
        `    names it, or check deployments/ — the record may still point at\n` +
        `    the superseded address.`
      );
    }

    fail(
      `Could not read a share denominator from ${address}.\n` +
      `  Neither SHARE_DENOMINATOR() (V3.1) nor BPS_DENOMINATOR() (V3.0)\n` +
      `  answered. Check the address in the deployment record and that the\n` +
      `  RPC is reachable. Underlying error: ${e.shortMessage || e.message}`
    );
  }
}

/**
 * Validate a caller-supplied share list against the denominator the CHAIN
 * reported. Nothing here knows what the number should be.
 */
function checkShareTotal(shares, denom, say, fail) {
  const total = shares.reduce((a, b) => a + BigInt(b), 0n);
  if (total !== denom) {
    fail(
      `Shares total ${total.toLocaleString("en-US")}; this contract requires ` +
      `exactly ${denom.toLocaleString("en-US")}.\n` +
      `  One unit is ${(100 / Number(denom)).toFixed(4)}%, so 100% is ` +
      `${denom.toLocaleString("en-US")} — e.g. 12.3456% is ` +
      `${Math.round(12.3456 * Number(denom) / 100)}.`
    );
  }
  return total;
}

/** Format a share count as a percentage string, at the chain's resolution. */
function asPercent(share, denom) {
  return `${(Number(share) * 100 / Number(denom)).toFixed(4)}%`;
}

module.exports = { readShareDenominator, checkShareTotal, asPercent };
