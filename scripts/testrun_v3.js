// scripts/testrun_v3.js
//
// THE FIRST REAL DISTRIBUTION THROUGH DistributeProV3 ON BTC20.
// Written 2026-09-11 for the owner and a future session of Claude.
//
// RUN (dry run, spends nothing):
//   npx hardhat run scripts/testrun_v3.js --network btc20
// RUN (for real):
//   $env:CONFIRM="testrun-native"; npx hardhat run scripts/testrun_v3.js --network btc20
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// 73 tests pass against a local Hardhat chain. That proves the CODE. It does
// not prove that this contract, on THIS four-year-old BSC-fork node, actually
// moves coin — and a deployed contract that has never moved money is not a
// working product, it is an untested one. This is the last gate before the
// frontend is repointed away from V1.
//
// ⛔ IT PAYS THE OWNER'S OWN WALLET, DELIBERATELY.
//
// Recipients default to the deployer's own address, three times over. The
// contract cannot tell the difference — the code path is identical — but it
// means the payout and BOTH fee legs return to the sender, so the true cost
// of this test is gas alone (~0.0001 BTCC). No third party is exposed to a
// contract that has never run in production.
//
// It also exercises two DESIGN DECISIONS on the real chain rather than in a
// test harness:
//   - DUPLICATE RECIPIENTS ARE ALLOWED (brief 2.9). On-chain duplicate
//     detection is O(n²) and would cost more gas than the payout; the
//     frontend warns instead. Three identical addresses is that policy
//     running for real.
//   - DUST GOES TO THE LAST RECIPIENT (brief 7.3). 3333/3333/3334 on an
//     indivisible payout is exactly the case where the remainder appears.
//
// ⚠️ HONEST LIMITATION OF THE DEFAULT: paying yourself does not prove a
// payment to a stranger's wallet arrives, only that the contract's logic
// executes on this chain. The code cannot distinguish them, but say so rather
// than overclaim. Set RECIPIENTS to real addresses for the stronger evidence.
//
// ✅ AND THAT WAS DONE — 2026-09-12, tx 0xf6174203…cfa72aad, block 30,501,437.
// Three recipients, none of them the sender, TWO of them accounts that did not
// exist on this chain at all (balance measured at zero immediately before).
// Each received its exact share; the sender's delta matched to the wei; the
// contract held zero before and after. ▶ The limitation above now applies only
// when RECIPIENTS is left unset. See brief §19.4.
//
// Override with env vars:
//   PAYOUT=0.001                  the amount recipients collectively receive
//   RECIPIENTS=0xaaa,0xbbb,0xccc  comma-separated; SHARES must match in count
//   SHARES=333300,333300,333400   share units, must total exactly 1000000
//
// ─────────────────────────────────────────────────────────────────────────
// ▶ 2026-09-12 — THIS SCRIPT IS NOW THE INSTRUMENT FOR THE STRANGER RUN.
//
// The limitation stated above is the LAST claim on the native send path that
// rests on an argument rather than a measurement. RECIPIENTS closes it, and
// the run is only worth anything if the recipients are NOT the sender. Two
// additions were made for it, both before it was run:
//   - the BEFORE-balances are printed, so a recipient measured at zero and
//     then holding its exact share is evidence rather than an inference;
//   - the gas is ESTIMATED before anything is sent, so the receipt can be
//     checked against a prediction instead of described after the fact.
// Neither changes what is sent. Both are in the dry-run path, which spends
// nothing — always run the dry run first and read it.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const {
  readShareDenominator,
  checkShareTotal,
} = require("./utils/share_denominator");
const { reportEnv, armed } = require("./utils/session_env");
const { ethers } = hre;

const DEFAULT_PAYOUT = "0.001";
// ⛔ V3.1 SHARE UNITS, not basis points. 333300 = 33.3300%.
// The denominator itself is NEVER written down here — it is read off
// the contract at run time (scripts/utils/share_denominator.js).
const DEFAULT_SHARES = [333300, 333300, 333400];

function line(c = "─", n = 66) {
  return c.repeat(n);
}
const say = (m = "") => console.log(m);

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

async function main() {
  // ⛔ Say what this run inherited BEFORE it says what it decided.
  reportEnv(["CONFIRM", "PAYOUT", "RECIPIENTS", "SHARES"]);

  const netName = hre.network.name;

  say("");
  say(line("═"));
  say("  DistributeProV3 — FIRST REAL DISTRIBUTION");
  say(line("═"));
  say("");

  // ── Which contract? Read it from the deployment record, never typed in. ─
  const recordPath = path.join(__dirname, "..", "deployments", `${netName}.json`);
  if (!fs.existsSync(recordPath)) {
    fail(`No deployment record at deployments/${netName}.json — deploy first.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const address = record.address;

  say(`  contract   ${address}`);
  say(`  network    ${netName} (chainId ${record.chainId})`);
  say(`  deployed   block ${record.blockNumber}`);
  say("");

  const [signer] = await ethers.getSigners();
  const dp = await ethers.getContractAt("DistributeProV3", address, signer);

  // ── Confirm the chain agrees with the record before touching anything. ──
  say("  [1/6] confirming the contract on-chain matches the record ...");
  const code = await ethers.provider.getCode(address);
  if (code === "0x") fail(`No contract code at ${address} on ${netName}.`);
  const onChainOwner = await dp.owner();
  const onChainHouse = await dp.houseRecipient();
  const paused = await dp.paused();
  if (paused) fail("The contract is PAUSED. Unpause before distributing.");
  say(`        owner    ${onChainOwner}`);
  say(`        house    ${onChainHouse}`);
  say(`        paused   false`);

  // ── Build the batch. ───────────────────────────────────────────────────
  say("  [2/6] building the batch ...");
  const payout = ethers.parseEther(process.env.PAYOUT || DEFAULT_PAYOUT);

  let recipients;
  let shares;
  if (process.env.RECIPIENTS) {
    // ⛔ VALIDATE EVERY ENTRY AND NAME THE BAD ONE. Added 2026-09-12, after a
    // run with placeholder addresses still in RECIPIENTS answered with a raw
    // ethers stack trace — `TypeError: invalid address` and eight lines of
    // node internals — instead of saying which entry was wrong. This script's
    // whole job is that somebody pastes addresses into it, so a bad paste is
    // the EXPECTED input, not an exceptional one. Same rule the frontend's
    // problems list already follows: every bad line, with its position.
    const rawRecipients = process.env.RECIPIENTS.split(",")
      .map((r) => r.trim())
      .filter(Boolean);
    if (!rawRecipients.length) fail("RECIPIENTS was set but is empty.");

    const problems = [];
    recipients = [];
    rawRecipients.forEach((r, i) => {
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

    const rawShares = (process.env.SHARES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!rawShares.length) problems.push("SHARES was not set, but RECIPIENTS was");
    shares = [];
    rawShares.forEach((s, i) => {
      if (!/^\d+$/.test(s)) {
        problems.push(`SHARES entry ${i + 1}: "${s}" is not a whole number of share units`);
        return;
      }
      shares.push(Number(s));
    });

    if (rawShares.length && rawRecipients.length !== rawShares.length) {
      problems.push(
        `RECIPIENTS has ${rawRecipients.length} entries but SHARES has ${rawShares.length} — they must match one for one`
      );
    }

    if (problems.length) {
      say("");
      say("  ⛔ RECIPIENTS / SHARES could not be read. Nothing was sent.");
      say("");
      for (const p of problems) say(`     • ${p}`);
      say("");
      say("  Expected shape (one share unit per recipient, totalling the");
      say("  contract's own SHARE_DENOMINATOR — 1000000 on V3.1):");
      say('     $env:RECIPIENTS="0xabc…,0xdef…,0x123…"');
      say('     $env:SHARES="333300,333300,333400"');
      fail(`${problems.length} problem(s) in RECIPIENTS/SHARES — fix them and run again.`);
    }
  } else {
    // Default: pay the sender, three times. See the header.
    recipients = [signer.address, signer.address, signer.address];
    shares = DEFAULT_SHARES;
  }

  // ⛔ The denominator comes from the CHAIN, never from this file. It also
  // REFUSES a V3.0 contract by name rather than adapting to it — see the
  // header of scripts/utils/share_denominator.js for why that matters.
  const shareDenom = await readShareDenominator(address, dp, say, fail);
  const shareTotal = checkShareTotal(shares, shareDenom, say, fail);
  say(`        payout     ${ethers.formatEther(payout)}`);
  say(`        recipients ${recipients.length}`);
  say(`        shares     ${shares.join(" / ")}  (= ${(Number(shareTotal) * 100 / Number(shareDenom)).toFixed(4)}%)`);

  // ── Ask the CONTRACT what it will charge. Not our own arithmetic. ──────
  say("  [3/6] asking the contract for its quote ...");
  const partner = ethers.ZeroAddress; // no partner: the 2% floor
  const q = await dp.quote(payout, partner);
  const [totalBps, totalFee, houseFee, partnerFee, required] = q;

  say(`        fee rate     ${Number(totalBps) / 100}%  (${totalBps} bps)`);
  say(`        total fee    ${ethers.formatEther(totalFee)}`);
  say(`          house      ${ethers.formatEther(houseFee)}`);
  say(`          partner    ${ethers.formatEther(partnerFee)}  (no partner)`);
  say(`        YOU SEND     ${ethers.formatEther(required)}  = payout + fee, exactly`);

  // ── And exactly who gets what, including where the dust lands. ─────────
  say("  [4/6] previewing the per-recipient amounts ...");
  const amounts = await dp.previewAmounts(payout, shares);
  let sum = 0n;
  for (let i = 0; i < amounts.length; i++) {
    const isLast = i === amounts.length - 1;
    say(
      `        ${pad(`[${i}] ${recipients[i].slice(0, 10)}…`, 22)}` +
        `${pad(ethers.formatEther(amounts[i]), 24)}` +
        `${isLast ? "← carries the dust" : ""}`
    );
    sum += amounts[i];
  }
  say(`        ${pad("sum", 22)}${pad(ethers.formatEther(sum), 24)}` +
      (sum === payout ? "✓ equals the payout exactly" : "⛔ DOES NOT MATCH THE PAYOUT"));
  if (sum !== payout) fail("previewAmounts does not sum to the payout. Do not proceed.");

  // ── Balance snapshot, so the result is measured and not assumed. ───────
  const unique = [...new Set([...recipients, onChainHouse, signer.address])];
  const before = {};
  for (const a of unique) before[a] = await ethers.provider.getBalance(a);
  const contractBefore = await ethers.provider.getBalance(address);

  // ⛔ PRINT THE BEFORE-BALANCES. Added 2026-09-12 for the stranger-recipient
  // run. The end-of-run table shows deltas, and a delta is only as convincing
  // as what it started from: a recipient measured at ZERO before, holding its
  // exact share after, cannot be explained by anything the sender already had.
  // It also tells us which recipients are brand-new accounts, which is the
  // expensive gas case (~34,800 vs ~9,451 for one that already exists).
  say("");
  say("  balances BEFORE — a recipient at zero makes its delta unarguable:");
  say(`     ${pad("address", 46)}${pad("balance before", 24)}role`);
  say("     " + "-".repeat(96));
  for (const a of unique) {
    const roles = [];
    if (a === signer.address) roles.push("SENDER");
    if (a === onChainHouse) roles.push("house");
    const n = recipients.filter((r) => r === a).length;
    if (n) roles.push(n > 1 ? `recipient ×${n}` : "recipient");
    const fresh =
      before[a] === 0n ? "  ⚑ ZERO — account does not exist yet, costs ~25,000 more gas to pay" : "";
    say(`     ${pad(a, 46)}${pad(ethers.formatEther(before[a]), 24)}${roles.join(", ")}${fresh}`);
  }
  say("");
  say(`        contract balance before: ${ethers.formatEther(contractBefore)}` +
      (contractBefore === 0n ? "  ✓ holds nothing" : "  ⚠️ NOT ZERO"));

  // ── PREDICT the gas before any is spent. Added 2026-09-12. ─────────────
  // §18.2's standard: estimateGas predicted the deploy to the unit. A number
  // that exists BEFORE the receipt is a prediction; the same number read
  // afterwards is just a description. eth_estimateGas signs nothing.
  let gasEstimate = null;
  try {
    gasEstimate = await dp.distributeNative.estimateGas(recipients, shares, payout, partner, {
      value: required,
    });
    say(`        gas estimate:            ${gasEstimate}  ← predicted BEFORE sending`);
  } catch (e) {
    const m = (e.shortMessage || e.message || String(e)).replace(/\s+/g, " ").slice(0, 90);
    say(`        gas estimate:            unavailable — ${m}`);
  }

  // ── Can the sender actually cover it? Better to find out in the dry run. ─
  let gasPriceNow = 0n;
  try {
    gasPriceNow = (await ethers.provider.getFeeData()).gasPrice || 0n;
  } catch (_) {
    gasPriceNow = 0n;
  }
  const gasAllow = (gasEstimate || 250000n) * (gasPriceNow || 1000000000n);
  const need = required + gasAllow;
  const senderHas = before[signer.address];
  say(`        sender needs:            ${ethers.formatEther(need)}  (send + gas allowance)`);
  say(`        sender has:              ${ethers.formatEther(senderHas)}` +
      (senderHas >= need ? "  ✓" : "  ⛔ NOT ENOUGH"));
  if (senderHas < need) {
    fail(
      `The sending wallet holds ${ethers.formatEther(senderHas)} but needs about ` +
        `${ethers.formatEther(need)}. Fund it or lower PAYOUT.`
    );
  }

  // ── Gate. ──────────────────────────────────────────────────────────────
  say("");
  say("  [5/6] checking confirmation ...");
  if (!armed("CONFIRM", "testrun-native")) {
    say("");
    say(line());
    say("  DRY RUN — nothing was sent.");
    say("");
    say(`  This would send ${ethers.formatEther(required)} and pay it out as above.`);
    // ⛔ SAY WHAT IS TRUE OF THIS RUN, not what is usually true. Corrected
    // 2026-09-12: this used to read "gas only, because every leg returns to
    // your wallet (unless you overrode RECIPIENTS)" on EVERY run — including
    // runs that were paying other wallets, where the payout genuinely leaves.
    // The caveat was in the sentence, but the headline said the opposite of
    // the case in front of the reader, on the one line that answers "what
    // does this cost me". Same defect family as the frontend's fabricated fee
    // reason: a true-sounding statement that is not true of THIS case.
    const outsiders = recipients.filter((r) => r !== signer.address);
    if (outsiders.length === 0) {
      say(`  True cost to you: GAS ONLY — every recipient is your own wallet, so`);
      say(`  the payout and both fee legs come straight back.`);
    } else {
      const leaving = amounts
        .filter((_, i) => recipients[i] !== signer.address)
        .reduce((a, b) => a + b, 0n);
      say(`  True cost to you: gas, PLUS ${ethers.formatEther(leaving)} that genuinely`);
      say(`  LEAVES for ${outsiders.length} wallet(s) that are not the sender. The house fee`);
      say(`  returns only because the house recipient is this wallet.`);
    }
    say("");
    say("  To run it for real:");
    say("");
    say(`     $env:CONFIRM="testrun-native"; npx hardhat run scripts/testrun_v3.js --network ${netName}`);
    say(line());
    say("");
    process.exit(0);
  }

  // ── Go. ────────────────────────────────────────────────────────────────
  say("  [6/6] sending the distribution ... (do not close the window)");
  const tx = await dp.distributeNative(recipients, shares, payout, partner, { value: required });
  say(`        tx sent:  ${tx.hash}`);
  say(`        type:     ${tx.type === 0 ? "0 (legacy) ✓" : tx.type}`);
  say(`        waiting for the receipt ...`);

  const receipt = await tx.wait();

  // ⛔ DO NOT TRUST receipt.gasPrice ON THIS CHAIN. Measured 2026-09-11.
  //
  // ethers' `receipt.gasPrice` reads the receipt's `effectiveGasPrice` field,
  // which was INTRODUCED BY EIP-1559. BTC20's node is pre-London (measured:
  // no baseFeePerGas in its block headers), so its receipts do not carry that
  // field at all and ethers hands back 0.
  //
  // The first run of this script did exactly that: it computed a gas cost of
  // ZERO, predicted the sender's balance would be unchanged, and then reported
  // "⛔ MISMATCH" against a wallet that had correctly paid 68,145 gas. The
  // CONTRACT was perfect — payout and fee both returned, contract balance zero
  // before and after. The BUG WAS IN THIS SCRIPT'S ARITHMETIC.
  //
  // This is the same root cause as the type-2 transaction problem, surfacing
  // somewhere it was not anticipated: a modern field simply missing from an
  // old node. `tx.gasPrice` comes from the transaction WE SENT, so it is
  // always present, and on a chain with no fee market the two are identical
  // anyway.
  const effectiveGasPrice =
    receipt.gasPrice && receipt.gasPrice > 0n ? receipt.gasPrice : tx.gasPrice;
  const gasPriceSource =
    receipt.gasPrice && receipt.gasPrice > 0n
      ? "receipt.effectiveGasPrice"
      : "tx.gasPrice (receipt had none — pre-London node)";
  const gasCost = receipt.gasUsed * effectiveGasPrice;

  say("");
  say(line("═"));
  say("  ✅ DISTRIBUTION CONFIRMED");
  say(line("═"));
  say(`  tx           ${receipt.hash}`);
  say(`  block        ${receipt.blockNumber}`);
  say(`  gas used     ${receipt.gasUsed}  (${receipt.gasUsed / BigInt(recipients.length)} per recipient)`);
  say(`  gas price    ${ethers.formatUnits(effectiveGasPrice, "gwei")} gwei  [from ${gasPriceSource}]`);
  say(`  gas cost     ${ethers.formatEther(gasCost)}`);
  say("");

  // ── THE HOLD-NOTHING RULE, CHECKED ON MAINNET. ─────────────────────────
  const contractAfter = await ethers.provider.getBalance(address);
  say("  ⛔ the hold-nothing rule, measured on the real chain:");
  say(`     contract balance after: ${ethers.formatEther(contractAfter)}` +
      (contractAfter === 0n ? "  ✓ ZERO — nothing was kept" : "  ⛔ NOT ZERO — INVESTIGATE"));
  say("");

  // ── Did everyone actually get paid? Measured from balances. ────────────
  const expected = {};
  const bump = (a, v) => (expected[a] = (expected[a] || 0n) + v);
  for (let i = 0; i < recipients.length; i++) bump(recipients[i], amounts[i]);
  bump(onChainHouse, houseFee);
  bump(signer.address, -required - gasCost);

  say("  balance changes, expected vs actual:");
  say(`     ${pad("address", 46)}${pad("expected", 24)}actual`);
  say("     " + "-".repeat(90));
  let allMatch = true;
  for (const a of unique) {
    const after = await ethers.provider.getBalance(a);
    const actual = after - before[a];
    const exp = expected[a] || 0n;
    const ok = actual === exp;
    if (!ok) allMatch = false;
    say(
      `     ${pad(a, 46)}${pad(ethers.formatEther(exp), 24)}` +
        `${pad(ethers.formatEther(actual), 24)}${ok ? "✓" : "⛔ MISMATCH"}`
    );
  }
  say("");

  if (!allMatch) {
    say("  ⛔ At least one balance did not move as predicted. Do NOT repoint the");
    say("     frontend. Investigate before anything else.");
    say("");
    process.exit(1);
  }

  say(line("═"));
  say("  ▶ V3 HAS NOW MOVED REAL MONEY ON BTC20, AND THE BOOKS BALANCE.");
  say(line("═"));
  say("");
  say(`  Explorer: https://scan.bitcoincode.technology/tx/${receipt.hash}`);
  say("");
  if (!process.env.RECIPIENTS) {
    say("  ⚠️ Reminder: recipients were your OWN address three times. This proves");
    say("     the contract executes correctly on this chain. It does not, on its");
    say("     own, prove delivery to someone else's wallet — the code cannot tell");
    say("     the difference, but the stronger test is RECIPIENTS=<real addresses>.");
    say("");
  }
}

main().catch((e) => {
  console.error("");
  console.error("⛔ TEST RUN FAILED");
  console.error(e);
  process.exit(1);
});
