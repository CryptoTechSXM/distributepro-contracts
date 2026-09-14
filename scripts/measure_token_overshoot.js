// scripts/measure_token_overshoot.js
//
// ONE MEASUREMENT. Written 2026-09-12 (session 4) for the owner and a future
// session of Claude. Nobody else touches this.
//
// RUN (dry run, spends nothing):
//   npx hardhat run scripts/measure_token_overshoot.js --network btc20
// RUN (for real — five transactions, gas only):
//   $env:CONFIRM="measure-overshoot"; npx hardhat run scripts/measure_token_overshoot.js --network btc20
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// Brief §19.4 measured the node's eth_estimateGas overshoot on the NATIVE path
// as a FIXED 5,671 gas per batch — the same constant across two different
// batch compositions, to the unit. Brief §19.6 then measured the TOKEN path
// and got 39,869. The disagreement is recorded in the brief and deliberately
// NOT explained.
//
//   native, 3 existing recipients (§19.2)   73,816 est   68,145 mined   5,671
//   native, 2 new + 1 existing  (§19.4)    123,816 est  118,145 mined   5,671
//   token,  3 existing recipients (§19.6)  159,753 est  119,884 mined  39,869
//
// ⚠️ THE HYPOTHESIS THIS TESTS IS UNVERIFIED AND IS STATED AS A HYPOTHESIS.
// Brief §19.6: at estimate time the allowance is non-zero and execution drives
// it to ZERO, clearing a storage slot and earning a gas refund the estimator
// does not model. If that is the whole story, an identical run whose allowance
// is merely REDUCED instead of cleared should overshoot by far less.
//
// ⛔ THIS SCRIPT DOES NOT DECIDE THE ANSWER. It runs the same distribution
// twice, changing exactly ONE thing, and prints six numbers. The comparison is
// PAIRED and INTERNALLY CONTROLLED — same token, same recipients, same payout,
// same wallet, minutes apart — so nothing outside the allowance differs.
//
//   ARM A — approve EXACTLY `required`. The allowance is consumed to ZERO.
//           This reproduces §19.6 and every run the page has ever made.
//   ARM B — approve MORE than `required`. The allowance is REDUCED, never
//           cleared. Nothing else changes.
//
// Reading it afterwards:
//   • overshoot B collapses toward ~5,671  ⇒ the refund is the whole story
//   • overshoot B stays near ~39,869       ⇒ the hypothesis is FALSIFIED and
//                                            the real cause is still unknown
//   • anything between                     ⇒ a partial cause; record it, do
//                                            not narrate past what was measured
//
// ⚠️ WHAT THIS COSTS: five transactions, all gas only. Every recipient is the
// sending wallet itself by default, so the payout returns; the fee leaves twice
// (2% of the payout, ×2 arms). At 0.1 USDT payout that is 0.004 USDT and about
// 0.0004 BTCC of gas.
//
// ⛔ THE OVER-APPROVAL IS CLEANED UP. Arm B deliberately leaves a standing
// allowance, which is exactly what this project refuses to leave on a wallet.
// The last step revokes it and READS IT BACK off the chain. If the script dies
// mid-run, re-run it — step [0] clears any leftover before anything else.
//
// Env vars:
//   TOKEN=0x...        default: USDT on BTC20 (brief §19.5), 6 dp
//   PAYOUT=0.1         human units of THAT TOKEN
//   RECIPIENTS=0xa,0xb comma-separated; SHARES must match in count
//   SHARES=3333,3333,3334
//   OVERAPPROVE=1.5    arm B approves required × this (must be > 1)
//   CONFIRM=measure-overshoot   actually send

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const {
  readShareDenominator,
  checkShareTotal,
} = require("./utils/share_denominator");
const { reportEnv, armed } = require("./utils/session_env");
const { ethers } = hre;

const DEFAULT_TOKEN = "0xaB472AE141Cc0abE698Be3df227513367EE7878A"; // USDT, BTC20, 6 dp
const DEFAULT_PAYOUT = "0.1";
// ⛔ V3.1 SHARE UNITS, not basis points. 333300 = 33.3300%.
// The denominator itself is NEVER written down here — it is read off
// the contract at run time (scripts/utils/share_denominator.js).
const DEFAULT_SHARES = [333300, 333300, 333400];

// Recorded measurements this run is compared against. Brief §19.2 / §19.4 / §19.6.
const NATIVE_OVERSHOOT = 5671n;
const TOKEN_OVERSHOOT_19_6 = 39869n;

// Minimal ERC-20 surface — same reasoning as testrun_token_v3.js: this chain's
// USDT may not return a bool, and a strict ABI would fail decoding a good token.
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256)",
];

const say = (m = "") => console.log(m);
const line = (c = "─", n = 74) => c.repeat(n);

function fail(msg) {
  say("");
  say("⛔ STOPPING");
  say("   " + msg);
  say("");
  process.exit(1);
}

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}

// Right-align a number in a column so the columns can be compared by eye.
function rpad(s, n) {
  s = String(s);
  return " ".repeat(Math.max(0, n - s.length)) + s;
}

function commas(v) {
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function main() {
  // ⛔ Say what this run inherited BEFORE it says what it decided.
  reportEnv(["CONFIRM", "TOKEN", "PAYOUT", "RECIPIENTS", "SHARES", "OVERAPPROVE"]);

  const netName = hre.network.name;

  say("");
  say(line("═"));
  say("  THE ESTIMATOR OVERSHOOT ON THE TOKEN PATH — one paired measurement");
  say(line("═"));
  say("");
  say("  §19.4 measured a FIXED 5,671 gas overshoot on the native path.");
  say("  §19.6 measured 39,869 on the token path. That disagreement is the finding.");
  say("  This runs the SAME distribution twice, changing ONLY the allowance.");
  say("");

  // ── Which contract? Off the deployment record, never typed in. ──────────
  const recordPath = path.join(__dirname, "..", "deployments", `${netName}.json`);
  if (!fs.existsSync(recordPath)) {
    fail(`No deployment record at deployments/${netName}.json — nothing to measure against.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const address = record.address;

  const [signer] = await ethers.getSigners();
  const dp = await ethers.getContractAt("DistributeProV3", address, signer);

  say(`  contract   ${address}`);
  say(`  network    ${netName} (chainId ${record.chainId})`);
  say(`  wallet     ${signer.address}`);
  say("");

  // ── [1] The contract, confirmed on-chain before anything. ──────────────
  say("  [1/9] confirming the contract on-chain ...");
  if ((await ethers.provider.getCode(address)) === "0x") {
    fail(`No contract code at ${address} on ${netName}.`);
  }
  const onChainHouse = await dp.houseRecipient();
  if (await dp.paused()) fail("The contract is PAUSED. Nothing can be distributed.");
  say(`        house    ${onChainHouse}`);
  say(`        paused   false`);

  // ── [2] The token, identified off the chain. ───────────────────────────
  say("  [2/9] identifying the token ...");
  let tokenAddress;
  try {
    tokenAddress = ethers.getAddress((process.env.TOKEN || DEFAULT_TOKEN).trim());
  } catch (_) {
    fail(`TOKEN "${process.env.TOKEN}" is not a valid address.`);
  }
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    fail(`There is no contract at ${tokenAddress} on ${netName}.`);
  }
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

  let decimals, symbol, tokenName;
  try {
    decimals = Number(await token.decimals());
  } catch (_) {
    fail(`${tokenAddress} does not answer decimals() — it is a contract, but not an ERC-20.`);
  }
  try { symbol = await token.symbol(); } catch (_) { symbol = "???"; }
  try { tokenName = await token.name(); } catch (_) { tokenName = "(no name)"; }
  const fmt = (v) => ethers.formatUnits(v, decimals);

  say(`        token      ${tokenName} (${symbol})  ${tokenAddress}`);
  say(`        decimals   ${decimals}` + (decimals === 18 ? "" : "   ⚑ NOT 18 — every figure below uses this"));

  // ── [3] The batch. Identical for both arms — that is the whole point. ──
  say("  [3/9] building the batch (IDENTICAL for both arms) ...");
  const payout = ethers.parseUnits(process.env.PAYOUT || DEFAULT_PAYOUT, decimals);
  if (payout === 0n) fail("PAYOUT is zero — the contract rejects that.");

  let recipients = [];
  let shares = [];
  if (process.env.RECIPIENTS) {
    const rawR = process.env.RECIPIENTS.split(",").map((r) => r.trim()).filter(Boolean);
    const rawS = (process.env.SHARES || "").split(",").map((s) => s.trim()).filter(Boolean);
    const problems = [];
    rawR.forEach((r, i) => {
      try {
        const a = ethers.getAddress(r);
        if (a === ethers.ZeroAddress) {
          problems.push(`entry ${i + 1}: the zero address — the contract rejects it`);
          return;
        }
        recipients.push(a);
      } catch (_) {
        problems.push(`entry ${i + 1}: "${r}" is not a valid address`);
      }
    });
    if (!rawS.length) problems.push("SHARES was not set, but RECIPIENTS was");
    rawS.forEach((s, i) => {
      if (!/^\d+$/.test(s)) {
        problems.push(`SHARES entry ${i + 1}: "${s}" is not a whole number of share units`);
        return;
      }
      shares.push(Number(s));
    });
    if (rawS.length && rawR.length !== rawS.length) {
      problems.push(`RECIPIENTS has ${rawR.length} entries but SHARES has ${rawS.length}`);
    }
    if (problems.length) {
      say("");
      say("  ⛔ RECIPIENTS / SHARES could not be read. Nothing was sent.");
      for (const p of problems) say(`     • ${p}`);
      fail(`${problems.length} problem(s) — fix them and run again.`);
    }
  } else {
    recipients = [signer.address, signer.address, signer.address];
    shares = DEFAULT_SHARES;
  }
  // ⛔ The denominator comes from the CHAIN, never from this file. It also
  // REFUSES a V3.0 contract by name rather than adapting to it — see the
  // header of scripts/utils/share_denominator.js for why that matters.
  const shareDenom = await readShareDenominator(address, dp, say, fail);
  const shareTotal = checkShareTotal(shares, shareDenom, say, fail);

  const partner = ethers.ZeroAddress;
  const [totalBps, totalFee, , , required] = await dp.quote(payout, partner);

  const overMul = Number(process.env.OVERAPPROVE || "1.5");
  if (!(overMul > 1)) {
    fail(`OVERAPPROVE is ${overMul} — it must be greater than 1, or arm B is not an over-approval.`);
  }
  // Integer arithmetic on bigints: required × overMul, via basis points.
  const overBps = BigInt(Math.round(overMul * 10000));
  const overApprove = (required * overBps) / 10000n;
  if (overApprove <= required) {
    fail("The computed over-approval is not larger than `required` — arm B would not differ from arm A.");
  }

  say(`        payout     ${fmt(payout)} ${symbol}`);
  say(`        recipients ${recipients.length}  (${recipients.every((r) => r === signer.address) ? "all this wallet — the payout returns, gas only" : "as given"})`);
  say(`        shares     ${shares.join(" / ")}  (= ${(Number(shareTotal) * 100 / Number(shareDenom)).toFixed(4)}%)`);
  say(`        fee rate   ${Number(totalBps) / 100}%   fee ${fmt(totalFee)} ${symbol}`);
  say(`        required   ${fmt(required)} ${symbol}   ⛔ payout PLUS fee`);
  say(`        arm B approves ${fmt(overApprove)} ${symbol}  (required × ${overMul})`);

  // ── [4] Sanity: previewAmounts must sum to the payout. ─────────────────
  say("  [4/9] checking previewAmounts against the payout ...");
  // Array.from, not the ethers Result directly — a Result is array-LIKE, and
  // .reduce/.filter on it has bitten this project before.
  const amounts = Array.from(await dp.previewAmounts(payout, shares));
  const sum = amounts.reduce((a, b) => a + b, 0n);
  say(`        sum ${fmt(sum)} ${symbol}` + (sum === payout ? "  ✓ equals the payout exactly" : "  ⛔ DOES NOT MATCH"));
  if (sum !== payout) fail("previewAmounts does not sum to the payout. Do not proceed.");

  // ── [5] Balances and the starting allowance. ───────────────────────────
  say("  [5/9] reading balances and the current allowance ...");
  const senderBefore = await token.balanceOf(signer.address);
  const contractBefore = await token.balanceOf(address);
  let allowance = await token.allowance(signer.address, address);
  say(`        sender ${symbol}      ${fmt(senderBefore)}`);
  say(`        contract ${symbol}    ${fmt(contractBefore)}` + (contractBefore === 0n ? "  ✓ holds nothing" : "  ⚠️ NOT ZERO"));
  say(`        allowance        ${fmt(allowance)}`);

  // Two arms, each pulling `required`. The payout returns only if every
  // recipient is this wallet; the fee always leaves.
  const leaving = amounts
    .filter((_, i) => recipients[i] !== signer.address)
    .reduce((a, b) => a + b, 0n);
  const needed = (leaving + totalFee) * 2n;
  if (senderBefore < required) {
    fail(`The wallet holds ${fmt(senderBefore)} ${symbol} but each arm needs ${fmt(required)} available to pull.`);
  }
  if (senderBefore < needed + required) {
    say(`        ⚠️ tight: two arms genuinely consume ${fmt(needed)} ${symbol} and the wallet holds ${fmt(senderBefore)}`);
  }

  // ── [6] The gate. ──────────────────────────────────────────────────────
  say("  [6/9] checking confirmation ...");
  if (!armed("CONFIRM", "measure-overshoot")) {
    say("");
    say(line());
    say("  DRY RUN — nothing was sent. Everything above was read off the chain.");
    say("");
    say("  What the real run will do, in order:");
    say(`    [0] revoke any leftover allowance (currently ${fmt(allowance)})`);
    say(`    ARM A  approve EXACTLY ${fmt(required)} → estimate → distribute → allowance ends at 0`);
    say(`    ARM B  approve ${fmt(overApprove)}      → estimate → distribute → allowance ends above 0`);
    say(`    [9] revoke arm B's leftover and read it back`);
    say("");
    say(`  True cost: gas, plus ${fmt(needed)} ${symbol} that genuinely leaves this wallet.`);
    say("");
    say("  To run it:");
    say("");
    say(`     $env:CONFIRM="measure-overshoot"; npx hardhat run scripts/measure_token_overshoot.js --network ${netName}`);
    say(line());
    say("");
    process.exit(0);
  }

  // ── [0] Clear any leftover allowance before starting. ──────────────────
  // Also the recovery path if a previous run died between the arms.
  say("  [0/9] clearing any leftover allowance before starting ...");
  if (allowance > 0n) {
    const tx0 = await token.approve(address, 0n);
    say(`        tx ${tx0.hash}  waiting ...`);
    await tx0.wait();
    allowance = await token.allowance(signer.address, address);
    say(`        allowance read back: ${fmt(allowance)}` + (allowance === 0n ? "  ✓" : "  ⛔ DID NOT CLEAR"));
    if (allowance !== 0n) fail("Could not clear the allowance. Investigate before measuring.");
  } else {
    say("        already zero — nothing to clear");
  }

  // One arm: approve `approveAmount`, estimate, distribute, report.
  async function runArm(name, approveAmount, note) {
    say("");
    say(line());
    say(`  ARM ${name} — ${note}`);
    say(line());

    say(`        approving ${fmt(approveAmount)} ${symbol} ...`);
    const txA = await token.approve(address, approveAmount);
    say(`        tx ${txA.hash}  waiting ...`);
    const rA = await txA.wait();
    const allowNow = await token.allowance(signer.address, address);
    say(`        approve gas ${commas(rA.gasUsed)}   allowance read back ${fmt(allowNow)}` +
        (allowNow >= required ? "  ✓" : "  ⛔ NOT ENOUGH"));
    if (allowNow < required) fail(`Arm ${name}: the allowance did not take. Nothing distributed.`);

    say(`        estimating gas (allowance is ${fmt(allowNow)}, required is ${fmt(required)}) ...`);
    const est = await dp.distributeToken.estimateGas(
      tokenAddress, recipients, shares, payout, partner
    );
    say(`        ESTIMATE    ${commas(est)}`);

    say(`        distributing ... (do not close the window)`);
    const tx = await dp.distributeToken(tokenAddress, recipients, shares, payout, partner);
    say(`        tx ${tx.hash}   type ${tx.type === 0 ? "0 (legacy) ✓" : tx.type}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      fail(`Arm ${name}: the distribution was mined but REVERTED (status ${receipt.status}). Nobody was paid.`);
    }
    say(`        MINED       ${commas(receipt.gasUsed)}   block ${receipt.blockNumber}`);

    const allowAfter = await token.allowance(signer.address, address);
    const contractAfter = await token.balanceOf(address);
    say(`        allowance after ${fmt(allowAfter)}` +
        (allowAfter === 0n ? "   (slot CLEARED)" : "   (slot still non-zero — REDUCED, not cleared)"));
    say(`        contract ${symbol} after ${fmt(contractAfter)}` +
        (contractAfter === 0n ? "  ✓ held nothing" : "  ⛔ NOT ZERO — INVESTIGATE"));

    const overshoot = est - receipt.gasUsed;
    say(`        OVERSHOOT   ${commas(overshoot)}  (estimate − mined)`);

    return {
      name,
      estimate: est,
      mined: receipt.gasUsed,
      overshoot,
      allowanceAfter: allowAfter,
      hash: receipt.hash,
      block: receipt.blockNumber,
      approveGas: rA.gasUsed,
    };
  }

  // ── [7] ARM A — the allowance is consumed to zero (reproduces §19.6). ──
  say("");
  say("  [7/9] ARM A ...");
  const A = await runArm("A", required, `approve EXACTLY required (${fmt(required)}) — the allowance will be CLEARED`);
  if (A.allowanceAfter !== 0n) {
    say("  ⚠️ Arm A did not end at zero. The arms are not distinguishable — read the numbers with that in mind.");
  }

  // ── [8] ARM B — the allowance is reduced, never cleared. ───────────────
  say("");
  say("  [8/9] ARM B ...");
  const B = await runArm("B", overApprove, `approve MORE than required (${fmt(overApprove)}) — the allowance will only be REDUCED`);
  if (B.allowanceAfter === 0n) {
    say("  ⚠️ Arm B ended at zero too. The over-approval did not survive — the arms did not differ.");
  }

  // ── [9] Clean up the standing allowance arm B left behind. ─────────────
  say("");
  say("  [9/9] revoking the allowance arm B left standing ...");
  if (B.allowanceAfter > 0n) {
    const txR = await token.approve(address, 0n);
    say(`        tx ${txR.hash}  waiting ...`);
    const rR = await txR.wait();
    const finalAllow = await token.allowance(signer.address, address);
    say(`        revoke gas ${commas(rR.gasUsed)}`);
    say(`        allowance READ BACK OFF THE CHAIN: ${fmt(finalAllow)}` +
        (finalAllow === 0n ? "  ✓ no standing permission left behind" : "  ⛔ STILL NON-ZERO — REVOKE IT BY HAND"));
    if (finalAllow !== 0n) {
      fail("The revoke did not take. Do not leave this wallet with a standing allowance.");
    }
  } else {
    say("        nothing left standing");
  }

  // ── The result. Six numbers and no story. ──────────────────────────────
  say("");
  say(line("═"));
  say("  RESULT — the same distribution, twice, differing only in the allowance");
  say(line("═"));
  say("");
  say(`  ${pad("run", 42)}${rpad("estimate", 12)}${rpad("mined", 12)}${rpad("overshoot", 12)}`);
  say("  " + "-".repeat(78));
  say(`  ${pad("native, 3 existing        (brief §19.2)", 42)}${rpad("73,816", 12)}${rpad("68,145", 12)}${rpad("5,671", 12)}`);
  say(`  ${pad("native, 2 new + 1 existing (brief §19.4)", 42)}${rpad("123,816", 12)}${rpad("118,145", 12)}${rpad("5,671", 12)}`);
  say(`  ${pad("token, page run           (brief §19.6)", 42)}${rpad("159,753", 12)}${rpad("119,884", 12)}${rpad("39,869", 12)}`);
  say("  " + "-".repeat(78));
  say(`  ${pad("ARM A — allowance CLEARED   (this run)", 42)}${rpad(commas(A.estimate), 12)}${rpad(commas(A.mined), 12)}${rpad(commas(A.overshoot), 12)}`);
  say(`  ${pad("ARM B — allowance REDUCED   (this run)", 42)}${rpad(commas(B.estimate), 12)}${rpad(commas(B.mined), 12)}${rpad(commas(B.overshoot), 12)}`);
  say("");
  say(`  arm A  tx ${A.hash}  block ${A.block}`);
  say(`  arm B  tx ${B.hash}  block ${B.block}`);
  say("");

  const dMined = B.mined - A.mined;
  const dOver = A.overshoot - B.overshoot;
  say(`  mined B − mined A          ${commas(dMined)}  ` +
      (dMined > 0n
        ? "← arm B burned MORE, which is what a missing refund looks like"
        : "← arm B did not burn more"));
  say(`  overshoot A − overshoot B  ${commas(dOver)}`);
  say("");

  // Read the numbers out loud, without inventing a mechanism for them.
  const abs = (v) => (v < 0n ? -v : v);
  const nearNative = (v) => abs(v - NATIVE_OVERSHOOT) < 3000n;
  say(line());
  if (A.allowanceAfter !== 0n || B.allowanceAfter === 0n) {
    say("  ⚠️ THE ARMS DID NOT DIFFER AS DESIGNED — arm A must end at zero and arm B above it.");
    say("     Whatever the numbers say, this run does not discriminate. Do not draw a conclusion.");
  } else if (nearNative(B.overshoot)) {
    say("  ▶ ARM B's OVERSHOOT COLLAPSED toward the native constant.");
    say("    Consistent with the §19.6 hypothesis: clearing the allowance slot earns a refund");
    say("    the estimator does not model. ⚠️ Consistent with — one paired run, on one token.");
  } else if (B.overshoot > TOKEN_OVERSHOOT_19_6 - 8000n) {
    say("  ▶ ARM B OVERSHOT BY ROUGHLY AS MUCH AS ARM A. THE HYPOTHESIS IS FALSIFIED.");
    say("    The allowance refund is NOT the cause. Record the numbers; do not replace one");
    say("    invented mechanism with another. The next instrument is a per-opcode trace.");
  } else {
    say("  ▶ ARM B OVERSHOT LESS, BUT NOT DOWN TO THE NATIVE CONSTANT.");
    say("    A partial cause at most. Record both figures as measured and leave the remainder");
    say("    open — an unexplained gap is a finding, not a gap in the write-up.");
  }
  say("");
  say("  ⚠️ Whatever this says, nothing is blocked: the page sends gasLimit = estimate × 1.1,");
  say("     so an overshoot is the SAFE direction and unused gas is refunded. This is a");
  say("     planner-accuracy question for token chunking (T4), not a correctness one.");
  say(line());
  say("");
  say(`  Explorer: https://scan.bitcoincode.technology/tx/${A.hash}`);
  say(`            https://scan.bitcoincode.technology/tx/${B.hash}`);
  say("");
  say("  ▶ Paste this whole output back. It goes into brief §19.6 as the measured answer.");
  say("");
}

main().catch((e) => {
  console.error("");
  console.error("⛔ MEASUREMENT FAILED");
  console.error(e);
  console.error("");
  console.error("⚠️ IF THIS DIED BETWEEN THE ARMS, A STANDING ALLOWANCE MAY REMAIN.");
  console.error("   Re-running the script clears it at step [0] before anything else.");
  process.exit(1);
});
