// scripts/testrun_token_v3.js
//
// THE FIRST REAL ERC-20 DISTRIBUTION THROUGH DistributeProV3 ON BTC20.
// Written 2026-09-12 for the owner and a future session of Claude.
//
// RUN (dry run, spends nothing):
//   $env:TOKEN="0x..."; npx hardhat run scripts/testrun_token_v3.js --network btc20
// RUN (the approve, spends gas only):
//   $env:APPROVE="approve-token"; npx hardhat run scripts/testrun_token_v3.js --network btc20
// RUN (the distribution, for real):
//   $env:CONFIRM="testrun-token"; npx hardhat run scripts/testrun_token_v3.js --network btc20
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, AND WHY IT COMES BEFORE ANY UI
//
// `distributeToken` is real code in the deployed bytecode that HAS NEVER RUN
// ON THIS CHAIN. Not once. The native path earned its trust the same way and
// in the same order: a script proved the CONTRACT on BTC20 (brief §19.1–19.4)
// and only then was the frontend built on top of it. Building a token UI
// first would mean debugging the page and the chain at the same time, with
// somebody's money in the middle.
//
// ⛔ THE TOKEN PATH IS NOT THE NATIVE PATH WITH A DIFFERENT NOUN. It differs
// in four ways that have each broken a real product somewhere:
//
//   1. TWO TRANSACTIONS, NOT ONE. `distributeToken` is not payable — it PULLS
//      with `safeTransferFrom`, so the sender must `approve` FIRST. A UI that
//      does not say this before starting leaves people staring at a wallet
//      prompt they did not expect.
//   2. THE APPROVE MUST COVER payout PLUS FEE. The contract pulls `required`,
//      not `payout`. Approving the payout alone reverts at the pull — after
//      the user has already paid gas for the approve.
//   3. DECIMALS ARE NOT 18. Measured on BTC20 2026-09-12: USDT here is 6 dp,
//      and WBTC here is 18 dp where it is 8 on Ethereum. ⛔ Nothing in this
//      script or the page may assume 18 — every human figure is formatted
//      with the token's own decimals, read off the chain.
//   4. NOT EVERY "TOKEN" IS AN ERC-20. The explorer's token list includes
//      NFTMiner contracts whose `decimals()` REVERTS. A pasted address that
//      is not an ERC-20 must produce a named answer, not a stack trace.
//
// ⚠️ A note on the approve, because it is the part that can be got wrong
// quietly: this script approves EXACTLY `required` and never an unlimited
// allowance. An unlimited approval to a contract is a standing permission to
// drain that token from the wallet for as long as it exists. DistributePro
// does not need one and will not ask for one.
//
// Env vars:
//   TOKEN=0x...          REQUIRED. The ERC-20 to distribute.
//   PAYOUT=0.1           human units of THAT TOKEN (not wei, not ether)
//   RECIPIENTS=0xa,0xb   comma-separated; SHARES must match in count
//   SHARES=333300,333300,333400   share units, must total exactly 1000000
//   APPROVE=approve-token   send the approve transaction, then stop
//   CONFIRM=testrun-token   send the distribution

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const {
  readShareDenominator,
  checkShareTotal,
} = require("./utils/share_denominator");
const { reportEnv, armed } = require("./utils/session_env");
const { ethers } = hre;

const DEFAULT_PAYOUT = "0.1";
// ⛔ V3.1 SHARE UNITS, not basis points. 333300 = 33.3300%.
// The denominator itself is NEVER written down here — it is read off
// the contract at run time (scripts/utils/share_denominator.js).
const DEFAULT_SHARES = [333300, 333300, 333400];

// Minimal ERC-20 surface. Deliberately NOT OpenZeppelin's IERC20 artifact:
// this chain's USDT is of the vintage that may not return a bool from
// transfer/approve, and a strict ABI would fail decoding a perfectly good
// token. Read calls are typed; write calls are left to return nothing.
const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256)",
];

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
  reportEnv(["CONFIRM", "APPROVE", "TOKEN", "PAYOUT", "RECIPIENTS", "SHARES"]);

  const netName = hre.network.name;

  say("");
  say(line("═"));
  say("  DistributeProV3 — FIRST REAL ERC-20 DISTRIBUTION");
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
  say("");

  const [signer] = await ethers.getSigners();
  const dp = await ethers.getContractAt("DistributeProV3", address, signer);

  // ── [1/8] The contract, confirmed against the record before anything. ───
  say("  [1/8] confirming the contract on-chain matches the record ...");
  if ((await ethers.provider.getCode(address)) === "0x") {
    fail(`No contract code at ${address} on ${netName}.`);
  }
  const onChainHouse = await dp.houseRecipient();
  if (await dp.paused()) fail("The contract is PAUSED. Unpause before distributing.");
  say(`        house    ${onChainHouse}`);
  say(`        paused   false`);

  // ── [2/8] The token — identified off the chain, never assumed. ──────────
  say("  [2/8] identifying the token ...");
  if (!process.env.TOKEN) {
    fail('TOKEN is required. Set it to the ERC-20 address, e.g. $env:TOKEN="0xab47...".');
  }
  let tokenAddress;
  try {
    tokenAddress = ethers.getAddress(process.env.TOKEN.trim());
  } catch (_) {
    fail(`TOKEN "${process.env.TOKEN}" is not a valid address.`);
  }
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    fail(`There is no contract at ${tokenAddress} on ${netName}. Check the address.`);
  }

  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

  // ⛔ decimals() is the probe that tells an ERC-20 from something merely
  // LISTED as a token. Measured on BTC20: the ZEON NFTMiner contracts appear
  // on the explorer's token list and revert here.
  let decimals, symbol, tokenName;
  try {
    decimals = Number(await token.decimals());
  } catch (_) {
    fail(
      `${tokenAddress} does not answer decimals(). It is a contract, but not an ` +
        `ERC-20 this can distribute (the explorer lists NFT-style contracts too).`
    );
  }
  try {
    symbol = await token.symbol();
  } catch (_) {
    symbol = "???";
  }
  try {
    tokenName = await token.name();
  } catch (_) {
    tokenName = "(no name)";
  }
  const fmt = (v) => ethers.formatUnits(v, decimals);

  say(`        token      ${tokenName} (${symbol})`);
  say(`        address    ${tokenAddress}`);
  say(`        decimals   ${decimals}` + (decimals === 18 ? "" : "   ⚑ NOT 18 — every figure below uses this"));

  // ── [3/8] Build the batch. ─────────────────────────────────────────────
  say("  [3/8] building the batch ...");
  const payout = ethers.parseUnits(process.env.PAYOUT || DEFAULT_PAYOUT, decimals);
  if (payout === 0n) fail("PAYOUT is zero — the contract rejects that.");

  let recipients = [];
  let shares = [];
  if (process.env.RECIPIENTS) {
    // Same validation rule as testrun_v3.js: a bad paste is EXPECTED input
    // here, so name the bad entry rather than throwing a stack trace.
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
      problems.push(
        `RECIPIENTS has ${rawR.length} entries but SHARES has ${rawS.length} — they must match one for one`
      );
    }
    if (problems.length) {
      say("");
      say("  ⛔ RECIPIENTS / SHARES could not be read. Nothing was sent.");
      say("");
      for (const p of problems) say(`     • ${p}`);
      say("");
      fail(`${problems.length} problem(s) in RECIPIENTS/SHARES — fix them and run again.`);
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
  say(`        payout     ${fmt(payout)} ${symbol}   (${payout} raw units)`);
  say(`        recipients ${recipients.length}`);
  say(`        shares     ${shares.join(" / ")}  (= ${(Number(shareTotal) * 100 / Number(shareDenom)).toFixed(4)}%)`);

  // ── [4/8] The contract's own quote. Not our arithmetic. ────────────────
  say("  [4/8] asking the contract for its quote ...");
  const partner = ethers.ZeroAddress;
  const [totalBps, totalFee, houseFee, partnerFee, required] = await dp.quote(payout, partner);
  say(`        fee rate     ${Number(totalBps) / 100}%`);
  say(`        total fee    ${fmt(totalFee)} ${symbol}`);
  say(`        YOU APPROVE  ${fmt(required)} ${symbol}  ⛔ payout PLUS fee — not the payout`);

  // ── [5/8] Per-recipient amounts, from the chain. ───────────────────────
  say("  [5/8] previewing the per-recipient amounts ...");
  const amounts = await dp.previewAmounts(payout, shares);
  let sum = 0n;
  for (let i = 0; i < amounts.length; i++) {
    say(
      `        ${pad(`[${i}] ${recipients[i].slice(0, 10)}…`, 22)}${pad(fmt(amounts[i]), 22)}` +
        (i === amounts.length - 1 ? "← carries the dust" : "")
    );
    sum += amounts[i];
  }
  say(`        ${pad("sum", 22)}${pad(fmt(sum), 22)}` + (sum === payout ? "✓ equals the payout exactly" : "⛔ DOES NOT MATCH"));
  if (sum !== payout) fail("previewAmounts does not sum to the payout. Do not proceed.");

  // ── [6/8] Balances and allowance, BEFORE. ──────────────────────────────
  const parties = [...new Set([...recipients, onChainHouse, signer.address])];
  const before = {};
  for (const a of parties) before[a] = await token.balanceOf(a);
  const contractBefore = await token.balanceOf(address);
  const allowance = await token.allowance(signer.address, address);

  say("  [6/8] balances BEFORE — a recipient at zero makes its delta unarguable:");
  say(`     ${pad("address", 46)}${pad(`${symbol} before`, 22)}role`);
  say("     " + "-".repeat(92));
  for (const a of parties) {
    const roles = [];
    if (a === signer.address) roles.push("SENDER");
    if (a === onChainHouse) roles.push("house");
    const n = recipients.filter((r) => r === a).length;
    if (n) roles.push(n > 1 ? `recipient ×${n}` : "recipient");
    say(
      `     ${pad(a, 46)}${pad(fmt(before[a]), 22)}${roles.join(", ")}` +
        (before[a] === 0n ? "  ⚑ holds none of this token yet" : "")
    );
  }
  say("");
  say(`        contract ${symbol} balance before: ${fmt(contractBefore)}` +
      (contractBefore === 0n ? "  ✓ holds nothing" : "  ⚠️ NOT ZERO"));
  say(`        sender ${symbol} balance:          ${fmt(before[signer.address])}`);
  say(`        allowance to DistributePro:     ${fmt(allowance)}` +
      (allowance >= required ? "  ✓ enough" : "  ⛔ NOT ENOUGH — approve first"));

  if (before[signer.address] < required) {
    fail(
      `The sending wallet holds ${fmt(before[signer.address])} ${symbol} but the run needs ` +
        `${fmt(required)}. Lower PAYOUT or fund the wallet.`
    );
  }

  // ── PREDICT the gas, but only once it CAN be predicted. ────────────────
  // Added 2026-09-12, after the first token run went out without an estimate.
  // It deliberately sits AFTER the allowance check rather than beside the
  // native script's estimate: `distributeToken` pulls with transferFrom, so
  // estimating it before the approve exists does not return a number — it
  // reverts. An estimate that can only fail is not an instrument. So it runs
  // when there is an allowance to estimate against, which means the dry run
  // you do AFTER approving shows it, and the send path prints it too.
  if (allowance >= required) {
    try {
      const est = await dp.distributeToken.estimateGas(
        tokenAddress, recipients, shares, payout, partner
      );
      say(`        gas estimate:                   ${est}  ← predicted BEFORE sending`);
      say(`        (measured 2026-09-12: 160,684 actual for 3 recipients new to the token)`);
    } catch (e) {
      const m = (e.shortMessage || e.message || String(e)).replace(/\s+/g, " ").slice(0, 90);
      say(`        gas estimate:                   unavailable — ${m}`);
    }
  }

  // ── [7/8] The approve, as its own deliberate step. ─────────────────────
  say("  [7/8] checking the allowance ...");
  if (armed("APPROVE", "approve-token")) {
    if (allowance >= required) {
      say(`        Allowance is already ${fmt(allowance)} — nothing to approve. Skipping.`);
    } else {
      // ⛔ THE NON-ZERO ALLOWANCE TRAP. Tokens of USDT's vintage refuse to
      // move an allowance directly from one non-zero value to another (it is
      // the classic front-running guard). Going through zero works on BOTH
      // kinds, so it is done unconditionally rather than after a failure.
      if (allowance > 0n) {
        say(`        allowance is ${fmt(allowance)}, not zero — setting it to 0 first`);
        say(`        (tokens of this vintage often refuse non-zero → non-zero)`);
        const tx0 = await token.approve(address, 0n);
        say(`        tx: ${tx0.hash}  waiting ...`);
        await tx0.wait();
      }
      say(`        approving EXACTLY ${fmt(required)} ${symbol} — never unlimited`);
      const txA = await token.approve(address, required);
      say(`        tx: ${txA.hash}  waiting ...`);
      const rA = await txA.wait();
      const now = await token.allowance(signer.address, address);
      say(`        gas used: ${rA.gasUsed}`);
      say(`        allowance READ BACK OFF THE CHAIN: ${fmt(now)}` +
          (now >= required ? "  ✓" : "  ⛔ DID NOT TAKE"));
      if (now < required) {
        fail("The approve transaction succeeded but the allowance did not change. Investigate before sending.");
      }
    }
    say("");
    say(line());
    say("  ✅ APPROVE DONE. Nothing has been distributed yet.");
    say("");
    say("  Now run the distribution:");
    say("");
    say(`     $env:CONFIRM="testrun-token"; npx hardhat run scripts/testrun_token_v3.js --network ${netName}`);
    say(line());
    say("");
    process.exit(0);
  }

  // ── [8/8] Gate. ────────────────────────────────────────────────────────
  say("  [8/8] checking confirmation ...");
  if (!armed("CONFIRM", "testrun-token")) {
    say("");
    say(line());
    say("  DRY RUN — nothing was sent.");
    say("");
    if (allowance < required) {
      say(`  ⛔ NEXT STEP IS THE APPROVE. The contract pulls ${fmt(required)} ${symbol}`);
      say(`  (payout plus fee) and can only do that once you allow it:`);
      say("");
      say(`     $env:APPROVE="approve-token"; npx hardhat run scripts/testrun_token_v3.js --network ${netName}`);
    } else {
      say(`  Allowance is already sufficient. To distribute for real:`);
      say("");
      say(`     $env:CONFIRM="testrun-token"; npx hardhat run scripts/testrun_token_v3.js --network ${netName}`);
    }
    const leaving = amounts
      .filter((_, i) => recipients[i] !== signer.address)
      .reduce((a, b) => a + b, 0n);
    say("");
    if (leaving === 0n) {
      say(`  True cost: gas only — every recipient is this wallet, so the tokens return.`);
    } else {
      say(`  True cost: gas, plus ${fmt(leaving)} ${symbol} that genuinely LEAVES this wallet.`);
    }
    say(line());
    say("");
    process.exit(0);
  }

  if (allowance < required) {
    fail(
      `Allowance is ${fmt(allowance)} ${symbol} but the contract must pull ${fmt(required)}. ` +
        `Run the APPROVE step first — the distribution would revert at the pull, after you had paid gas.`
    );
  }

  // ── Go. ────────────────────────────────────────────────────────────────
  say("");
  say("  sending the distribution ... (do not close the window)");
  const tx = await dp.distributeToken(tokenAddress, recipients, shares, payout, partner);
  say(`        tx sent:  ${tx.hash}`);
  say(`        type:     ${tx.type === 0 ? "0 (legacy) ✓" : tx.type}`);
  say(`        waiting for the receipt ...`);
  const receipt = await tx.wait();

  // ⛔ Same pre-London quirk as the native path — see brief §19.3.
  const gasPrice = receipt.gasPrice && receipt.gasPrice > 0n ? receipt.gasPrice : tx.gasPrice;
  const gasSource =
    receipt.gasPrice && receipt.gasPrice > 0n
      ? "receipt.effectiveGasPrice"
      : "tx.gasPrice (receipt had none — pre-London node)";

  say("");
  say(line("═"));
  say("  ✅ TOKEN DISTRIBUTION CONFIRMED");
  say(line("═"));
  say(`  tx           ${receipt.hash}`);
  say(`  block        ${receipt.blockNumber}`);
  say(`  gas used     ${receipt.gasUsed}  (${receipt.gasUsed / BigInt(recipients.length)} per recipient)`);
  say(`  gas price    ${ethers.formatUnits(gasPrice, "gwei")} gwei  [from ${gasSource}]`);
  say(`  gas cost     ${ethers.formatEther(receipt.gasUsed * gasPrice)} (native BTCC, not ${symbol})`);
  say("");

  // ── Hold-nothing, in TOKEN units this time. ────────────────────────────
  const contractAfter = await token.balanceOf(address);
  say("  ⛔ the hold-nothing rule, measured in token units:");
  say(`     contract ${symbol} balance after: ${fmt(contractAfter)}` +
      (contractAfter === 0n ? "  ✓ ZERO — nothing was kept" : "  ⛔ NOT ZERO — INVESTIGATE"));
  say("");

  // ── Did everyone get paid? ─────────────────────────────────────────────
  const expected = {};
  const bump = (a, v) => (expected[a] = (expected[a] || 0n) + v);
  for (let i = 0; i < recipients.length; i++) bump(recipients[i], amounts[i]);
  bump(onChainHouse, houseFee);
  if (partnerFee > 0n) bump(partner, partnerFee);
  bump(signer.address, -required);

  say(`  ${symbol} balance changes, expected vs actual:`);
  say(`     ${pad("address", 46)}${pad("expected", 22)}actual`);
  say("     " + "-".repeat(92));
  let allMatch = true;
  for (const a of parties) {
    const actual = (await token.balanceOf(a)) - before[a];
    const exp = expected[a] || 0n;
    const ok = actual === exp;
    if (!ok) allMatch = false;
    say(`     ${pad(a, 46)}${pad(fmt(exp), 22)}${pad(fmt(actual), 22)}${ok ? "✓" : "⛔ MISMATCH"}`);
  }
  say("");

  const allowanceAfter = await token.allowance(signer.address, address);
  say(`  allowance left over: ${fmt(allowanceAfter)} ${symbol}` +
      (allowanceAfter === 0n
        ? "  ✓ fully consumed — no standing permission left behind"
        : "  ⚠️ a standing allowance remains; revoke it if this was a one-off"));
  say("");

  if (!allMatch) {
    say("  ⛔ At least one balance did not move as predicted. Do NOT build the token UI");
    say("     on top of this. Investigate first.");
    say("");
    process.exit(1);
  }

  say(line("═"));
  say(`  ▶ V3 HAS NOW MOVED A REAL ERC-20 ON BTC20, AND THE BOOKS BALANCE.`);
  say(line("═"));
  say("");
  say(`  Explorer: https://scan.bitcoincode.technology/tx/${receipt.hash}`);
  say("");
}

main().catch((e) => {
  console.error("");
  console.error("⛔ TOKEN TEST RUN FAILED");
  console.error(e);
  process.exit(1);
});
