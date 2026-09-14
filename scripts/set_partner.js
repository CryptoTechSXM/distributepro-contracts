// scripts/set_partner.js
//
// REGISTER A PARTNER, OR CHANGE THEIR RATE, ON DistributeProV3.
// Written 2026-09-12 for the owner and a future session of Claude.
//
// RUN (dry run, spends nothing):
//   $env:PARTNER="0x..."; $env:BPS="400"; npx hardhat run scripts/set_partner.js --network btc20
// RUN (for real):
//   $env:PARTNER="0x..."; $env:BPS="400"; $env:CONFIRM="set-partner"; npx hardhat run scripts/set_partner.js --network btc20
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
//
// MEASURED 2026-09-12: an eth_getLogs scan for PartnerSet across the whole
// life of the current contract (blocks 30,478,686 → 30,489,467) returned
// ZERO events. The partner registry has never had an entry, so the partner
// leg of the fee — a real branch of FeeSchedule that ships in the deployed
// bytecode — has never executed on this chain. `quote()` with a partner
// REVERTS with UnknownPartner until something is registered here.
//
// ⛔ WHO MAY CALL THIS. setPartner is onlyOwner. The signer must be the
// contract's owner or the transaction reverts; this script checks that up
// front and refuses rather than letting the node reject it.
//
// ⛔ WHAT THE RATE ACTUALLY MEANS — and it is not a slider on the partner's
// earnings. FeeSchedule's closed form is:
//
//     houseBps   = max(200, ceil(totalBps / 2))
//     partnerBps = totalBps - houseBps
//
// so Crypto Counsel's 2% floor is taken FIRST and the partner gets what is
// left, until 4%; above that the two split evenly and the house share climbs
// too. The three rates this script was written to exercise:
//
//     total   house   partner   what it exercises
//     3.0%    2.00%   1.00%     the house FLOOR binds; partner takes the rest
//     4.0%    2.00%   2.00%     the even-split point
//     5.0%    2.50%   2.50%     the ceiling; house climbs off the floor
//
// ⚠️ AND THE THING THAT IS EASY TO GET WRONG: a partner who SENDS THEIR OWN
// distribution earns nothing from being registered. They pay the total fee
// and receive only the partner share back, so at 3% and 4% they net exactly
// the 2% floor, and at 5% they are 0.5% WORSE OFF than not being registered
// at all. A partner only earns when SOMEBODY ELSE is the sender and the
// partner's address travels with that transaction. Keep that in mind when
// reading any test done with a single wallet.
//
// Env vars:
//   PARTNER=0x...   the address to register. Required.
//   BPS=400         total fee in basis points, 200–500. Pass 0 to DE-REGISTER.
//   CONFIRM=set-partner   actually send the transaction. Without it, dry run.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { reportEnv, armed } = require("./utils/session_env");
const { ethers } = hre;

const MIN_TOTAL_BPS = 200;
const MAX_TOTAL_BPS = 500;
const HOUSE_FLOOR_BPS = 200;

const line = (c = "─", n = 66) => c.repeat(n);
const say = (m = "") => console.log(m);
const pad = (s, n) => { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); };

function fail(msg) {
  say("");
  say("⛔ STOPPING");
  say("   " + msg);
  say("");
  process.exit(1);
}

/* FeeSchedule.splitBps, replicated ONLY to PREDICT the split before the
   partner exists. The contract cannot be asked — quote() reverts with
   UnknownPartner until registration succeeds. After the transaction the
   script reads the REAL split back off the chain and compares the two.
   Predict, then measure, then check they agree. */
function predictSplit(totalBps) {
  const half = Math.ceil(totalBps / 2);
  const houseBps = half > HOUSE_FLOOR_BPS ? half : HOUSE_FLOOR_BPS;
  return { houseBps, partnerBps: totalBps - houseBps };
}

async function main() {
  // ⛔ Say what this run inherited BEFORE it says what it decided.
  reportEnv(["CONFIRM", "PARTNER", "BPS"]);

  const netName = hre.network.name;

  say("");
  say(line("═"));
  say("  DistributeProV3 — REGISTER A PARTNER");
  say(line("═"));
  say("");

  // ── Which contract? From the deployment record, never typed in. ────────
  const recordPath = path.join(__dirname, "..", "deployments", `${netName}.json`);
  if (!fs.existsSync(recordPath)) {
    fail(`No deployment record at deployments/${netName}.json — deploy first.`);
  }
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const address = record.address;

  say(`  contract   ${address}`);
  say(`  network    ${netName} (chainId ${record.chainId})`);
  say("");

  // ── Arguments, validated before anything is read from the chain. ───────
  if (!process.env.PARTNER) fail("PARTNER is not set. Pass the address to register.");
  let partner;
  try {
    partner = ethers.getAddress(process.env.PARTNER.trim());
  } catch (e) {
    fail(`PARTNER "${process.env.PARTNER}" is not a valid address.`);
  }
  if (partner === ethers.ZeroAddress) {
    fail("PARTNER is the zero address — setPartner rejects it, and address(0) already " +
         "means 'no partner' at the 2% floor.");
  }

  if (process.env.BPS === undefined) fail("BPS is not set. Pass 200–500, or 0 to de-register.");
  const bps = Number(process.env.BPS);
  if (!Number.isInteger(bps)) fail(`BPS "${process.env.BPS}" is not a whole number.`);
  if (bps !== 0 && (bps < MIN_TOTAL_BPS || bps > MAX_TOTAL_BPS)) {
    fail(`BPS ${bps} is outside FeeSchedule's band [${MIN_TOTAL_BPS}, ${MAX_TOTAL_BPS}]. ` +
         `The contract would revert with TotalFeeOutOfRange. Pass 0 to de-register.`);
  }

  const [signer] = await ethers.getSigners();
  const dp = await ethers.getContractAt("DistributeProV3", address, signer);

  // ── [1/5] the chain must agree with the record before anything else. ───
  say("  [1/5] confirming the contract on-chain matches the record ...");
  const code = await ethers.provider.getCode(address);
  if (code === "0x") fail(`No contract code at ${address} on ${netName}.`);
  const onChainOwner = await dp.owner();
  const onChainHouse = await dp.houseRecipient();
  say(`        owner    ${onChainOwner}`);
  say(`        house    ${onChainHouse}`);
  say(`        signer   ${signer.address}`);

  // ⛔ setPartner is onlyOwner. Say so here rather than letting the node
  //    bounce it after the gas has been quoted.
  if (onChainOwner.toLowerCase() !== signer.address.toLowerCase()) {
    fail(`setPartner is owner-only. This contract's owner is ${onChainOwner}, but the ` +
         `wallet in your .env is ${signer.address}. Use the owner's key.`);
  }
  say(`        ✓ the signer IS the owner`);

  // ── [2/5] what is registered TODAY, read off the chain. ────────────────
  say("  [2/5] reading the current registration ...");
  const currentBps = Number(await dp.partnerTotalBps(partner));
  say(`        partner  ${partner}`);
  say(`        current  ${currentBps === 0
        ? "not registered (quote() with this address REVERTS today)"
        : `${currentBps} bps = ${currentBps / 100}%`}`);

  if (currentBps === bps) {
    say("");
    say(`  Nothing to do — ${partner} is already at ${bps} bps.`);
    say("");
    process.exit(0);
  }

  // ── [3/5] what the change means, predicted. ────────────────────────────
  say("  [3/5] what this rate means ...");
  if (bps === 0) {
    say(`        DE-REGISTERING. After this, quote(payout, ${partner.slice(0, 10)}…)`);
    say(`        will REVERT with UnknownPartner, and anyone using a link carrying`);
    say(`        this address will be told it is not a recognised partner.`);
  } else {
    const p = predictSplit(bps);
    say(`        total fee    ${bps} bps = ${bps / 100}%  (charged ON TOP of the payout)`);
    say(`          house      ${p.houseBps} bps = ${p.houseBps / 100}%`);
    say(`          partner    ${p.partnerBps} bps = ${p.partnerBps / 100}%`);
    say("");
    say(`        On a 1 BTCC payout the sender pays ${(1 + bps / 10000).toFixed(4)} —`);
    say(`        ${(p.houseBps / 10000).toFixed(4)} to the house and ${(p.partnerBps / 10000).toFixed(4)} to the partner.`);
    say(`        ⚠️ PREDICTED from FeeSchedule's formula. The chain has not been asked`);
    say(`        yet — it cannot be, because quote() reverts for an unregistered`);
    say(`        partner. Step [5/5] reads the real split back and compares.`);
  }

  // ── [4/5] gate. ────────────────────────────────────────────────────────
  say("");
  say("  [4/5] checking confirmation ...");
  if (!armed("CONFIRM", "set-partner")) {
    say("");
    say(line());
    say("  DRY RUN — nothing was sent.");
    say("");
    say(`  This would set ${partner}`);
    say(`  from ${currentBps} bps to ${bps} bps.`);
    say("");
    say("  To do it for real:");
    say(`    $env:PARTNER="${partner}"; $env:BPS="${bps}"; $env:CONFIRM="set-partner"; npx hardhat run scripts/set_partner.js --network btc20`);
    say(line());
    say("");
    return;
  }

  const balBefore = await ethers.provider.getBalance(signer.address);
  say(`        CONFIRM=set-partner — sending the transaction.`);
  const tx = await dp.setPartner(partner, bps);
  say(`        tx       ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    fail(`The transaction was mined but FAILED. Nothing changed. tx ${tx.hash}`);
  }

  /* ⛔ receipt.gasPrice IS ABSENT ON BTC20 — the node emits no
     effectiveGasPrice, an EIP-1559 field (brief §19.3). ethers 6.17
     backfills it from the transaction, but older versions return 0 and
     report a cost of zero, which faked a mismatch once already. */
  const paidPrice = (receipt.gasPrice && receipt.gasPrice > 0n) ? receipt.gasPrice : tx.gasPrice;
  const cost = receipt.gasUsed * paidPrice;
  say(`        block    ${receipt.blockNumber}   status ${receipt.status}`);
  say(`        type     ${tx.type}${tx.type === 0 ? " (legacy) ✓" : " — EXPECTED 0 on this chain"}`);
  say(`        gas      ${receipt.gasUsed} @ ${paidPrice} = ${ethers.formatEther(cost)}` +
      ((receipt.gasPrice && receipt.gasPrice > 0n) ? "" : "  [price from the tx, not the receipt]"));

  // ── [5/5] READ IT BACK. A transaction that succeeded is not the same ──
  //         as a registry that changed.
  say("");
  say("  [5/5] reading the registration back off the chain ...");
  const after = Number(await dp.partnerTotalBps(partner));
  say(`        partnerTotalBps  ${after} bps`);
  if (after !== bps) {
    fail(`The chain says ${after} bps but ${bps} was requested. Do not trust this registration.`);
  }
  say(`        ✓ matches what was requested`);

  if (bps !== 0) {
    /* Now the contract CAN be asked, so stop predicting and measure. */
    const probe = ethers.parseEther("1");
    const q = await dp.quote(probe, partner);
    const [totalBps, totalFee, houseFee, partnerFee, required] = q;
    const pred = predictSplit(bps);
    say("");
    say("        the chain's own quote on a 1 BTCC payout:");
    say(`          ${pad("total fee", 14)}${pad(ethers.formatEther(totalFee), 14)}(${totalBps} bps)`);
    say(`          ${pad("house", 14)}${pad(ethers.formatEther(houseFee), 14)}→ ${onChainHouse}`);
    say(`          ${pad("partner", 14)}${pad(ethers.formatEther(partnerFee), 14)}→ ${partner}`);
    say(`          ${pad("sender pays", 14)}${ethers.formatEther(required)}`);

    const okHouse = houseFee === (probe * BigInt(pred.houseBps)) / 10000n;
    const okPartner = partnerFee === (probe * BigInt(pred.partnerBps)) / 10000n;
    const okSum = houseFee + partnerFee === totalFee;
    say("");
    say(`        predicted house   ${pred.houseBps} bps  → ${okHouse ? "✓ matches the chain" : "⛔ DISAGREES"}`);
    say(`        predicted partner ${pred.partnerBps} bps  → ${okPartner ? "✓ matches the chain" : "⛔ DISAGREES"}`);
    say(`        house + partner == total fee → ${okSum ? "✓ exact, no dust" : "⛔ DOES NOT ADD UP"}`);
    if (!okHouse || !okPartner || !okSum) {
      fail("This script's model of FeeSchedule disagrees with the deployed contract. " +
           "The contract is the truth — do not use the predicted figures anywhere.");
    }
  }

  const balAfter = await ethers.provider.getBalance(signer.address);
  say("");
  say(`        wallet   ${ethers.formatEther(balBefore)} → ${ethers.formatEther(balAfter)}`);
  const delta = balBefore - balAfter;
  say(`        spent    ${ethers.formatEther(delta)}` +
      (delta === cost ? "  ✓ exactly the gas, to the wei" : `  ⚠️ expected ${ethers.formatEther(cost)}`));

  say("");
  say(line("═"));
  say(bps === 0
    ? `  ✅ ${partner} is DE-REGISTERED.`
    : `  ✅ ${partner} is registered at ${bps / 100}%.`);
  say(line("═"));
  say("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
