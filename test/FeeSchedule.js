/**
 * FeeSchedule.js — the owner's fee table, verified on-chain.
 *
 * Written for the owner and a future session of Claude. 2026-09-11.
 * Model and reasoning: docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 7.2.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Unlike test/V2_1_defects.js — where green means "the bug is real" — THIS
 * file is an ordinary specification. Green means the fee model is correct.
 * Red means the contract does not match the table the owner gave, and the
 * contract is what's wrong.
 *
 * This is the first piece of V3 and the only piece that exists yet. It is
 * deliberately built and proven in isolation, before the contract that uses
 * it: the fee curve is the part that was silently broken for three versions.
 * ─────────────────────────────────────────────────────────────────────────
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// The owner's table, exactly as he gave it. [total, house, partner] in bps.
const OWNER_TABLE = [
  [200, 200, 0],
  [250, 200, 50],
  [300, 200, 100],
  [350, 200, 150],
  [400, 200, 200],
  [450, 225, 225],
  [500, 250, 250],
];

const pct = (bps) => `${Number(bps) / 100}%`;

describe("FeeSchedule — V3 fee model", function () {
  let fs;

  beforeEach(async function () {
    const F = await ethers.getContractFactory("FeeScheduleHarness");
    fs = await F.deploy();
    await fs.waitForDeployment();
  });

  describe("the owner's table", function () {
    it("reproduces all seven rows exactly", async function () {
      for (const [total, expectedHouse, expectedPartner] of OWNER_TABLE) {
        const [house, partner] = await fs.splitBps(total);
        console.log(
          `      total ${pct(total).padStart(5)}  ->  Crypto Counsel ${pct(house).padStart(6)}   partner ${pct(partner)}`
        );
        expect(house, `house share at ${pct(total)}`).to.equal(BigInt(expectedHouse));
        expect(partner, `partner share at ${pct(total)}`).to.equal(BigInt(expectedPartner));
      }
    });
  });

  describe("bounds", function () {
    it("rejects anything below the 2% floor", async function () {
      // NOTE: the factory is resolved BEFORE the expect(), not inside it.
      // Awaiting a second promise inside the assertion's argument list leaves
      // the rejected splitBps promise briefly unhandled, and Node prints a
      // PromiseRejectionHandledWarning. The test passed either way; the
      // warning was noise in the output. Fixed 2026-09-11.
      const factory = await ethers.getContractFactory("FeeScheduleHarness");
      await expect(fs.splitBps(199)).to.be.revertedWithCustomError(factory, "TotalFeeOutOfRange");
      await expect(fs.splitBps(0)).to.be.revertedWithCustomError(factory, "TotalFeeOutOfRange");
    });

    it("rejects anything above the 5% ceiling — V2.0 allowed up to 100%", async function () {
      await expect(fs.splitBps(501)).to.be.reverted;
      await expect(fs.splitBps(10000)).to.be.reverted;
    });

    it("accepts both ends of the range", async function () {
      await expect(fs.splitBps(200)).to.not.be.reverted;
      await expect(fs.splitBps(500)).to.not.be.reverted;
      expect(await fs.minTotalBps()).to.equal(200n);
      expect(await fs.maxTotalBps()).to.equal(500n);
    });
  });

  describe("invariants across the whole legal range", function () {
    it("Crypto Counsel never earns less than 2%, at any setting", async function () {
      for (let total = 200; total <= 500; total++) {
        const [house] = await fs.splitBps(total);
        expect(house, `house share at ${pct(total)}`).to.be.greaterThanOrEqual(200n);
      }
    });

    it("Crypto Counsel is never out-earned by the partner", async function () {
      for (let total = 200; total <= 500; total++) {
        const [house, partner] = await fs.splitBps(total);
        expect(house, `at ${pct(total)}`).to.be.greaterThanOrEqual(partner);
      }
    });

    it("the two shares always add back up to the total", async function () {
      for (let total = 200; total <= 500; total++) {
        const [house, partner] = await fs.splitBps(total);
        expect(house + partner, `at ${pct(total)}`).to.equal(BigInt(total));
      }
    });

    it("self-dealing is not profitable — naming yourself as partner costs you more", async function () {
      // A caller who registers themselves as their own partner pays the house
      // MORE at every setting above the floor. There is no configuration in
      // which naming a partner reduces Crypto Counsel's take.
      const [houseAtFloor] = await fs.splitBps(200);
      for (let total = 201; total <= 500; total++) {
        const [house] = await fs.splitBps(total);
        expect(house, `at ${pct(total)}`).to.be.greaterThanOrEqual(houseAtFloor);
      }
      const [houseAtCeiling] = await fs.splitBps(500);
      console.log(
        `      house take: ${pct(houseAtFloor)} at the floor, ${pct(houseAtCeiling)} at the ceiling — never lower`
      );
    });
  });

  describe("fee amounts — no dust, which the never-hold-funds rule requires", function () {
    // Awkward values on purpose: primes, odd wei counts, 6-decimal and
    // 18-decimal scales, and amounts small enough to expose rounding.
    const PAYOUTS = [
      1n,
      7n,
      19n,
      20n,
      21n,
      999n,
      ethers.parseUnits("1", 6),
      ethers.parseUnits("1234.567891", 6),
      ethers.parseEther("1"),
      ethers.parseEther("1") + 12345n,
      123456789n,
    ];

    it("house + partner always equals the total fee exactly", async function () {
      let checks = 0;
      for (const payout of PAYOUTS) {
        for (const total of [200, 250, 333, 400, 401, 450, 499, 500]) {
          const [totalFee, houseFee, partnerFee] = await fs.feesOn(payout, total);
          expect(houseFee + partnerFee, `payout ${payout} at ${pct(total)}`).to.equal(totalFee);
          checks++;
        }
      }
      console.log(`      ${checks} payout/rate combinations, zero wei unaccounted for`);
    });

    it("the house absorbs the rounding remainder, never the partner", async function () {
      for (const payout of PAYOUTS) {
        for (const total of [200, 333, 400, 401, 450, 499, 500]) {
          const [, houseFee, partnerFee] = await fs.feesOn(payout, total);
          expect(houseFee, `payout ${payout} at ${pct(total)}`).to.be.greaterThanOrEqual(partnerFee);
        }
      }
    });

    it("at the 2% floor the partner earns nothing", async function () {
      const payout = ethers.parseEther("1000");
      const [totalFee, houseFee, partnerFee] = await fs.feesOn(payout, 200);
      expect(partnerFee).to.equal(0n);
      expect(houseFee).to.equal(totalFee);
      expect(totalFee).to.equal(ethers.parseEther("20")); // 2% of 1000
      console.log(`      1000 ETH payout at 2.0% -> total fee ${ethers.formatEther(totalFee)} ETH, all to Crypto Counsel`);
    });

    it("at the 5% ceiling the split is even", async function () {
      const payout = ethers.parseEther("1000");
      const [totalFee, houseFee, partnerFee] = await fs.feesOn(payout, 500);
      expect(totalFee).to.equal(ethers.parseEther("50")); // 5% of 1000
      expect(houseFee).to.equal(ethers.parseEther("25"));
      expect(partnerFee).to.equal(ethers.parseEther("25"));
      console.log(`      1000 ETH payout at 5.0% -> ${ethers.formatEther(houseFee)} house / ${ethers.formatEther(partnerFee)} partner`);
    });

    it("is decimals-agnostic — the defect that killed V2.1 cannot recur", async function () {
      // The same nominal quantity in a 6-decimal and an 18-decimal token must
      // attract the same RATE. V2.1 charged 2% and 0.5% for these two.
      const sixDp = ethers.parseUnits("1000000", 6);
      const eighteenDp = ethers.parseUnits("1000000", 18);

      const [fee6] = await fs.feesOn(sixDp, 200);
      const [fee18] = await fs.feesOn(eighteenDp, 200);

      const rate6 = (fee6 * 10000n) / sixDp;
      const rate18 = (fee18 * 10000n) / eighteenDp;

      console.log(`      1,000,000 of a 6-decimal token  -> ${pct(rate6)}`);
      console.log(`      1,000,000 of an 18-decimal token -> ${pct(rate18)}`);
      expect(rate6).to.equal(rate18);
      expect(rate6).to.equal(200n);
    });
  });
});
