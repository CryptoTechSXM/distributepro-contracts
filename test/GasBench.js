/**
 * GasBench.js — how many recipients actually fit in one transaction?
 *
 * Written for the owner and a future session of Claude. 2026-09-11.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `maxRecipients` was set to 250 by judgement, not measurement. Then
 * scripts/probe_btc20.js measured the BTC20 Smart Chain's block gas limit:
 *
 *     8,000,000
 *
 * That is a QUARTER of Ethereum's ~30M and half of the measured Base Sepolia
 * per-transaction ceiling of 16,777,216. A batch that is comfortable on Base
 * may not fit in a BTC20 block at all — and a transaction that does not fit
 * fails AFTER the owner has paid the gas.
 *
 * So the cap has to come from a number that was run, not a number that felt
 * about right. This file measures real gas for real batch sizes and works
 * backwards to a safe cap per chain.
 *
 * These tests do not fail on gas; they MEASURE and print. The one thing they
 * assert is that the cost model is actually linear in the recipient count —
 * because if it is not, extrapolating a cap from it would be wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RESULTS, 2026-09-11 (hardhat local node, berlin target, optimizer on)
 *
 *   native   36,021 gas per recipient   (linear to within 0.0%)
 *   token    27,500 gas per recipient   (linear to within 0.1%)
 *
 * ⚠️ NATIVE IS THE EXPENSIVE SIDE. Claude assumed the opposite before
 * running this and was wrong — paying a brand-new address in native coin
 * triggers a 25,000-gas account creation, while an ERC-20 transfer to the
 * same fresh address is a ~22,100-gas cold storage write.
 *
 * And the number that justified the whole exercise: **250 native recipients
 * cost 9,047,961 gas — more than the BTC20 Smart Chain's ENTIRE 8,000,000
 * block limit.** The judgement-based cap of 250 would have produced batches
 * that could never confirm on that chain.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Run:  npx hardhat test test/GasBench.js
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// Divisors of 10000, so shares split exactly with no remainder games.
const SIZES = [1, 10, 50, 100, 200, 250];

// Block gas limits worth planning against.
const CHAINS = [
  { name: "BTC20 Smart Chain", limit: 8_000_000, note: "MEASURED 2026-09-11 via probe_btc20.js" },
  { name: "Base Sepolia", limit: 16_777_216, note: "measured per-tx ceiling, 2^24" },
  { name: "Ethereum / Base / BSC", limit: 30_000_000, note: "typical modern block limit" },
];

// Never plan to fill a whole block. Leave headroom for base fee variance and
// for the fact that a batch of fresh addresses is the expensive case.
const SAFETY = 0.5;

function sharesFor(n) {
  const each = 10000 / n;
  return Array(n).fill(each);
}

function freshAddresses(n) {
  // Brand new addresses on purpose: paying an account that does not exist yet
  // costs far more gas (account creation / cold storage write) than paying one
  // that does. A CSV of new payees is the realistic worst case, so measure it.
  return Array.from({ length: n }, () => ethers.Wallet.createRandom().address);
}

describe("Gas — how big can a batch actually be?", function () {
  this.timeout(180000);

  let owner, house, dp, dpAddr, token, tokenAddr;

  before(async function () {
    [owner, house] = await ethers.getSigners();

    const F = await ethers.getContractFactory("DistributeProV3");
    dp = await F.deploy(house.address, 500); // hard limit, so nothing caps the bench
    await dp.waitForDeployment();
    dpAddr = await dp.getAddress();

    const T = await ethers.getContractFactory("MockUSDC6");
    token = await T.deploy(ethers.parseUnits("1000000000", 6));
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();
  });

  const nativeGas = {};
  const tokenGas = {};

  describe("measuring", function () {
    for (const n of SIZES) {
      it(`native, ${n} recipient${n === 1 ? "" : "s"}`, async function () {
        const recipients = freshAddresses(n);
        const payout = ethers.parseEther("1");
        const { required } = await dp.quote(payout, ethers.ZeroAddress);

        const tx = await dp.distributeNative(recipients, sharesFor(n), payout, ethers.ZeroAddress, {
          value: required,
        });
        const rc = await tx.wait();
        nativeGas[n] = rc.gasUsed;
        console.log(
          `      ${String(n).padStart(3)} recipients -> ${rc.gasUsed.toLocaleString().padStart(11)} gas` +
            `   (${Math.round(Number(rc.gasUsed) / n).toLocaleString()} per recipient)`
        );
      });
    }

    for (const n of SIZES) {
      it(`ERC-20, ${n} recipient${n === 1 ? "" : "s"}`, async function () {
        const recipients = freshAddresses(n);
        const payout = ethers.parseUnits("10000", 6);
        const { required } = await dp.quote(payout, ethers.ZeroAddress);
        await token.approve(dpAddr, required);

        const tx = await dp.distributeToken(
          tokenAddr,
          recipients,
          sharesFor(n),
          payout,
          ethers.ZeroAddress
        );
        const rc = await tx.wait();
        tokenGas[n] = rc.gasUsed;
        console.log(
          `      ${String(n).padStart(3)} recipients -> ${rc.gasUsed.toLocaleString().padStart(11)} gas` +
            `   (${Math.round(Number(rc.gasUsed) / n).toLocaleString()} per recipient)`
        );
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // REPEAT PAYMENTS — the case the first bench missed
  //
  // Everything above pays BRAND-NEW addresses, which costs a 25,000-gas
  // account creation each. That is the first payroll run. The SECOND run to
  // the same people costs far less, and most real distributions are repeats.
  //
  // The owner made exactly this point from his own live transactions, so it
  // gets measured rather than argued about. Same list, paid twice; the second
  // run is what a recurring payout actually costs.
  // ═══════════════════════════════════════════════════════════════════════
  const nativeRepeat = {};
  const tokenRepeat = {};

  describe("repeat payments to payees who already exist", function () {
    for (const n of [50, 100, 200, 250]) {
      it(`native repeat, ${n} recipients`, async function () {
        const recipients = freshAddresses(n);
        const payout = ethers.parseEther("1");
        const { required } = await dp.quote(payout, ethers.ZeroAddress);

        // Run 1 creates the accounts. Not measured.
        await (await dp.distributeNative(recipients, sharesFor(n), payout, ethers.ZeroAddress, { value: required })).wait();
        // Run 2 is the real recurring cost.
        const rc = await (await dp.distributeNative(recipients, sharesFor(n), payout, ethers.ZeroAddress, { value: required })).wait();

        nativeRepeat[n] = rc.gasUsed;
        const first = nativeGas[n];
        console.log(
          `      ${String(n).padStart(3)} recipients -> ${rc.gasUsed.toLocaleString().padStart(11)} gas` +
            `   (${Math.round(Number(rc.gasUsed) / n).toLocaleString()} per recipient` +
            (first ? `, vs ${Math.round(Number(first) / n).toLocaleString()} first time` : "") + `)`
        );
      });
    }

    for (const n of [50, 100, 200, 250]) {
      it(`ERC-20 repeat, ${n} recipients`, async function () {
        const recipients = freshAddresses(n);
        const payout = ethers.parseUnits("10000", 6);
        const { required } = await dp.quote(payout, ethers.ZeroAddress);

        await token.approve(dpAddr, required);
        await (await dp.distributeToken(tokenAddr, recipients, sharesFor(n), payout, ethers.ZeroAddress)).wait();
        await token.approve(dpAddr, required);
        const rc = await (await dp.distributeToken(tokenAddr, recipients, sharesFor(n), payout, ethers.ZeroAddress)).wait();

        tokenRepeat[n] = rc.gasUsed;
        const first = tokenGas[n];
        console.log(
          `      ${String(n).padStart(3)} recipients -> ${rc.gasUsed.toLocaleString().padStart(11)} gas` +
            `   (${Math.round(Number(rc.gasUsed) / n).toLocaleString()} per recipient` +
            (first ? `, vs ${Math.round(Number(first) / n).toLocaleString()} first time` : "") + `)`
        );
      });
    }

    it("reports how much cheaper a repeat run is", function () {
      const slope = (d, a, b) => Number(d[b] - d[a]) / (b - a);
      const nFirst = slope(nativeGas, 200, 250);
      const nRepeat = slope(nativeRepeat, 200, 250);
      const tFirst = slope(tokenGas, 200, 250);
      const tRepeat = slope(tokenRepeat, 200, 250);
      console.log("");
      console.log(`      native   first run ${Math.round(nFirst).toLocaleString()} -> repeat ${Math.round(nRepeat).toLocaleString()} gas/recipient  (${(nFirst / nRepeat).toFixed(1)}x cheaper)`);
      console.log(`      token    first run ${Math.round(tFirst).toLocaleString()} -> repeat ${Math.round(tRepeat).toLocaleString()} gas/recipient  (${(tFirst / tRepeat).toFixed(1)}x cheaper)`);
      console.log("");
      console.log("      ▶ maxRecipients must be set from the FIRST-RUN number. It is the");
      console.log("        worst case, and a batch that is too big fails AFTER paying gas.");
      console.log("        The repeat numbers are what recurring payroll actually costs.");
      console.log("");
      expect(nRepeat).to.be.lessThan(nFirst);
      expect(tRepeat).to.be.lessThan(tFirst);
    });
  });

  describe("the answer", function () {
    it("cost is linear in the recipient count, so a cap can be extrapolated", function () {
      // Marginal cost between the two largest samples is the honest slope:
      // it excludes the fixed overhead that dominates tiny batches.
      for (const [label, data] of [["native", nativeGas], ["token", tokenGas]]) {
        const a = 200, b = 250;
        const slope = Number(data[b] - data[a]) / (b - a);
        const predictedAt100 = Number(data[b]) - slope * (b - 100);
        const actualAt100 = Number(data[100]);
        const errorPct = Math.abs(predictedAt100 - actualAt100) / actualAt100 * 100;
        console.log(
          `      ${label.padEnd(7)} marginal ${Math.round(slope).toLocaleString()} gas/recipient` +
            `   (linear model predicts 100 within ${errorPct.toFixed(1)}%)`
        );
        expect(errorPct, `${label} cost is not linear — do not extrapolate a cap`).to.be.lessThan(15);
      }
    });

    it("prints the safe maxRecipients for each chain", function () {
      const slopes = {
        native: Number(nativeGas[250] - nativeGas[200]) / 50,
        token: Number(tokenGas[250] - tokenGas[200]) / 50,
      };
      const fixed = {
        native: Number(nativeGas[250]) - slopes.native * 250,
        token: Number(tokenGas[250]) - slopes.token * 250,
      };

      console.log("");
      console.log("      ┌─ SAFE maxRecipients ─────────────────────────────────────────");
      console.log(`      │  using ${SAFETY * 100}% of the block limit as the ceiling`);
      console.log("      │");
      for (const c of CHAINS) {
        const budget = c.limit * SAFETY;
        const nNative = Math.floor((budget - fixed.native) / slopes.native);
        const nToken = Math.floor((budget - fixed.token) / slopes.token);
        const safe = Math.max(1, Math.min(nNative, nToken));
        console.log(`      │  ${c.name.padEnd(24)} limit ${c.limit.toLocaleString().padStart(10)}`);
        console.log(
          `      │    native ${String(nNative).padStart(4)}   token ${String(nToken).padStart(4)}` +
            `   ->  SET maxRecipients = ${safe}`
        );
        console.log(`      │    (${c.note})`);
      }
      console.log("      └──────────────────────────────────────────────────────────────");
      console.log("");
      console.log("      ⚠️ THE NATIVE NUMBER IS THE BINDING ONE, AND THAT IS A SURPRISE.");
      console.log("      Claude predicted ERC-20 would be the expensive side. MEASURED 2026-09-11,");
      console.log("      it is the other way round: native ~36,000 gas/recipient vs token ~27,500.");
      console.log("      Reason: paying a brand-new address in native coin costs a 25,000-gas");
      console.log("      account creation on top of the call, while an ERC-20 transfer to the same");
      console.log("      fresh address is a ~22,100-gas cold storage write. Native wins the fixed");
      console.log("      cost and loses the marginal one.");
      console.log("      The cap must satisfy the WORSE of the two, so it is set by native.");
      console.log("");
      console.log("      maxRecipients is a CONSTRUCTOR ARG and owner-settable, so each");
      console.log("      chain gets its own value. There is no need for one global answer.");
      console.log("");
    });
  });
});
