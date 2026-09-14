/**
 * V3_spec.js — what DistributeProV3 is REQUIRED to do.
 *
 * Written for the owner and a future session of Claude. 2026-09-11.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE OTHER HALF OF test/V2_1_defects.js.
 *
 * Over there, green means "the bug is real". Here, green means "the bug is
 * fixed". Tests tagged (was Dn) are the same scenario as defect Dn, flipped:
 * the exact case that failed on V2.1 is asserted to succeed on V3, and the
 * exact case that silently succeeded on V2.1 is asserted to revert.
 *
 * That pairing is the whole point. A test written only against V3 would
 * never prove it would have caught anything.
 * ─────────────────────────────────────────────────────────────────────────
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ⛔ FEE space, NOT share space. V3.1 moved the SHARE denominator to
// 1,000,000; the FEE denominator stayed at 10,000. FEE_BPS is only ever used
// to express a fee RATE as a percentage — see the (was D1) test.
const FEE_BPS = 10_000n;
const SHARE_DENOM = 1_000_000n;
const MAX_RECIPIENTS = 250;

describe("DistributeProV3 — specification", function () {
  let owner, house, partner, alice, bob, carol, outsider;
  let dp, dpAddr;

  beforeEach(async function () {
    [owner, house, partner, alice, bob, carol, outsider] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DistributeProV3");
    dp = await F.deploy(house.address, MAX_RECIPIENTS);
    await dp.waitForDeployment();
    dpAddr = await dp.getAddress();
  });

  async function newToken(supply = ethers.parseUnits("10000000", 6)) {
    const T = await ethers.getContractFactory("MockUSDC6");
    const t = await T.deploy(supply);
    await t.waitForDeployment();
    return t;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THE RULE: never holds third-party funds
  // ═══════════════════════════════════════════════════════════════════════
  describe("⛔ holds nothing (the owner's hard rule)", function () {
    it("native balance is zero before and after a distribution", async function () {
      expect(await ethers.provider.getBalance(dpAddr)).to.equal(0n);

      const payout = ethers.parseEther("3");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await dp.distributeNative(
        [alice.address, bob.address],
        [500_000, 500_000],
        payout,
        ethers.ZeroAddress,
        { value: required }
      );

      expect(await ethers.provider.getBalance(dpAddr)).to.equal(0n);
    });

    it("token balance is zero before and after a distribution", async function () {
      const token = await newToken();
      const tAddr = await token.getAddress();
      const payout = ethers.parseUnits("5000", 6);
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await token.approve(dpAddr, required);

      expect(await token.balanceOf(dpAddr)).to.equal(0n);
      await dp.distributeToken(tAddr, [alice.address, bob.address], [700_000, 300_000], payout, ethers.ZeroAddress);
      expect(await token.balanceOf(dpAddr)).to.equal(0n);
    });

    it("refuses a bare native transfer — there is no receive()", async function () {
      await expect(
        owner.sendTransaction({ to: dpAddr, value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Happy paths
  // ═══════════════════════════════════════════════════════════════════════
  describe("distributing by percentage", function () {
    it("pays native coin in the right proportions, and both fee legs", async function () {
      const payout = ethers.parseEther("10");
      await dp.setPartner(partner.address, 500); // 5% total -> 2.5 / 2.5

      const { totalFee, houseFee, partnerFee, required } = await dp.quote(payout, partner.address);
      expect(houseFee).to.equal(ethers.parseEther("0.25")); // 2.5% of 10
      expect(partnerFee).to.equal(ethers.parseEther("0.25"));
      expect(required).to.equal(payout + totalFee);

      const before = {
        alice: await ethers.provider.getBalance(alice.address),
        bob: await ethers.provider.getBalance(bob.address),
        carol: await ethers.provider.getBalance(carol.address),
        house: await ethers.provider.getBalance(house.address),
        partner: await ethers.provider.getBalance(partner.address),
      };

      await dp.distributeNative(
        [alice.address, bob.address, carol.address],
        [500_000, 300_000, 200_000],
        payout,
        partner.address,
        { value: required }
      );

      expect((await ethers.provider.getBalance(alice.address)) - before.alice).to.equal(ethers.parseEther("5"));
      expect((await ethers.provider.getBalance(bob.address)) - before.bob).to.equal(ethers.parseEther("3"));
      expect((await ethers.provider.getBalance(carol.address)) - before.carol).to.equal(ethers.parseEther("2"));
      expect((await ethers.provider.getBalance(house.address)) - before.house).to.equal(houseFee);
      expect((await ethers.provider.getBalance(partner.address)) - before.partner).to.equal(partnerFee);

      console.log(`      10 ETH split 50/30/20 at 5% -> house ${ethers.formatEther(houseFee)}, partner ${ethers.formatEther(partnerFee)}`);
    });

    it("pays ERC-20 in the right proportions", async function () {
      const token = await newToken();
      const tAddr = await token.getAddress();
      const payout = ethers.parseUnits("1000", 6);
      const { required, houseFee } = await dp.quote(payout, ethers.ZeroAddress);
      await token.approve(dpAddr, required);

      await dp.distributeToken(tAddr, [alice.address, bob.address], [750_000, 250_000], payout, ethers.ZeroAddress);

      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("750", 6));
      expect(await token.balanceOf(bob.address)).to.equal(ethers.parseUnits("250", 6));
      expect(await token.balanceOf(house.address)).to.equal(houseFee);
      expect(houseFee).to.equal(ethers.parseUnits("20", 6)); // 2% of 1000
    });

    it("with no partner, the house takes the whole 2% and nobody else is paid", async function () {
      const payout = ethers.parseEther("1");
      const { totalBps, houseFee, partnerFee } = await dp.quote(payout, ethers.ZeroAddress);
      expect(totalBps).to.equal(200n);
      expect(partnerFee).to.equal(0n);
      expect(houseFee).to.equal(ethers.parseEther("0.02"));
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // The defects, flipped
  // ═══════════════════════════════════════════════════════════════════════
  describe("the V2.1 defects, now fixed", function () {
    it("(was D1) the fee rate is identical for 6-decimal and 18-decimal tokens", async function () {
      const six = ethers.parseUnits("1000000", 6);
      const eighteen = ethers.parseUnits("1000000", 18);
      const q6 = await dp.quote(six, ethers.ZeroAddress);
      const q18 = await dp.quote(eighteen, ethers.ZeroAddress);
      expect((q6.totalFee * FEE_BPS) / six).to.equal((q18.totalFee * FEE_BPS) / eighteen);
      console.log(`      both charged ${Number((q6.totalFee * FEE_BPS) / six) / 100}% — V2.1 charged 2% and 0.5%`);
    });

    it("(was D2) there is no caller-supplied total to lie about — amounts come from the shares", async function () {
      // The V2.1 attack needed two things: a held balance to steal, and a
      // `total` the contract trusted. V3 has neither. There is no parameter
      // that can disagree with the per-recipient maths.
      const frag = dp.interface.getFunction("distributeToken");
      const names = frag.inputs.map((i) => i.name);
      console.log(`      distributeToken(${names.join(", ")})`);
      expect(names).to.not.include("total");

      // And the money is exact: msg.value must match the quote to the wei.
      const payout = ethers.parseEther("1");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await expect(
        dp.distributeNative([alice.address], [1_000_000], payout, ethers.ZeroAddress, { value: required - 1n })
      ).to.be.revertedWithCustomError(dp, "IncorrectNativeValue");
    });

    it("(was D3) a smart-contract wallet in the list no longer kills the batch", async function () {
      const W = await ethers.getContractFactory("MockContractWallet");
      const wallet = await W.deploy();
      await wallet.waitForDeployment();
      const wAddr = await wallet.getAddress();

      const payout = ethers.parseEther("3");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);

      await expect(
        dp.distributeNative(
          [alice.address, wAddr, bob.address],
          [333_400, 333_300, 333_300],
          payout,
          ethers.ZeroAddress,
          { value: required }
        )
      ).to.not.be.reverted;

      expect(await wallet.totalReceived()).to.be.greaterThan(0n);
      expect(await wallet.payments()).to.equal(1n);
      console.log(`      Safe-like wallet received ${ethers.formatEther(await wallet.totalReceived())} ETH — V2.1 reverted the whole batch`);
    });

    it("(was D4) a non-compliant USDT that returns no bool now works", async function () {
      const U = await ethers.getContractFactory("MockUSDTNonCompliant");
      const usdt = await U.deploy(ethers.parseUnits("1000000", 6));
      await usdt.waitForDeployment();
      const uAddr = await usdt.getAddress();

      const payout = ethers.parseUnits("1000", 6);
      const { required, houseFee } = await dp.quote(payout, ethers.ZeroAddress);
      await usdt.approve(dpAddr, required);

      await expect(
        dp.distributeToken(uAddr, [alice.address, bob.address], [600_000, 400_000], payout, ethers.ZeroAddress)
      ).to.not.be.reverted;

      expect(await usdt.balanceOf(alice.address)).to.equal(ethers.parseUnits("600", 6));
      expect(await usdt.balanceOf(bob.address)).to.equal(ethers.parseUnits("400", 6));
      expect(await usdt.balanceOf(house.address)).to.equal(houseFee);
      expect(await usdt.balanceOf(dpAddr)).to.equal(0n);
    });

    it("(was D5) overpaying reverts instead of stranding the money forever", async function () {
      const payout = ethers.parseEther("1");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);

      await expect(
        dp.distributeNative([alice.address], [1_000_000], payout, ethers.ZeroAddress, {
          value: required + ethers.parseEther("0.5"),
        })
      ).to.be.revertedWithCustomError(dp, "IncorrectNativeValue");

      expect(await ethers.provider.getBalance(dpAddr)).to.equal(0n);
    });

    it("(was D6) a fee-on-transfer token is rejected immediately, by name", async function () {
      const F = await ethers.getContractFactory("MockFeeOnTransfer");
      const fot = await F.deploy(100, ethers.parseEther("1000000"));
      await fot.waitForDeployment();
      const fAddr = await fot.getAddress();

      const payout = ethers.parseEther("1000");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await fot.approve(dpAddr, required);

      // V2.1 failed deep inside the payout loop with an opaque ERC20 error.
      // V3 must fail at the door, with a name that says what is wrong.
      await expect(
        dp.distributeToken(fAddr, [alice.address], [1_000_000], payout, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(dp, "FeeOnTransferTokenNotSupported");
    });

    it("(was D7) a zero-address recipient reverts, naming the bad row", async function () {
      const payout = ethers.parseEther("1");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);

      await expect(
        dp.distributeNative(
          [alice.address, ethers.ZeroAddress],
          [500_000, 500_000],
          payout,
          ethers.ZeroAddress,
          { value: required }
        )
      )
        .to.be.revertedWithCustomError(dp, "ZeroRecipient")
        .withArgs(1); // the index, so the frontend can point at the CSV row
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Dust
  // ═══════════════════════════════════════════════════════════════════════
  describe("dust — nothing may be left behind", function () {
    it("an indivisible payout still adds up exactly, with the remainder on the last recipient", async function () {
      const payout = 1000000007n; // deliberately prime-ish, does not divide by 3
      const shares = [333_300, 333_300, 333_400];

      const amounts = await dp.previewAmounts(payout, shares);
      const sum = amounts.reduce((a, b) => a + b, 0n);
      console.log(`      ${amounts.map((a) => a.toString()).join(" + ")} = ${sum} (payout ${payout})`);
      expect(sum).to.equal(payout);

      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      const before = await Promise.all(
        [alice, bob, carol].map((s) => ethers.provider.getBalance(s.address))
      );

      await dp.distributeNative(
        [alice.address, bob.address, carol.address],
        shares,
        payout,
        ethers.ZeroAddress,
        { value: required }
      );

      const after = await Promise.all(
        [alice, bob, carol].map((s) => ethers.provider.getBalance(s.address))
      );
      for (let i = 0; i < 3; i++) {
        expect(after[i] - before[i], `recipient ${i}`).to.equal(amounts[i]);
      }
      expect(await ethers.provider.getBalance(dpAddr)).to.equal(0n);
    });

    it("previewAmounts matches what the chain actually pays", async function () {
      const token = await newToken();
      const tAddr = await token.getAddress();
      const payout = 999999n;
      const shares = [111_100, 222_200, 666_700];

      const expected = await dp.previewAmounts(payout, shares);
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await token.approve(dpAddr, required);
      await dp.distributeToken(tAddr, [alice.address, bob.address, carol.address], shares, payout, ethers.ZeroAddress);

      expect(await token.balanceOf(alice.address)).to.equal(expected[0]);
      expect(await token.balanceOf(bob.address)).to.equal(expected[1]);
      expect(await token.balanceOf(carol.address)).to.equal(expected[2]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // V3.1 — FOUR-DECIMAL PERCENTAGES
  //
  // This block is the whole reason V3.1 exists, so it asserts the CAPABILITY
  // rather than the constant. Every case here is one V3.0 could not express:
  // at a denominator of 10,000 the finest share was 0.01%, and the frontend
  // refused any line finer than that BY NAME rather than rounding it.
  //
  // ⛔ These tests must FAIL against a 10,000-denominator contract — that is
  // what makes them tests. Put SHARE_DENOMINATOR back to 10_000 and they go
  // red on SharesMustTotalDenominator, because 123456 + 876544 is not 10,000.
  // ═══════════════════════════════════════════════════════════════════════
  describe("⛔ V3.1 — shares to four decimal places", function () {
    it("the chain's own denominator is 1,000,000, and the old name is gone", async function () {
      expect(await dp.SHARE_DENOMINATOR()).to.equal(SHARE_DENOM);

      // Read off the ABI, not off recollection. If BPS_DENOMINATOR still
      // existed, a caller written against V3.0 would keep working on a
      // contract whose shares mean something 100x different — silently.
      const names = dp.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(names).to.include("SHARE_DENOMINATOR");
      expect(names).to.not.include("BPS_DENOMINATOR");
    });

    it("pays 12.3456% / 87.6544% exactly — a split V3.0 could not express", async function () {
      const payout = ethers.parseEther("10");
      const shares = [123_456, 876_544]; // 12.3456% + 87.6544% = 100%

      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      const before = await Promise.all(
        [alice, bob].map((s) => ethers.provider.getBalance(s.address))
      );

      await dp.distributeNative(
        [alice.address, bob.address],
        shares,
        payout,
        ethers.ZeroAddress,
        { value: required }
      );

      const after = await Promise.all(
        [alice, bob].map((s) => ethers.provider.getBalance(s.address))
      );
      expect(after[0] - before[0]).to.equal(ethers.parseEther("1.23456"));
      expect(after[1] - before[1]).to.equal(ethers.parseEther("8.76544"));
      expect(await ethers.provider.getBalance(dpAddr)).to.equal(0n);
      console.log("      12.3456% of 10 ETH = 1.23456 ETH, exact — V3.0 rejected this line");
    });

    it("one unit is 0.0001% and it still pays something", async function () {
      // The owner's reason for asking, in his words: "0.001 % btc or eth could
      // potentially be a pretty penny." At 1 ETH a 0.0001% share is 1e12 wei.
      const payout = ethers.parseEther("1");
      const shares = [1, 999_999];

      const amounts = await dp.previewAmounts(payout, shares);
      expect(amounts[0]).to.equal(1_000_000_000_000n); // 1e12 wei, not zero
      expect(amounts[0] + amounts[1]).to.equal(payout);
      console.log(`      finest share on 1 ETH = ${ethers.formatEther(amounts[0])} ETH`);
    });

    it("an indivisible 4-decimal list pays 4-decimal amounts, dust on the last row", async function () {
      // Three awkward 4-dp percentages against a payout that divides by none
      // of them. The hold-nothing rule does not get easier because the
      // denominator got finer.
      const payout = 1_000_000_007n;
      const shares = [333_333, 333_333, 333_334]; // 33.3333 / 33.3333 / 33.3334

      const amounts = await dp.previewAmounts(payout, shares);
      const sum = amounts.reduce((a, b) => a + b, 0n);
      console.log(`      ${amounts.map((a) => a.toString()).join(" + ")} = ${sum} (payout ${payout})`);

      // ⛔⛔ THE SUM ALONE IS NOT A TEST OF THE DENOMINATOR, and the first
      // version of this test asserted nothing else. The LAST recipient
      // receives `payout - everything already sent`, so the total comes out
      // exact at ANY denominator — this test passed green on a deliberately
      // wrong contract when it was written. Same family as the r.addr regex
      // checks and the stale-state regression test: an assertion that cannot
      // fail. What the denominator actually decides is the PER-ROW amount:
      //     1,000,000,007 × 333,333 / 1,000,000 = 333,333,002
      // At the old 10,000 the same row is 33,333,300,233 — 100x out.
      expect(amounts[0]).to.equal(333_333_002n);
      expect(amounts[1]).to.equal(333_333_002n);
      expect(amounts[2]).to.equal(333_334_003n);
      expect(sum).to.equal(payout);

      // And it must clear the contract's OWN validation, which is the half
      // that rejects a four-decimal list outright on V3.0.
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await expect(
        dp.distributeNative(
          [alice.address, bob.address, carol.address],
          shares,
          payout,
          ethers.ZeroAddress,
          { value: required }
        )
      ).to.not.be.reverted;
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Input validation
  // ═══════════════════════════════════════════════════════════════════════
  describe("input validation", function () {
    const payout = ethers.parseEther("1");

    it("shares must total exactly 100%", async function () {
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await expect(
        dp.distributeNative([alice.address, bob.address], [500_000, 400_000], payout, ethers.ZeroAddress, { value: required })
      )
        .to.be.revertedWithCustomError(dp, "SharesMustTotalDenominator")
        .withArgs(900_000, SHARE_DENOM);

      await expect(
        dp.distributeNative([alice.address, bob.address], [500_000, 600_000], payout, ethers.ZeroAddress, { value: required })
      )
        .to.be.revertedWithCustomError(dp, "SharesMustTotalDenominator")
        .withArgs(1_100_000, SHARE_DENOM);
    });

    it("rejects mismatched arrays, empty lists and a zero payout", async function () {
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await expect(
        dp.distributeNative([alice.address, bob.address], [1_000_000], payout, ethers.ZeroAddress, { value: required })
      ).to.be.revertedWithCustomError(dp, "ArrayLengthMismatch");

      await expect(
        dp.distributeNative([], [], payout, ethers.ZeroAddress, { value: required })
      ).to.be.revertedWithCustomError(dp, "NoRecipients");

      await expect(
        dp.distributeNative([alice.address], [1_000_000], 0, ethers.ZeroAddress, { value: 0 })
      ).to.be.revertedWithCustomError(dp, "ZeroPayout");
    });

    it("rejects a zero share — a CSV row that would pay nothing", async function () {
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await expect(
        dp.distributeNative([alice.address, bob.address], [1_000_000, 0], payout, ethers.ZeroAddress, { value: required })
      )
        .to.be.revertedWithCustomError(dp, "ZeroShare")
        .withArgs(1);
    });

    it("caps batch size so a transaction can never be too big for a block", async function () {
      await dp.setMaxRecipients(2);
      const { required } = await dp.quote(payout, ethers.ZeroAddress);
      await expect(
        dp.distributeNative(
          [alice.address, bob.address, carol.address],
          [333_400, 333_300, 333_300],
          payout,
          ethers.ZeroAddress,
          { value: required }
        )
      )
        .to.be.revertedWithCustomError(dp, "TooManyRecipients")
        .withArgs(3, 2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Partners and admin
  // ═══════════════════════════════════════════════════════════════════════
  describe("partner registry", function () {
    it("an unregistered partner is refused, rather than silently charging the floor", async function () {
      await expect(dp.quote(ethers.parseEther("1"), outsider.address))
        .to.be.revertedWithCustomError(dp, "UnknownPartner")
        .withArgs(outsider.address);
    });

    it("the 5% ceiling is enforced at registration", async function () {
      await expect(dp.setPartner(partner.address, 501)).to.be.reverted;
      await expect(dp.setPartner(partner.address, 199)).to.be.reverted;
      await expect(dp.setPartner(partner.address, 500)).to.not.be.reverted;
      await expect(dp.setPartner(partner.address, 200)).to.not.be.reverted;
    });

    it("only the owner can register partners or move the house address", async function () {
      await expect(dp.connect(outsider).setPartner(partner.address, 300)).to.be.reverted;
      await expect(dp.connect(outsider).setHouseRecipient(outsider.address)).to.be.reverted;
      await expect(dp.connect(outsider).setMaxRecipients(10)).to.be.reverted;
      await expect(dp.connect(outsider).pause()).to.be.reverted;
    });

    it("de-registering a partner blocks further distributions through them", async function () {
      await dp.setPartner(partner.address, 300);
      await expect(dp.quote(ethers.parseEther("1"), partner.address)).to.not.be.reverted;
      await dp.setPartner(partner.address, 0);
      await expect(dp.quote(ethers.parseEther("1"), partner.address)).to.be.revertedWithCustomError(dp, "UnknownPartner");
    });
  });

  describe("pause", function () {
    it("stops distributions and lets them resume", async function () {
      const payout = ethers.parseEther("1");
      const { required } = await dp.quote(payout, ethers.ZeroAddress);

      await dp.pause();
      await expect(
        dp.distributeNative([alice.address], [1_000_000], payout, ethers.ZeroAddress, { value: required })
      ).to.be.reverted;

      await dp.unpause();
      await expect(
        dp.distributeNative([alice.address], [1_000_000], payout, ethers.ZeroAddress, { value: required })
      ).to.not.be.reverted;
    });
  });
});
