// scripts/utils/session_env.js
//
// THE GUARD THAT STOPS A STALE POWERSHELL VARIABLE FROM SPENDING MONEY.
// Written 2026-09-12 (session 4) for the owner and a future session of Claude.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS — it is not hypothetical, it happened
//
// `measure_token_overshoot.js` was handed over as a DRY RUN that "spends
// nothing". It sent five transactions and moved real USDT on its very first
// invocation. Nothing was lost and nothing was harmed, but the promise on the
// screen was false.
//
// ⛔ THE CAUSE, measured from the transcript and not guessed: in PowerShell,
// `$env:CONFIRM="yes"` is a SESSION variable. It lives for the life of the
// WINDOW, not for the life of the command. An earlier token run in that same
// window had set CONFIRM, TOKEN, PAYOUT, RECIPIENTS and SHARES. Every one of
// them was still set. The new script read CONFIRM, found "yes", and armed
// itself — while telling the reader it was a dry run.
//
// ⛔⛔ THIS WAS NEVER ABOUT ONE SCRIPT. Five scripts in this repo gate on the
// SAME generic word:
//
//     deploy_v3.js            CONFIRM=yes  →  deploys a NEW contract to BTC20
//     set_partner.js          CONFIRM=yes  →  writes a partner rate on-chain
//     testrun_v3.js           CONFIRM=yes  →  sends native coin
//     testrun_token_v3.js     CONFIRM=yes  →  sends ERC-20  (APPROVE=yes too)
//     measure_token_overshoot.js
//
// In a window where CONFIRM=yes was ever typed, NONE of those five has a dry
// run any more. `deploy_v3.js` is the one that matters: it would deploy a new
// mainnet contract and rename the deployment record, with no gate in the way.
//
// ▶ THE FIX, and why it is shaped like this: each script now demands its OWN
// confirmation phrase. A stale `CONFIRM="yes"` matches nothing, so every
// script falls back to its dry run — which is the safe direction, and the
// direction a stale variable should always fail in. The phrase also has to be
// typed fresh per script, so it cannot be inherited from a different task.
//
// ▶ AND THE SECOND HALF, which matters as much: `reportEnv` PRINTS every
// recognised variable it can see before anything runs. The measurement run
// also silently inherited RECIPIENTS, SHARES, TOKEN and PAYOUT from the
// previous command. That did no harm by luck, not by design. Input that
// arrives invisibly is the same defect family as a number displayed without
// its basis — say where it came from, on screen, every time.

const fs = require("fs");
const path = require("path");

const say = (m = "") => console.log(m);

// Variables that can change what a run DOES. Printed whenever they are set.
const KNOWN = [
  "CONFIRM",
  "APPROVE",
  "TOKEN",
  "PAYOUT",
  "RECIPIENTS",
  "SHARES",
  "PARTNER",
  "BPS",
  "OVERAPPROVE",
  "HOUSE_RECIPIENT",
  "EXPECTED_DEPLOYER",
];

/**
 * ⛔⛔ ADDED 2026-09-13 (session 5) BECAUSE THIS GUARD WAS TELLING THE READER
 * SOMETHING IT COULD NOT KNOW.
 *
 * The header line used to read "ENVIRONMENT INHERITED FROM THIS SHELL WINDOW"
 * and print every recognised variable underneath it. But by the time this
 * runs, dotenv has already merged `.env` into process.env, so a permanent
 * project setting and a dangerous leftover look EXACTLY alike from here.
 *
 * MEASURED: the V3.1 deploy dry run was started in a brand-new PowerShell
 * window — nothing could have been inherited — and the guard still announced
 * EXPECTED_DEPLOYER as inherited from the shell. It came from `.env`.
 *
 * ▶ That is this project's oldest defect family wearing a safety badge: a
 * true-looking line that is false of the case in front of the reader (see
 * [[cryptonova-frontend-truth]], the dry-run footer in testrun_v3.js, and the
 * hardcoded "viaIR: true" in §20.4). A guard that cries wolf on every normal
 * run is a guard that gets ignored — which is exactly how the original
 * CONFIRM=yes failure happened.
 *
 * ⛔ PRIVACY, and it is not negotiable: this reads `.env` ONLY to look up the
 * KNOWN names below. No other key's value is ever read, compared, returned or
 * printed, and PRIVATE_KEY is deliberately absent from KNOWN. Claude itself
 * never reads this file; the script does, on the owner's own machine.
 */
function envFileValues() {
  try {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8");
    const parsed = require("dotenv").parse(src);
    const out = {};
    for (const k of KNOWN) {
      if (parsed[k] !== undefined) out[k] = parsed[k];
    }
    return out; // KNOWN keys only. Everything else is discarded unread.
  } catch (_) {
    return {}; // no .env, or unreadable — then everything reads as ambient
  }
}

/**
 * Where did this value actually come from?
 *
 * dotenv does NOT override a variable the shell already set, so a name can be
 * in `.env` while the SHELL's value is the one in force. That case is the
 * dangerous one and it gets named specifically.
 */
function sourceOf(k, fileVals) {
  const live = process.env[k];
  if (!(k in fileVals)) return { label: "SHELL", warn: true };
  if (fileVals[k] === live) return { label: ".env", warn: false };
  return { label: "SHELL — OVERRIDES .env", warn: true };
}

function short(v) {
  v = String(v);
  return v.length > 58 ? v.slice(0, 55) + "..." : v;
}

/**
 * Print every recognised environment variable that is currently set.
 *
 * ⛔ Call this BEFORE the first line of real work, so the reader sees what the
 * run inherited before they see what it decided.
 *
 * @param {string[]} [names] variables this script actually reads; the rest are
 *                           still listed, flagged as not used here.
 */
function reportEnv(names) {
  const used = names && names.length ? names : KNOWN;
  const present = KNOWN.filter((k) => process.env[k] !== undefined && process.env[k] !== "");
  if (!present.length) return;

  const fileVals = envFileValues();
  const sources = present.map((k) => sourceOf(k, fileVals));
  const anyAmbient = sources.some((s) => s.warn);

  say("  ENVIRONMENT THIS RUN CAN SEE, and where each value came from:");
  for (let i = 0; i < present.length; i++) {
    const k = present[i];
    const src = sources[i];
    const mine = used.includes(k);
    say(
      `     ${src.warn ? "⚠️" : "  "} ${k.padEnd(18)}${short(process.env[k]).padEnd(46)}` +
      `[${src.label}]${mine ? "" : "   (this script does not read it)"}`
    );
  }
  // ⛔ THE OPPOSITE FAILURE, and it is worse than a stale shell variable.
  // A stale CONFIRM dies when the window closes. A CONFIRM written into .env
  // is a STANDING permission to spend that survives reboots, and every "dry
  // run" in this repo would silently be a live run forever after.
  const armingInFile = ["CONFIRM", "APPROVE"].filter((k) => k in fileVals);
  if (armingInFile.length) {
    say("");
    say(`     ⛔⛔ ${armingInFile.join(" and ")} IS WRITTEN INTO .env.`);
    say("        That is a PERMANENT arm. It does not expire with the window, so");
    say("        every script in this repo has lost its dry run until it is removed.");
    say("        ▶ Delete that line from .env before running anything else.");
  }

  if (anyAmbient) {
    say("");
    say("     ⚠️ The ⚠️ lines did NOT come from .env — they are set in this shell window.");
    say("        In PowerShell, $env:X lives for the life of the WINDOW, not the command,");
    say("        so a leftover from an earlier task looks identical to a deliberate one.");
    say("        If any of them is a leftover, open a NEW window and run this again.");
  } else {
    say("");
    say("     ✓ Every line above came from .env — nothing was inherited from this window.");
  }
  say("");
}

/**
 * Is this run armed to spend money?
 *
 * ⛔ Deliberately NOT `=== "yes"`. A per-script phrase cannot be inherited
 * from a different script's earlier run, which is the whole point.
 *
 * @param {string} varName e.g. "CONFIRM" or "APPROVE"
 * @param {string} phrase  the exact value this script demands
 * @returns {boolean}
 */
function armed(varName, phrase) {
  const v = process.env[varName];
  if (v === phrase) return true;
  if (v !== undefined && v !== "") {
    // ⛔ Say it out loud. A guard that refuses in silence teaches the reader
    // that the variable does not work, and the next thing they try is worse.
    say("");
    say(`  ⚠️ ${varName} is set to "${short(v)}", which is NOT this script's phrase.`);
    say(`     This script only arms on ${varName}="${phrase}". Treating this as a DRY RUN.`);
    say(`     (That is deliberate: a generic "yes" left over in this window must not arm anything.)`);
    say("");
  }
  return false;
}

module.exports = { reportEnv, armed, KNOWN };
