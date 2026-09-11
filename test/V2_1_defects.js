/**
 * V2_1_defects.js — THE INSTRUMENT
 *
 * Written for the owner and a future session of Claude. Nobody else touches
 * this code. 2026-09-11.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS FOR
 *
 * docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md section 2 lists six defects in the
 * current contract. Those are findings from READING code. They have never
 * been run. Per the standing rule — build the instrument before the fix, and
 * a number that has not been run is not a result — this file turns each
 * written finding into a measured one.
 *
 * ⚠️ READ THIS BEFORE YOU PANIC AT THE OUTPUT:
 *
 *   ALL OF THESE TESTS ARE SUPPOSED TO PASS.
 *
 * Green here does NOT mean the contract is healthy. It means the opposite:
 * each test asserts that a specific defect IS REAL and reproducible. Green
 * means "the audit was right". Red would mean the audit was wrong about that
 * item and the brief needs correcting.
 *
 * When V3 is written, these tests get replaced by test/V3_spec.js, which
 * asserts the correct behaviour instead. The mocks in contracts/mocks/ carry
 * forward unchanged — they are the permanent part.
 * ─────────────────────────────────────────────────────────────────────────
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DistributePro V2.1 — measured defects", function () {
  let owner, feeRecipient, alice, bob, attacker;
  let dp, dpAddr;

  beforeEach(async function () {
    [owner, feeRecipient, alice, bob, attacker] = await ethers.getSigners();
    const F = await ethers.getContractFactory("DistributePro");
    dp = await F.deploy(feeRecipient.address);
    await dp.waitForDeployment();
    dpAddr = await dp.getAddress();
  });

  // ───────────────────────────────────────────────────────────────────────
  // D1 — section 2.1: the fee taper is decimals-blind
  // ───────────────────────────────────────────────────────────────────────
  it("D1: charges a DIFFERENT fee rate for the same nominal amount, purely because of token decimals", async function () {
    const oneMillion6dp = ethers.parseUnits("1000000", 6);   // 1,000,000 USDC
    const oneMillion18dp = ethers.parseUnits("1000000", 18); // 1,000,000 DAI

    const fee6 = await dp.calculateFee(oneMillion6dp);
    const fee18 = await dp.calculateFee(oneMillion18dp);

    const rate6 = (fee6 * 10000n) / oneMillion6dp;
    const rate18 = (fee18 * 10000n) / oneMillion18dp;

    console.log(`      1,000,000 of a 6-decimal token  -> ${Number(rate6) / 100}% fee`);
    console.log(`      1,000,000 of an 18-decimal token -> ${Number(rate18) / 100}% fee`);

    // The bug: identical business transactions, different fee, decided by decimals.
    expect(rate6).to.not.equal(rate18);
    expect(rate6).to.equal(200n); // stablecoins always pay the 2% maximum
    expect(rate18).to.equal(50n); // and the taper only ever fires for 18-decimal tokens
  });

  it("D1b: the taper NEVER fires for a realistic stablecoin distribution", async function () {
    // 10 million USDC — a large real-world batch.
    const huge = ethers.parseUnits("10000000", 6);
    const fee = await dp.calculateFee(huge);
    const rate = (fee * 10000n) / huge;
    console.log(`      10,000,000 USDC -> ${Number(rate) / 100}% fee (taper floor is 0.5%)`);
    expect(rate).to.equal(200n); // flat maximum, taper is dead code
  });

  // ───────────────────────────────────────────────────────────────────────
  // D2 — section 2.2: processToken trusts a caller-supplied `total`
  // ───────────────────────────────────────────────────────────────────────
  it("D2: a caller can understate `total` and drain tokens the contract already holds", async function () {
    const T = await ethers.getContractFactory("MockUSDC6");
    const token = await T.deploy(ethers.parseUnits("10000000", 6));
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();

    // Simulate a contract that is holding a balance — dust, an overpayment,
    // or another user's funds mid-flight. THIS is what the owner's
    // "never hold third-party funds" rule exists to prevent.
    const seeded = ethers.parseUnits("50000", 6);
    await token.transfer(dpAddr, seeded);

    // The attacker funds themselves with a small amount.
    const honestTotal = ethers.parseUnits("100", 6);
    const fee = await dp.calculateFee(honestTotal);
    await token.transfer(attacker.address, honestTotal + fee);
    await token.connect(attacker).approve(dpAddr, honestTotal + fee);

    const attackerBefore = await token.balanceOf(attacker.address);
    const contractBefore = await token.balanceOf(dpAddr);

    // They declare `total` = 100, but ask to be paid 10,000.
    const claimed = ethers.parseUnits("10000", 6);
    await dp.connect(attacker).processToken(
      tokenAddr,
      [attacker.address],
      [claimed],
      honestTotal            // ⛔ never checked against sum(amounts)
    );

    const attackerAfter = await token.balanceOf(attacker.address);
    const contractAfter = await token.balanceOf(dpAddr);

    const gained = attackerAfter - attackerBefore;
    const drained = contractBefore - contractAfter;

    console.log(`      attacker paid in : ${ethers.formatUnits(honestTotal + fee, 6)}`);
    console.log(`      attacker took out: ${ethers.formatUnits(claimed, 6)}`);
    console.log(`      net gain         : ${ethers.formatUnits(gained, 6)} USDC`);
    console.log(`      drained from contract: ${ethers.formatUnits(drained, 6)} USDC`);

    expect(gained).to.be.greaterThan(0n); // free money
    expect(drained).to.be.greaterThan(0n); // taken from the held balance
  });

  // ───────────────────────────────────────────────────────────────────────
  // D3 — section 2.3: .transfer() bricks any batch containing a contract wallet
  // ───────────────────────────────────────────────────────────────────────
  it("D3: ONE smart-contract wallet in the list kills the entire distribution", async function () {
    const W = await ethers.getContractFactory("MockContractWallet");
    const wallet = await W.deploy();
    await wallet.waitForDeployment();
    const walletAddr = await wallet.getAddress();

    const each = ethers.parseEther("1");
    const total = each * 3n;
    const fee = await dp.calculateFee(total);

    // Two ordinary wallets and one Safe-like contract wallet.
    await expect(
      dp.connect(owner).processETH(
        [alice.address, walletAddr, bob.address],
        [each, each, each],
        { value: total + fee }
      )
    ).to.be.reverted;

    // And prove the same batch works once the contract wallet is removed.
    const total2 = each * 2n;
    const fee2 = await dp.calculateFee(total2);
    await expect(
      dp.connect(owner).processETH(
        [alice.address, bob.address],
        [each, each],
        { value: total2 + fee2 }
      )
    ).to.not.be.reverted;
  });

  // ───────────────────────────────────────────────────────────────────────
  // D4 — section 2.5: real mainnet USDT reverts every time
  // ───────────────────────────────────────────────────────────────────────
  it("D4: a non-compliant USDT (no bool returned) reverts — and the repo's own MockUSDT hides this", async function () {
    const U = await ethers.getContractFactory("MockUSDTNonCompliant");
    const usdt = await U.deploy(ethers.parseUnits("1000000", 6));
    await usdt.waitForDeployment();
    const usdtAddr = await usdt.getAddress();

    const total = ethers.parseUnits("1000", 6);
    const fee = await dp.calculateFee(total);
    await usdt.approve(dpAddr, total + fee);

    await expect(
      dp.processToken(usdtAddr, [alice.address], [total], total)
    ).to.be.reverted;

    // The control: the repo's existing MockUSDT is a plain OZ ERC20, so it
    // returns a bool and sails through. This is the false green that would
    // have shipped a contract that cannot touch mainnet USDT.
    const M = await ethers.getContractFactory("MockUSDT");
    const good = await M.deploy("Mock Tether", "USDT", ethers.parseUnits("1000000", 6));
    await good.waitForDeployment();
    const goodAddr = await good.getAddress();
    await good.approve(dpAddr, total + fee);

    await expect(
      dp.processToken(goodAddr, [alice.address], [total], total)
    ).to.not.be.reverted;
  });

  // ───────────────────────────────────────────────────────────────────────
  // D5 — section 2.6: ETH overpayment is locked in forever
  // ───────────────────────────────────────────────────────────────────────
  it("D5: overpaid ETH is stranded in the contract with no way to retrieve it", async function () {
    const total = ethers.parseEther("1");
    const fee = await dp.calculateFee(total);
    const overpay = ethers.parseEther("0.5");

    await dp.connect(owner).processETH(
      [alice.address],
      [total],
      { value: total + fee + overpay }   // require() is >=, so this is accepted
    );

    const stuck = await ethers.provider.getBalance(dpAddr);
    console.log(`      stranded in contract: ${ethers.formatEther(stuck)} ETH`);
    expect(stuck).to.equal(overpay);

    // And there is no exit. No withdraw, no sweep, no rescue, no receive().
    const fns = dp.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name.toLowerCase());
    const escapeHatch = fns.some((n) =>
      ["withdraw", "sweep", "rescue", "recover", "claim"].some((w) => n.includes(w))
    );
    console.log(`      functions on contract: ${fns.join(", ")}`);
    expect(escapeHatch, "found an escape hatch — brief section 2.6 needs correcting").to.equal(false);
  });

  // ───────────────────────────────────────────────────────────────────────
  // D6 — section 2.7: fee-on-transfer tokens cannot be distributed at all
  // ───────────────────────────────────────────────────────────────────────
  it("D6: a fee-on-transfer token makes the distribution fail", async function () {
    const F = await ethers.getContractFactory("MockFeeOnTransfer");
    const fot = await F.deploy(100, ethers.parseEther("1000000")); // 1% tax
    await fot.waitForDeployment();
    const fotAddr = await fot.getAddress();

    const total = ethers.parseEther("1000");
    const fee = await dp.calculateFee(total);
    await fot.approve(dpAddr, total + fee);

    // V3 requirement: this must fail FAST and LEGIBLY, with a named error at
    // a balance-delta check — not deep inside the payout loop after the fee
    // recipient has already been paid. Diagnosability is the V3 spec here.
    await expect(
      dp.processToken(fotAddr, [alice.address], [total], total)
    ).to.be.reverted;
  });

  // ───────────────────────────────────────────────────────────────────────
  // D7 — section 2.9: address(0) is never checked, so funds burn silently
  // ───────────────────────────────────────────────────────────────────────
  it("D7: a zero-address recipient silently BURNS the money instead of reverting", async function () {
    const amount = ethers.parseEther("1");
    const fee = await dp.calculateFee(amount);

    const burnedBefore = await ethers.provider.getBalance(ethers.ZeroAddress);

    // No revert. A single bad CSV row and the money is gone.
    await expect(
      dp.connect(owner).processETH([ethers.ZeroAddress], [amount], { value: amount + fee })
    ).to.not.be.reverted;

    const burnedAfter = await ethers.provider.getBalance(ethers.ZeroAddress);
    console.log(`      burned to address(0): ${ethers.formatEther(burnedAfter - burnedBefore)} ETH`);
    expect(burnedAfter - burnedBefore).to.equal(amount);
  });
});
