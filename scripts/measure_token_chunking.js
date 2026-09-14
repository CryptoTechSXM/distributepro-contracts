// scripts/measure_token_chunking.js
//
// THE T4 INSTRUMENT. Written 2026-09-14 (session 9) for the owner and a future
// session of Claude. Nobody else touches this.
//
// RUN (dry run — spends NOTHING):
//   npx hardhat run scripts/measure_token_chunking.js --network btc20
// RUN (for real — a handful of transactions, gas only, NO distribution ever):
//   $env:CONFIRM="measure-token-chunking"; npx hardhat run scripts/measure_token_chunking.js --network btc20
//
// ─────────────────────────────────────────────────────────────────────────
// ⛔⛔ THIS SCRIPT NEVER SENDS A DISTRIBUTION. Read that again before editing
// it. It signs only `approve` transactions; every gas figure comes from
// `eth_estimateGas`, which SIMULATES and moves nothing. Some arms measure
// against DERIVED ADDRESSES NOBODY HOLDS THE KEY TO — sending to them would
// destroy the payout permanently. That is safe ONLY because nothing sends.
// If you ever add a send path here, delete the derived addresses first.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// T4 is token chunking. The question it is blocked on is NOT "how big should a
// token batch be" — it is CAN A TOKEN BATCH BE MEASURED AT ALL BEFORE IT IS
// SENT? The native planner sizes every batch from measured gas before anything
// is signed, by estimating against a tiny probe payout. `distributeToken` pulls
// with `transferFrom`, which reverts without an allowance, so the same trick
// may or may not be available. If it is, T4 is the native planner with the
// allowance moved in front of it. If it is not, T4 needs a different shape.
//
// ─────────────────────────────────────────────────────────────────────────
// ⛔⛔ WHAT THE FIRST DRY RUN FOUND, 2026-09-14 — and why this file was rewritten
//
// 1. A STANDING ALLOWANCE OF 1.02 USDT was already sitting on the deployer
//    wallet against this contract. This project's rule is that no standing
//    allowance is ever left on a wallet. Step [0] now finds WHERE IT CAME FROM
//    out of the token's own Approval log before anything clears it. Clearing an
//    unexplained allowance is working around it; explaining it is closing it.
//
// 2. ⛔⛔ THE PROBE FLOOR IS 1.0 USDT ON THIS TOKEN AND THE WALLET HOLDS
//    0.016962. app.html's `probePayoutFor` ends with an UNCONDITIONAL floor at
//    SHARE_DENOMINATOR — 1,000,000 of the token's SMALLEST unit. On an
//    18-decimal coin that is dust, which is the only case it was ever written
//    against. On 6-decimal USDT it is ONE WHOLE TOKEN, and the planner cannot
//    even measure itself.
//
//    ⚠️ AND THE FLOOR IS NOT WHAT THE TWO STATED REASONS REQUIRE. They are:
//      (a) every recipient must receive >= 1 unit — needs payout >= N, so at
//          most 250 units for a full batch;
//      (b) the house fee must not round to zero — measured 2026-09-14 (§22.7b):
//          at a 4-wei payout the fee leg is not paid and the estimate falls
//          8,414 gas, in the UNSAFE direction. At 2% that needs payout >= 50.
//    Both are satisfied around 250 units. The floor is ~4,000x larger.
//
//    ⚠️ BUT THE FLOOR IS NOT SIMPLY WRONG. On a LUMPY list carrying a 0.0001%
//    line, minShare is 1 and the requirement genuinely reaches 1,000,000. The
//    floor is the worst case applied UNCONDITIONALLY to lists that do not need
//    it. ▶ So this file stops treating the floor as a constant and MEASURES
//    where it actually is (arm [F]), because T4 has to be designed on the real
//    number, not on a constant that was harmless on the only path it ever ran.
//
// 3. Composition drift: 131 of the 159 addresses hold USDT today (17.6% fresh)
//    where §22.7a measured 45.9% fresh at the block the run was mined. Both are
//    true; those addresses have been paid since. Reported, never reconciled.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT IT MEASURES
//
//   [0] THE STANDING ALLOWANCE — where it came from, out of the Approval log.
//   [A] NO ALLOWANCE  — does `estimateGas` really revert? (the T3 comment)
//   [F] THE FLOOR     — walk the payout DOWN and find where the estimate falls
//                       off a cliff. Replaces the constant with a measurement.
//   [B] PROBE vs REAL — does a probe-payout estimate track a real-payout one?
//   [C] COMPOSITION   — the marginal for an EXISTING vs a BRAND-NEW holder,
//                       measured directly. §22.7a has only a blended 19,652 and
//                       a DERIVED 13,100; this replaces the derivation.
//   [D] THE CEILING   — halve-then-climb, per population, against 50% of a
//                       block. §22.7a predicts ~199 by extrapolation; this asks
//                       the chain.
//   [E] ALLOWANCE SIZE— can the estimator tell a final batch (allowance cleared,
//                       15,000 refund) from a non-final one? §19.7 says no.
//
// Env vars:
//   TOKEN=0x...      default: USDT on BTC20 (brief §19.5), 6 dp
//   PAYOUT=0.001     human units of THAT TOKEN, for the "real payout" arm
//   FRACTION=0.5     block fraction the ceiling search aims at (app.html's own)
//   NEWCOUNT=300     derived never-used addresses to build for [C]/[D]
//   CONFIRM=measure-token-chunking   arm the spending steps

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { readShareDenominator } = require("./utils/share_denominator");
const { reportEnv, armed } = require("./utils/session_env");
const { ethers } = hre;

const DEFAULT_TOKEN = "0xaB472AE141Cc0abE698Be3df227513367EE7878A"; // USDT, BTC20, 6 dp
const DEFAULT_PAYOUT = "0.001";
const DEFAULT_FRACTION = 0.5;
const DEFAULT_NEWCOUNT = 300;

// Recorded figures this run is compared against, so a disagreement is VISIBLE
// rather than quietly replacing them. Brief §22.7a.
const RECORDED_TOKEN_MARGINAL_BLENDED = 19652n; // 46%-new mixture, two-point
const RECORDED_TOKEN_MARGINAL_DERIVED = 13100n; // existing holder, DERIVED not run
const RECORDED_NEW_MARGINAL_BENCH = 27346n;     // GasBench, brand-new, hardhat
const RECORDED_NATIVE_MARGINAL = 9371n;         // §22.7a, existing accounts
const RECORDED_FEE_CLIFF = 8414n;               // §22.7b, fee leg not paid

// Minimal ERC-20 surface. Same reasoning as measure_token_overshoot.js: this
// chain's USDT may not return a bool and a strict ABI fails to decode a good
// token. ⛔ No transfer() — this script has no business naming one.
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
];

const say = (m = "") => console.log(m);
const line = (c = "─", n = 78) => c.repeat(n);

function fail(msg) {
  say(""); say("⛔ STOPPING"); say("   " + msg); say("");
  process.exit(1);
}
const commas = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const rpad = (s, n) => " ".repeat(Math.max(0, n - String(s).length)) + String(s);
const pad  = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));

/* app.html's `probePayoutFor`, reproduced EXACTLY — including the
   unconditional floor. Kept so the two numbers can be printed side by side. */
function probeFloorAppHtml(shares, shareDenom) {
  let minShare = shareDenom;
  for (const s of shares) { const b = BigInt(s); if (b < minShare) minShare = b; }
  if (minShare <= 0n) minShare = 1n;
  const p = (shareDenom + minShare - 1n) / minShare; // ceil
  return p < shareDenom ? shareDenom : p;
}

/* The SAME arithmetic WITHOUT the unconditional floor — i.e. only what
   reason (a) actually requires: every line receives at least one unit. */
function probeMinForShares(shares, shareDenom) {
  let minShare = shareDenom;
  for (const s of shares) { const b = BigInt(s); if (b < minShare) minShare = b; }
  if (minShare <= 0n) minShare = 1n;
  const p = (shareDenom + minShare - 1n) / minShare;
  return p < 1n ? 1n : p;
}

/* Largest-remainder apportionment — app.html's `apportion`. Reproduced rather
   than imported because app.html is a browser file. */
function apportion(shares, total) {
  const n = shares.length;
  if (n === 0) return [];
  const sum = shares.reduce((a, b) => a + BigInt(b), 0n);
  if (sum === 0n) return shares.map(() => 0n);
  const base = [], rem = [];
  let used = 0n;
  for (let i = 0; i < n; i++) {
    const exact = BigInt(shares[i]) * total;
    const q = exact / sum;
    base.push(q); used += q;
    rem.push({ i, r: exact - q * sum });
  }
  let left = total - used;
  rem.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (let k = 0; k < rem.length && left > 0n; k++, left--) base[rem[k].i] += 1n;
  return base;
}

/* Deterministic addresses that have provably never been used, from a fixed
   seed so two runs measure the SAME list. ⛔ NOBODY HOLDS THESE KEYS. */
function derivedNeverUsed(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const h = ethers.keccak256(ethers.toUtf8Bytes("dp-t4-probe-2026-09-14/" + i));
    out.push(ethers.getAddress("0x" + h.slice(26)));
  }
  return out;
}

/* Balances for a WHOLE population, never a sample — §22.7a's five-address probe
   said "all existing holders" about a list that was 46% fresh. */
async function balancesOf(token, addrs, chunk = 25) {
  const out = [];
  for (let i = 0; i < addrs.length; i += chunk) {
    const got = await Promise.all(addrs.slice(i, i + chunk).map((a) => token.balanceOf(a)));
    out.push(...got);
    process.stdout.write(`\r        balances ${Math.min(i + chunk, addrs.length)}/${addrs.length} ...   `);
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  return out;
}

/* app.html's `tryEstimate` classification: a decodable custom error from OUR
   contract is a real fault and must stop; anything else means the node refused.
   ⛔ Halving on a genuine revert would hide a real fault forever. */
async function tryEstimate(dp, iface, token, addrs, shares, payout, partner) {
  try {
    return { gas: await dp.distributeToken.estimateGas(token, addrs, shares, payout, partner) };
  } catch (e) {
    const cands = [e && e.data, e && e.info && e.info.error && e.info.error.data,
                   e && e.error && e.error.data];
    for (const c of cands) {
      if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) {
        try { if (iface.parseError(c)) return { fatal: e, data: c }; } catch (_) { /* not ours */ }
      }
    }
    return { tooBig: true, why: e };
  }
}

/* app.html's `searchBatchSize`: halve DOWN until something fits, then binary
   search back UP into the headroom. Halving alone wastes half the block. */
async function searchBatchSize(start, fits, budget = 60) {
  let lo = 0, hi = start + 1, size = start, calls = 0;
  while (size >= 1 && calls < budget) {
    if (await fits(size)) { lo = size; calls++; break; }
    calls++; hi = size;
    if (size === 1) break;
    size = Math.floor(size / 2);
  }
  while (hi - lo > 4 && calls < budget - 5) {
    const mid = Math.floor((lo + hi) / 2);
    if (mid <= lo || mid >= hi) break;
    if (await fits(mid)) lo = mid; else hi = mid;
    calls++;
  }
  return { size: lo, calls };
}

async function main() {
  // ⛔ Say what this run inherited BEFORE it says what it decided (§20.5).
  reportEnv(["CONFIRM", "TOKEN", "PAYOUT", "FRACTION", "NEWCOUNT"]);

  const netName = hre.network.name;
  const ARMED = armed("CONFIRM", "measure-token-chunking");

  say("");
  say(line("═"));
  say("  T4 — CAN A TOKEN BATCH BE MEASURED BEFORE IT IS SENT?");
  say(line("═"));
  say("");
  say("  This decides nothing. It runs the measurements and prints the numbers.");
  say("  ⛔ NO DISTRIBUTION IS EVER SENT. Every gas figure is eth_estimateGas,");
  say("     which simulates and moves nothing. The only transactions are approvals.");
  say("");

  const recordPath = path.join(__dirname, "..", "deployments", `${netName}.json`);
  if (!fs.existsSync(recordPath)) fail(`No deployment record at deployments/${netName}.json.`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const address = record.address;
  const deployBlock = Number(record.blockNumber);
  if (!Number.isFinite(deployBlock)) fail(`deployments/${netName}.json has no usable blockNumber.`);

  const [signer] = await ethers.getSigners();
  const dp = await ethers.getContractAt("DistributeProV3", address, signer);
  const iface = dp.interface;
  const NO_PARTNER = ethers.ZeroAddress;

  say(`  contract   ${address}`);
  say(`  network    ${netName} (chainId ${record.chainId})`);
  say(`  wallet     ${signer.address}`);
  say(`  armed      ${ARMED ? "YES — the spending steps will run" : "no — DRY RUN, read-only arms only"}`);
  say("");

  // ── [1] Contract. ──────────────────────────────────────────────────────
  say("  [1] confirming the contract on-chain ...");
  if ((await ethers.provider.getCode(address)) === "0x") fail(`No contract code at ${address}.`);
  if (await dp.paused()) fail("The contract is PAUSED. Nothing can be distributed or estimated.");
  const shareDenom = await readShareDenominator(address, dp, say, fail);
  const maxR = Number(await dp.maxRecipients());
  say(`        maxRecipients      ${maxR}  [read off the contract, never assumed]`);

  // ── [2] Block and ceiling. ─────────────────────────────────────────────
  say("  [2] reading the block gas limit ...");
  const head = await ethers.provider.getBlock("latest");
  const blockLimit = BigInt(head.gasLimit);
  const FRACTION = Number(process.env.FRACTION || DEFAULT_FRACTION);
  const ceiling = BigInt(Math.floor(Number(blockLimit) * FRACTION));
  say(`        block ${commas(head.number)}   gas limit ${commas(blockLimit.toString())}`);
  say(`        ceiling            ${commas(ceiling.toString())}  (${(FRACTION * 100).toFixed(0)}% of a block)`);

  // ── [3] Token. ─────────────────────────────────────────────────────────
  say("  [3] identifying the token ...");
  let tokenAddress;
  try { tokenAddress = ethers.getAddress((process.env.TOKEN || DEFAULT_TOKEN).trim()); }
  catch (_) { fail(`TOKEN is not a valid address: ${process.env.TOKEN}`); }
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    fail(`No contract code at ${tokenAddress} — that is not a token on this chain.`);
  }
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const [tName, tSym, tDecRaw] = await Promise.all([
    token.name().catch(() => "?"), token.symbol().catch(() => "?"), token.decimals(),
  ]);
  const tDec = Number(tDecRaw);
  const units = (v) => `${ethers.formatUnits(v, tDec)} ${tSym}`;
  say(`        ${tName} (${tSym})  ${tDec} decimals  at ${tokenAddress}`);
  const myBal = await token.balanceOf(signer.address);
  say(`        this wallet holds  ${units(myBal)}  (${commas(myBal.toString())} units)`);

  // ══════════════════════════════════════════════════════════════════════
  // [0] THE STANDING ALLOWANCE — explained before anything clears it.
  // ══════════════════════════════════════════════════════════════════════
  say("");
  say(line("═"));
  say("  [0] THE STANDING ALLOWANCE — where did it come from?");
  say(line("═"));
  const startAllow = await token.allowance(signer.address, address);
  say(`      standing right now: ${units(startAllow)}  (${commas(startAllow.toString())} units)`);

  if (startAllow > 0n) {
    say("");
    say("      ⛔ This project's rule is that NO standing allowance is left on a");
    say("         wallet. One is standing. Clearing it without explaining it would");
    say("         be working around it, so the token's own Approval log is read");
    say("         first — every approve this wallet ever made to this contract.");
    say("");
    const filter = {
      address: tokenAddress,
      topics: [
        ethers.id("Approval(address,address,uint256)"),
        ethers.zeroPadValue(signer.address, 32),
        ethers.zeroPadValue(address, 32),
      ],
    };
    const STEP = 50000;
    const evs = [];
    for (let from = deployBlock; from <= head.number; from += STEP) {
      const to = Math.min(from + STEP - 1, head.number);
      process.stdout.write(`\r      blocks ${commas(from)} → ${commas(to)} ...   `);
      try {
        const logs = await ethers.provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
        for (const l of logs) evs.push(l);
      } catch (e) {
        say(""); say(`      ⚠️ getLogs failed on ${from}–${to}: ${e.shortMessage || e.message}`);
        say("         The allowance stays UNEXPLAINED. Say so rather than guessing.");
        break;
      }
    }
    process.stdout.write("\r" + " ".repeat(70) + "\r");
    if (evs.length === 0) {
      say("      ⛔⛔ NO Approval event from this wallet to this contract since the");
      say("         deploy block. The standing allowance therefore predates this");
      say("         deployment or was set by a DIFFERENT wallet. UNEXPLAINED —");
      say("         record it that way; do not invent a source.");
    } else {
      say(`      ${evs.length} approve(s) from this wallet to this contract:`);
      for (const l of evs) {
        const v = BigInt(l.data);
        say(`        block ${rpad(commas(l.blockNumber), 12)}  set to ${rpad(units(v), 16)}  ${l.transactionHash}`);
      }
      const last = BigInt(evs[evs.length - 1].data);
      say("");
      if (last === startAllow) {
        say(`      ▶ The last approve set ${units(last)} and that is exactly what is`);
        say(`        standing — so NOTHING HAS BEEN SPENT AGAINST IT. It was set and`);
        say(`        never used. That is the explanation: an approval made for a run`);
        say(`        that did not happen, left behind.`);
      } else {
        say(`      ▶ The last approve set ${units(last)} and ${units(startAllow)} is`);
        say(`        standing, so ${units(last - startAllow)} was spent against it and`);
        say(`        the remainder was left. Partial consumption, not a stray approve.`);
      }
    }
  } else {
    say("      nothing standing — clean.");
  }

  // ── [4] The recipient list, decoded off the chain. ─────────────────────
  say("");
  say("  [4] asking the chain what this contract has actually paid ...");
  const STEP2 = 50000;
  const txHashes = new Set();
  for (let from = deployBlock; from <= head.number; from += STEP2) {
    const to = Math.min(from + STEP2 - 1, head.number);
    process.stdout.write(`\r        blocks ${commas(from)} → ${commas(to)} ...   `);
    let logs;
    try { logs = await ethers.provider.getLogs({ address, fromBlock: from, toBlock: to }); }
    catch (e) {
      say(""); fail(`getLogs failed on ${from}–${to}: ${e.shortMessage || e.message}\n` +
        `  ⛔ Not working around it — without the real list every figure below would\n` +
        `     be a statement about addresses nobody has ever paid.`);
    }
    for (const l of logs) txHashes.add(l.transactionHash);
  }
  process.stdout.write("\r" + " ".repeat(70) + "\r");
  say(`        ${txHashes.size} transactions touched this contract`);

  let best = null;
  for (const h of txHashes) {
    const tx = await ethers.provider.getTransaction(h);
    if (!tx || !tx.data) continue;
    let parsed;
    try { parsed = iface.parseTransaction({ data: tx.data, value: tx.value }); } catch (_) { continue; }
    if (!parsed || parsed.name !== "distributeToken") continue;
    const rec = parsed.args[1];
    if (!best || rec.length > best.addrs.length) {
      best = { hash: h, addrs: Array.from(rec), block: tx.blockNumber };
    }
  }
  if (!best) fail("No distributeToken transaction found on this contract.");
  const uniq = new Set(best.addrs.map((a) => a.toLowerCase()));
  say(`        biggest distributeToken: ${best.addrs.length} recipients (${uniq.size} distinct), block ${commas(best.block)}`);
  say(`        tx ${best.hash}`);

  say("  [5] reading the CURRENT balance of every address on that list ...");
  const realAddrs = best.addrs;
  const realBals = await balancesOf(token, realAddrs);
  const holders = [], fresh = [];
  for (let i = 0; i < realAddrs.length; i++) (realBals[i] > 0n ? holders : fresh).push(realAddrs[i]);
  say(`        holds some ${tSym}: ${holders.length}   holds ZERO: ${fresh.length}` +
      `   (${((fresh.length / realAddrs.length) * 100).toFixed(1)}% fresh)`);
  say(`        ⚠️ read at block ${commas(head.number)} — TODAY's composition. §22.7a measured`);
  say(`           45.9% fresh at the block that run was mined. Both true; those`);
  say(`           addresses have been paid since. Reported, not reconciled.`);

  const NEWCOUNT = Number(process.env.NEWCOUNT || DEFAULT_NEWCOUNT);
  say(`  [6] building ${NEWCOUNT} derived never-used addresses and PROVING they are empty ...`);
  const newAddrs = derivedNeverUsed(NEWCOUNT);
  const newBals = await balancesOf(token, newAddrs);
  const notEmpty = newBals.filter((b) => b > 0n).length;
  if (notEmpty > 0) {
    fail(`${notEmpty} derived addresses already hold ${tSym}. Stopping rather than\n` +
         `  reporting a new-wallet cost measured against wallets that are not new.`);
  }
  say(`        all ${NEWCOUNT} hold zero ${tSym} — verified, not assumed`);

  // ══════════════════════════════════════════════════════════════════════
  // THE PROBE FLOOR — the two numbers side by side, before any estimate.
  // ══════════════════════════════════════════════════════════════════════
  say("");
  say(line("═"));
  say("  THE PROBE FLOOR — what app.html demands vs what the reasons require");
  say(line("═"));
  const fullShares = apportion(new Array(Math.min(maxR, realAddrs.length)).fill(1n), shareDenom);
  const appFloor = probeFloorAppHtml(fullShares, shareDenom);
  const shareMin = probeMinForShares(fullShares, shareDenom);

  // Reason (b), measured not assumed: the smallest payout whose fee is non-zero,
  // found by asking quote() — a view call, free.
  let feeMin = null;
  for (let p = 1n; p <= 100000n; p = p * 2n) {
    const q = await dp.quote(p, NO_PARTNER);
    if (q[1] > 0n) {
      let lo = p / 2n, hi = p;
      while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        const qq = await dp.quote(mid, NO_PARTNER);
        if (qq[1] > 0n) hi = mid; else lo = mid;
      }
      feeMin = hi;
      break;
    }
  }
  const trueMin = feeMin !== null && feeMin > shareMin ? feeMin : shareMin;

  say(`      app.html's probePayoutFor (unconditional floor)  ${rpad(commas(appFloor.toString()), 12)} units = ${units(appFloor)}`);
  /* ⛔ THE COUNT IN THIS CAPTION IS THE LIST ACTUALLY MEASURED, NOT maxRecipients.
     The first run printed "250 lines" beside a figure computed on 159 — a true
     number with a wrong caption, which is the exact defect class this project
     keeps finding on the frontend. Fixed 2026-09-14 the moment it was read. */
  say(`      reason (a) every line gets >= 1 unit, ${fullShares.length} lines  ${rpad(commas(shareMin.toString()), 12)} units = ${units(shareMin)}`);
  say(`      reason (b) the fee stops rounding to zero        ` +
      (feeMin !== null ? `${rpad(commas(feeMin.toString()), 12)} units = ${units(feeMin)}   [MEASURED via quote()]`
                       : "not found below 100,000 units"));
  say(`      ▶ what the stated reasons actually require       ${rpad(commas(trueMin.toString()), 12)} units = ${units(trueMin)}`);
  say("");
  const ratio = Number(appFloor) / Number(trueMin);
  say(`      ⛔ THE FLOOR IS ${ratio >= 10 ? Math.round(ratio).toLocaleString("en-US") + "x" : ratio.toFixed(1) + "x"} LARGER THAN THE REASONS REQUIRE, on an even list.`);
  say(`      ⚠️ On a LUMPY list carrying a 0.0001% line the requirement genuinely`);
  say(`         reaches ${commas(shareDenom.toString())} units, so the floor is the WORST CASE applied`);
  say(`         unconditionally — not a mistake, but not a constant either.`);
  say(`      ⚠️ This wallet holds ${commas(myBal.toString())} units. It ${myBal >= appFloor ? "CAN" : "CANNOT"} cover app.html's floor` +
      ` and ${myBal >= trueMin ? "CAN" : "CANNOT"} cover the measured minimum.`);

  if (!ARMED) {
    say("");
    say(line("═"));
    say("  DRY RUN — stopping here.");
    say(line("═"));
    say("");
    say("  [A] and [B]–[F] need the allowance moved, which costs transactions.");
    say("  To run them:");
    say('    $env:CONFIRM="measure-token-chunking"; npx hardhat run scripts/measure_token_chunking.js --network btc20');
    say("");
    say("  That signs approvals only — NO distribution — and revokes to zero at the end.");
    say("");
    return;
  }

  let cleanupNeeded = true;
  try {
    // ══════════════════════════════════════════════════════════════════
    // [A] NO ALLOWANCE. Needs the standing one cleared — which is also the
    //     cleanup this wallet was owed.
    // ══════════════════════════════════════════════════════════════════
    say("");
    say(line("═"));
    say("  [A] WITH NO ALLOWANCE — re-running the claim app.html's T3 comment rests on");
    say(line("═"));
    if (startAllow !== 0n) {
      say(`      clearing the standing ${units(startAllow)} (this is the cleanup too) ...`);
      const tx0 = await token.approve(address, 0n, { type: 0 });
      const rc0 = await tx0.wait();
      say(`        cleared, gas ${commas(rc0.gasUsed.toString())}`);
    }
    const nowZero = await token.allowance(signer.address, address);
    if (nowZero !== 0n) fail(`Allowance read back as ${units(nowZero)}, not zero. Not measuring against an unknown state.`);
    say(`      allowance confirmed 0 off the chain`);

    const trio = realAddrs.slice(0, 3);
    const trioShares = apportion([1n, 1n, 1n], shareDenom);
    const rA = await tryEstimate(dp, iface, tokenAddress, trio, trioShares, trueMin, NO_PARTNER);
    if (rA.gas !== undefined) {
      say(`      ⛔⛔ IT RETURNED A NUMBER: ${commas(rA.gas.toString())} gas.`);
      say(`         THE RECORDED CLAIM IS FALSIFIED. Do not build on the comment.`);
    } else if (rA.fatal) {
      /* ⛔ CORRECTION, 2026-09-14: the first run reported this as "one of OUR OWN
         errors". IT IS NOT. 0x08c379a0 is the GENERIC Error(string) selector,
         which every Interface can parse — so `iface.parseError` succeeds on a
         revert string from the TOKEN, not from DistributePro. Decode and say
         which, rather than claiming provenance the selector does not carry. */
      let decoded = null;
      if (typeof rA.data === "string" && rA.data.startsWith("0x08c379a0")) {
        try { decoded = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + rA.data.slice(10))[0]; }
        catch (_) { /* leave null */ }
      }
      if (decoded !== null) {
        say(`      refused with a generic Error(string): "${decoded}"`);
        say(`      ⚠️ That is the TOKEN's revert string, NOT a DistributePro custom error.`);
        say(`         tryEstimate still classifies it FATAL — because Error(string) is in`);
        say(`         every ABI — so app.html's planner would STOP rather than halve. ✅`);
        say(`      ⛔ BUT THAT IS LUCK, NOT DESIGN: a token that reverts with a CUSTOM`);
        say(`         error or with empty data would be read as "too big" and halved away.`);
        say(`         ▶ T4 must check the allowance ITSELF and never rely on this.`);
      } else {
        say(`      refused with a decodable error (${String(rA.data).slice(0, 34)}…) — classified FATAL.`);
      }
      say(`      ✅ The recorded claim holds: no allowance, no estimate.`);
    } else {
      say(`      refused, undecodable — tryEstimate would read this as "TOO BIG".`);
      say(`      ✅ The recorded claim holds: no allowance, no estimate.`);
      say(`      ⛔ AND THE CLASSIFIER TRAP IS REAL: a missing allowance and a batch`);
      say(`         that is too big look IDENTICAL to the planner. T4 must check the`);
      say(`         allowance itself, never let this be halved away as a sizing problem.`);
      say(`      node said: ${String((rA.why && (rA.why.shortMessage || rA.why.message)) || "").slice(0, 150)}`);
    }

    // ── Set the working allowance, sized from the MEASURED minimum. ────
    say("");
    say("  [7] setting a working allowance, sized from the measured minimum ...");
    const qBig = await dp.quote(trueMin, NO_PARTNER);
    const allowTarget = qBig[4] * 8n; // headroom for [E]'s reduce-not-clear case
    if (allowTarget > myBal) {
      fail(`Needs ${units(allowTarget)} of real balance (estimateGas simulates the\n` +
           `  transferFrom, so the balance must be there) and this wallet holds\n` +
           `  ${units(myBal)}. Top it up or lower NEWCOUNT.`);
    }
    const txA = await token.approve(address, allowTarget, { type: 0 });
    const rcA = await txA.wait();
    const liveAllow = await token.allowance(signer.address, address);
    say(`        allowance now ${units(liveAllow)}  (gas ${commas(rcA.gasUsed.toString())})`);
    if (liveAllow !== allowTarget) fail(`Read back ${units(liveAllow)}, expected ${units(allowTarget)}.`);

    // ══════════════════════════════════════════════════════════════════
    // [F] WHERE THE FLOOR ACTUALLY IS — walk the payout DOWN.
    // ══════════════════════════════════════════════════════════════════
    say("");
    say(line("═"));
    say("  [F] THE FLOOR, MEASURED — walk the payout down and watch for the cliff");
    say(line("═"));
    say("      §22.7b measured an 8,414-gas drop when the fee rounds to zero, in the");
    say("      UNSAFE direction. This finds where that happens on THIS token, so T4");
    say("      sizes its probe on a measurement instead of a constant.");
    say("");
    const fN = Math.min(20, realAddrs.length);
    const fAddrs = realAddrs.slice(0, fN);
    const fShares = apportion(new Array(fN).fill(1n), shareDenom);
    const rungs = [];
    for (let p = trueMin * 64n; p >= 1n; p = p / 4n) rungs.push(p);
    let prev = null;
    for (const p of rungs) {
      if (p > liveAllow) continue;
      const q = await dp.quote(p, NO_PARTNER);
      const r = await tryEstimate(dp, iface, tokenAddress, fAddrs, fShares, p, NO_PARTNER);
      const g = r.gas !== undefined ? r.gas : null;
      const delta = (g !== null && prev !== null) ? (prev - g) : null;
      say(`      payout ${rpad(commas(p.toString()), 12)} units   fee ${rpad(commas(q[1].toString()), 10)}   ` +
          `gas ${rpad(g !== null ? commas(g.toString()) : "REFUSED", 12)}` +
          (delta !== null && delta !== 0n ? `   Δ ${commas(delta.toString())}` : ""));
      if (g !== null) prev = g;
    }
    say("");
    say(`      ▶ A drop near ${commas(RECORDED_FEE_CLIFF.toString())} is the fee leg not being paid — that is the`);
    say(`        rung BELOW which a probe understates the real cost. The lowest rung`);
    say(`        ABOVE it is where T4's probe floor belongs on this token.`);

    // ══════════════════════════════════════════════════════════════════
    // [B] PROBE vs REAL.
    // ══════════════════════════════════════════════════════════════════
    say("");
    say(line("═"));
    say("  [B] PROBE PAYOUT vs REAL PAYOUT — does the probe trick work on tokens?");
    say(line("═"));
    const realPayout = ethers.parseUnits(process.env.PAYOUT || DEFAULT_PAYOUT, tDec);
    const bN = Math.min(50, realAddrs.length);
    const bAddrs = realAddrs.slice(0, bN);
    const bShares = apportion(new Array(bN).fill(1n), shareDenom);
    const bProbe = probeMinForShares(bShares, shareDenom) > trueMin
      ? probeMinForShares(bShares, shareDenom) : trueMin;

    const rProbe = await tryEstimate(dp, iface, tokenAddress, bAddrs, bShares, bProbe, NO_PARTNER);
    const qReal = await dp.quote(realPayout, NO_PARTNER);
    const rReal = qReal[4] <= liveAllow && qReal[4] <= myBal
      ? await tryEstimate(dp, iface, tokenAddress, bAddrs, bShares, realPayout, NO_PARTNER)
      : { skipped: true };

    say(`      list           ${bN} real recipients`);
    say(`      probe payout   ${units(bProbe)}  →  ` +
        (rProbe.gas !== undefined ? `${commas(rProbe.gas.toString())} gas` : "REFUSED"));
    if (rReal.skipped) {
      say(`      real payout    ${units(realPayout)}  →  SKIPPED (needs ${units(qReal[4])}, allowance ${units(liveAllow)})`);
    } else {
      say(`      real payout    ${units(realPayout)}  →  ` +
          (rReal.gas !== undefined ? `${commas(rReal.gas.toString())} gas` : "REFUSED"));
    }
    if (rProbe.gas !== undefined && rReal.gas !== undefined) {
      const d = rProbe.gas > rReal.gas ? rProbe.gas - rReal.gas : rReal.gas - rProbe.gas;
      const pct = Number(d * 1000000n / rReal.gas) / 10000;
      say(`      difference     ${commas(d.toString())} gas  (${pct.toFixed(3)}%)`);
      say(`      ▶ The native equivalent (§19.2) was 0.065%. ⚠️ Part of any gap is`);
      say(`        EIP-2028 calldata on the payout word, 12 gas per non-zero byte`);
      say(`        (§22.7b) — do not read the whole gap as probe inaccuracy.`);
    }

    // ══════════════════════════════════════════════════════════════════
    // [C] COMPOSITION.
    // ══════════════════════════════════════════════════════════════════
    say("");
    say(line("═"));
    say("  [C] COMPOSITION — the marginal for an EXISTING vs a BRAND-NEW holder");
    say(line("═"));
    say("      Two points per population, so the marginal is a slope, not one sample.");
    say("");
    async function slope(label, pool, n1, n2) {
      const out = { label, a: null, b: null, marginal: null, fixed: null };
      for (const [k, n] of [["a", n1], ["b", n2]]) {
        if (pool.length < n) { say(`      ${pad(label, 22)} needs ${n}, pool has ${pool.length} — skipped`); return out; }
        const sh = apportion(new Array(n).fill(1n), shareDenom);
        const p = probeMinForShares(sh, shareDenom) > trueMin ? probeMinForShares(sh, shareDenom) : trueMin;
        const r = await tryEstimate(dp, iface, tokenAddress, pool.slice(0, n), sh, p, NO_PARTNER);
        if (r.gas === undefined) { say(`      ${pad(label, 22)} ${rpad(n, 4)} recipients → REFUSED`); return out; }
        out[k] = { n, gas: r.gas };
        say(`      ${pad(label, 22)} ${rpad(n, 4)} recipients → ${rpad(commas(r.gas.toString()), 12)} gas`);
      }
      if (out.a && out.b && out.b.n !== out.a.n) {
        out.marginal = (out.b.gas - out.a.gas) / BigInt(out.b.n - out.a.n);
        out.fixed = out.a.gas - out.marginal * BigInt(out.a.n);
      }
      return out;
    }
    const sHold = holders.length >= 60 ? await slope("existing holders", holders, 10, 60) : null;
    if (!sHold) say(`      existing holders       only ${holders.length} available — skipped`);
    const sNew = await slope("never-used (derived)", newAddrs, 10, 60);
    const mixedPool = [];
    for (let i = 0; i < Math.max(holders.length, fresh.length); i++) {
      if (holders[i]) mixedPool.push(holders[i]);
      if (fresh[i]) mixedPool.push(fresh[i]);
    }
    const sMix = mixedPool.length >= 60 ? await slope("the real list (mixed)", mixedPool, 10, 60) : null;

    say("");
    for (const s of [sHold, sNew, sMix]) {
      if (s && s.marginal !== null) {
        say(`      ${pad(s.label, 22)} marginal ${rpad(commas(s.marginal.toString()), 10)} / recipient   fixed ${commas(s.fixed.toString())}`);
      }
    }
    say("");
    say(`      ▶ AGAINST WHAT IS ALREADY RECORDED (§22.7a):`);
    say(`          blended, 46%-new, two-point        ${commas(RECORDED_TOKEN_MARGINAL_BLENDED.toString())}`);
    say(`          existing holder, DERIVED not run   ${commas(RECORDED_TOKEN_MARGINAL_DERIVED.toString())}  ← this run replaces it`);
    say(`          brand new, GasBench on hardhat     ${commas(RECORDED_NEW_MARGINAL_BENCH.toString())}`);
    say(`          native, existing accounts          ${commas(RECORDED_NATIVE_MARGINAL.toString())}`);
    say(`      ⛔ A disagreement IS the finding. Write it down; do not explain it in`);
    say(`         the same breath.`);

    // ══════════════════════════════════════════════════════════════════
    // [D] THE CEILING.
    // ══════════════════════════════════════════════════════════════════
    say("");
    say(line("═"));
    say(`  [D] THE CEILING — halve-then-climb against ${(FRACTION * 100).toFixed(0)}% of a block`);
    say(line("═"));
    say(`      §22.7a predicts ~199 for the mixed population by extrapolation.`);
    say("");
    async function ceilingFor(label, pool) {
      if (pool.length < 10) { say(`      ${pad(label, 22)} pool too small — skipped`); return; }
      const start = Math.min(maxR, pool.length);
      let lastGas = null;
      const fits = async (n) => {
        const sh = apportion(new Array(n).fill(1n), shareDenom);
        const p = probeMinForShares(sh, shareDenom) > trueMin ? probeMinForShares(sh, shareDenom) : trueMin;
        const r = await tryEstimate(dp, iface, tokenAddress, pool.slice(0, n), sh, p, NO_PARTNER);
        process.stdout.write(`\r      ${pad(label, 22)} trying ${rpad(n, 4)} ... ` +
          (r.gas !== undefined ? rpad(commas(r.gas.toString()), 12) : "   refused  "));
        if (r.fatal) throw r.fatal;
        if (r.gas !== undefined && r.gas <= ceiling) { lastGas = r.gas; return true; }
        return false;
      };
      const found = await searchBatchSize(start, fits, 60);
      process.stdout.write("\r" + " ".repeat(78) + "\r");
      const binds = found.size >= Math.min(maxR, pool.length) ? "the COUNT cap / pool size" : "GAS";
      say(`      ${pad(label, 22)} fits ${rpad(found.size, 4)} recipients` +
          (lastGas !== null ? `  at ${rpad(commas(lastGas.toString()), 12)} gas` : "") +
          `   (${found.calls} estimates, binds on ${binds})`);
    }
    if (holders.length >= 10) await ceilingFor("existing holders", holders);
    await ceilingFor("never-used (derived)", newAddrs);
    if (mixedPool.length >= 10) await ceilingFor("the real list (mixed)", mixedPool);
    say("");
    say(`      ⚠️ maxRecipients is ${maxR}. Where a population fits FEWER, GAS is the`);
    say(`         real ceiling and the count cap is only a backstop — §22.7a's T4`);
    say(`         consequence, measured rather than derived.`);

    // ══════════════════════════════════════════════════════════════════
    // [E] ALLOWANCE SIZE.
    // ══════════════════════════════════════════════════════════════════
    say("");
    say(line("═"));
    say("  [E] ALLOWANCE SIZE — can the estimator tell a final batch from a non-final one?");
    say(line("═"));
    say("      §19.7: only the LAST batch clears the allowance, earning a 15,000");
    say("      refund, and the estimator returned the same number either way. If that");
    say("      holds, every batch is sized as if non-final — the SAFE direction.");
    say("");
    const eN = Math.min(20, realAddrs.length);
    const eAddrs = realAddrs.slice(0, eN);
    const eShares = apportion(new Array(eN).fill(1n), shareDenom);
    const eProbe = probeMinForShares(eShares, shareDenom) > trueMin ? probeMinForShares(eShares, shareDenom) : trueMin;
    const qE = await dp.quote(eProbe, NO_PARTNER);
    const rOver = await tryEstimate(dp, iface, tokenAddress, eAddrs, eShares, eProbe, NO_PARTNER);
    say(`      allowance ${units(liveAllow)} — will be REDUCED (every non-final batch)`);
    say(`        → ${rOver.gas !== undefined ? commas(rOver.gas.toString()) + " gas" : "REFUSED"}`);

    say(`      setting it to EXACTLY ${units(qE[4])} — will be CLEARED (the final batch) ...`);
    const t0 = await token.approve(address, 0n, { type: 0 }); await t0.wait();
    const t1 = await token.approve(address, qE[4], { type: 0 }); await t1.wait();
    const rExact = await tryEstimate(dp, iface, tokenAddress, eAddrs, eShares, eProbe, NO_PARTNER);
    say(`        → ${rExact.gas !== undefined ? commas(rExact.gas.toString()) + " gas" : "REFUSED"}`);
    if (rOver.gas !== undefined && rExact.gas !== undefined) {
      const d = rOver.gas > rExact.gas ? rOver.gas - rExact.gas : rExact.gas - rOver.gas;
      say("");
      say(`      difference ${commas(d.toString())} gas`);
      say(`      ▶ 0 reproduces §19.7 — the estimator is blind to the refund, so a plan`);
      say(`        sized on estimates is conservative on the final batch and correct on`);
      say(`        every other one. Near 15,000 means it DOES see it, and T4 must size`);
      say(`        the final batch separately.`);
    }
  } finally {
    if (cleanupNeeded) {
      say("");
      say("  [8] revoking the allowance and reading it back ...");
      try {
        const txR = await token.approve(address, 0n, { type: 0 });
        await txR.wait();
        const after = await token.allowance(signer.address, address);
        if (after === 0n) {
          say(`        allowance is ${units(after)} — verified off the chain. Nothing left standing,`);
          say(`        which also closes the 1.02 ${tSym} that was standing before this run.`);
        } else {
          say(`        ⛔⛔ STILL ${units(after)}. Clear it in your wallet before anything else.`);
        }
      } catch (e) {
        say(`        ⛔⛔ COULD NOT REVOKE: ${e.shortMessage || e.message}`);
        say(`           A standing allowance is left on this wallet. Clear it manually.`);
      }
    }
  }

  say("");
  say(line("═"));
  say("  DONE. No distribution sent.");
  say(line("═"));
  say("");
  say("  ▶ Paste the whole output back. T4 is designed FROM these numbers.");
  say("");
}

main().catch((e) => {
  console.error("");
  console.error("⛔ UNHANDLED — nothing below this point ran:");
  console.error(e);
  console.error("");
  console.error("⚠️ IF THIS DIED AFTER AN APPROVE, AN ALLOWANCE MAY STILL BE STANDING.");
  console.error("   Re-run (it clears any leftover) or clear it in your wallet.");
  process.exit(1);
});
