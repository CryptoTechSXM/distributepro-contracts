// test/DeployBench.js
//
// DEPLOYMENT COST OF DistributeProV3 — measured, not estimated.
// Written 2026-09-11 for the owner and a future session of Claude.
//
// WHY THIS EXISTS
// ───────────────
// GasBench.js measured the cost of USING the contract (gas per recipient).
// Nobody has ever measured the cost of PUTTING IT ON A CHAIN. That number
// matters more than usual here, for three measured reasons:
//
//   1. BTC20 Smart Chain's block gas limit is 8,000,000 — fixed, confirmed
//      across 40 sampled blocks (brief section 17). That is a QUARTER of
//      Ethereum's 30,000,000. A deploy that is routine elsewhere can be
//      undeployable there.
//   2. V3 is compiled with viaIR: true (brief section 12.1). viaIR changes
//      code generation for the whole project. Its effect on deployed bytecode
//      SIZE has never been checked against EIP-170's 24,576-byte contract
//      limit — exceed it and the deploy reverts after the gas is spent.
//   3. The deploy would be paid in real BTCC on a mainnet that already holds
//      5.85 BTCC of permanently stranded money (brief section 16). Nothing
//      about this chain gets guessed at.
//
// This test only reports. It asserts the two hard protocol limits and
// otherwise prints a table for the deploy decision. Read the numbers.
//
// RUN:  npx hardhat test test/DeployBench.js

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;

// ── Protocol limits ──────────────────────────────────────────────────────
// EIP-170 (Spurious Dragon, 2016): deployed runtime bytecode may not exceed
// 24,576 bytes. Universal on every EVM chain in this config, BTC20 included.
const EIP170_RUNTIME_LIMIT = 24576;

// EIP-3860 (Shanghai, 2023): initcode may not exceed 49,152 bytes. BTC20's
// node is a 2022 build and predates Shanghai, so this does NOT apply there —
// reported for the modern chains only, never asserted.
const EIP3860_INITCODE_LIMIT = 49152;

// ── Measured block gas limits, per chain ─────────────────────────────────
// BTC20: measured by scripts/probe_btc20.js across 40 blocks at a 500-block
// stride — min, median and max all identical at 8,000,000.
// Base Sepolia: the measured per-transaction ceiling, 16,777,216 = 2^24.
// The 30,000,000 chains are the published block limit.
const CHAINS = [
  { name: "BTC20 Smart Chain", limit: 8_000_000, note: "measured, 40 blocks" },
  { name: "Base Sepolia", limit: 16_777_216, note: "measured, 2^24" },
  { name: "Ethereum / Base / BSC", limit: 30_000_000, note: "published" },
];

// Constructor arguments used for the measurement. maxRecipients is a plain
// uint256 in storage, so its VALUE does not change deployment cost — but it
// is set to the section 17.1 recommendation so the number printed is the
// number a real BTC20 deploy would produce.
const HOUSE_PLACEHOLDER_MAX_RECIPIENTS = 250;

function pct(part, whole) {
  return ((part / whole) * 100).toFixed(2) + "%";
}

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}

function padLeft(s, n) {
  s = String(s);
  return " ".repeat(Math.max(0, n - s.length)) + s;
}

describe("DeployBench — what it costs to put DistributeProV3 on a chain", function () {
  this.timeout(120000);

  let house, deployer;
  let factory;
  let runtimeBytes, initcodeBytes, deployGas, deployedAddress;

  before(async function () {
    [deployer, house] = await ethers.getSigners();

    console.log("");
    console.log("  ── measuring ──────────────────────────────────────────────");
    console.log("  compiling / loading artifact for DistributeProV3 ...");

    factory = await ethers.getContractFactory("DistributeProV3");

    // Sizes are measured, not read off a spec sheet. `factory.bytecode` is the
    // INITCODE — constructor logic plus the runtime it returns. The RUNTIME is
    // read back from the chain after deploying, because that is the thing that
    // lives at the address forever and the thing EIP-170 actually limits. Both
    // are 0x-prefixed hex, so one byte is two characters.
    initcodeBytes = (factory.bytecode.length - 2) / 2;

    console.log("  deploying ...");

    const dp = await factory.deploy(house.address, HOUSE_PLACEHOLDER_MAX_RECIPIENTS);
    const receipt = await dp.deploymentTransaction().wait();

    deployGas = Number(receipt.gasUsed);
    deployedAddress = await dp.getAddress();

    const code = await ethers.provider.getCode(deployedAddress);
    runtimeBytes = (code.length - 2) / 2;

    console.log("  done.");
    console.log("");
  });

  it("reports the deployment measurement", async function () {
    console.log("  ┌─ DistributeProV3 — DEPLOYMENT, MEASURED ───────────────────");
    console.log("  │");
    // ⛔ THESE ARE READ FROM THE LIVE CONFIG, NOT TYPED IN.
    //
    // They used to be three hardcoded strings, and on 2026-09-11 that produced
    // an actual lie: viaIR was switched OFF in hardhat.config.js, the suite was
    // re-run, and this block still printed "viaIR true" while reporting gas
    // figures from a non-viaIR build. A bench that states its own settings from
    // a literal is not measuring them — it is asserting them, and it will
    // eventually assert something false at exactly the moment the setting
    // matters. Read the config.
    const comp = hre.config.solidity.compilers[0];
    const st = comp.settings || {};
    const opt = st.optimizer || {};
    console.log(
      `  │  compiler      solc ${comp.version}, optimizer ` +
        `${opt.enabled ? "on" : "OFF"}${opt.enabled ? ` (runs ${opt.runs})` : ""}`
    );
    console.log(`  │  viaIR         ${st.viaIR === true}`);
    console.log(`  │  evmVersion    ${st.evmVersion || "(compiler default)"}`);
    console.log("  │");
    console.log("  │  deployment gas          " + padLeft(deployGas.toLocaleString(), 12));
    console.log("  │  runtime bytecode        " + padLeft(runtimeBytes.toLocaleString() + " B", 12)
      + "   of " + EIP170_RUNTIME_LIMIT.toLocaleString() + " B  (" + pct(runtimeBytes, EIP170_RUNTIME_LIMIT) + " of EIP-170)");
    console.log("  │  initcode                " + padLeft(initcodeBytes.toLocaleString() + " B", 12)
      + "   of " + EIP3860_INITCODE_LIMIT.toLocaleString() + " B  (" + pct(initcodeBytes, EIP3860_INITCODE_LIMIT) + " of EIP-3860)");
    console.log("  │");
    console.log("  └────────────────────────────────────────────────────────────");
    console.log("");

    console.log("  ┌─ DOES THE DEPLOY FIT? ─────────────────────────────────────");
    console.log("  │");
    console.log("  │  " + pad("chain", 24) + pad("block limit", 14) + pad("deploy uses", 13) + "verdict");
    console.log("  │  " + "-".repeat(62));
    for (const c of CHAINS) {
      const share = deployGas / c.limit;
      // A deploy is only comfortable if it leaves the block room to spare.
      // Over 50% of a block is a warning; over 100% is undeployable.
      const verdict =
        share > 1 ? "⛔ DOES NOT FIT"
        : share > 0.5 ? "⚠️  over half a block"
        : "✅ fits comfortably";
      console.log("  │  " + pad(c.name, 24) + pad(c.limit.toLocaleString(), 14)
        + pad(pct(deployGas, c.limit), 13) + verdict);
    }
    console.log("  │");
    console.log("  │  Block-limit figures: BTC20 and Base Sepolia are measured;");
    console.log("  │  the 30,000,000 row is the published limit.");
    console.log("  └────────────────────────────────────────────────────────────");
    console.log("");
  });

  it("fits inside EIP-170 — the 24,576-byte contract size limit", async function () {
    // This is the limit that reverts a deploy AFTER the gas is paid, and the
    // one viaIR could plausibly have pushed us past. Hard assertion.
    expect(runtimeBytes).to.be.lessThan(EIP170_RUNTIME_LIMIT);
  });

  it("fits inside the smallest block we target — BTC20's measured 8,000,000", async function () {
    // If this ever fails, DistributeProV3 cannot be deployed to BTC20 at all
    // and the design has to change (a smaller contract, or libraries deployed
    // separately and linked). Hard assertion, so it can never pass silently.
    expect(deployGas).to.be.lessThan(8_000_000);
  });

  it("reports the cost of the post-deploy setup transactions", async function () {
    // A deploy is not finished at the constructor. These are the owner
    // transactions that follow it, and on a chain paying real BTCC every one
    // of them costs money. Measured so the deploy runbook can state a total.
    const dp = factory.attach(deployedAddress);

    const steps = [];

    const r1 = await (await dp.setPartner(house.address, 500)).wait();
    steps.push(["setPartner(addr, 500)  — register a partner at 5%", Number(r1.gasUsed)]);

    const r2 = await (await dp.setMaxRecipients(249)).wait();
    steps.push(["setMaxRecipients(249)  — retune the batch cap", Number(r2.gasUsed)]);

    const r3 = await (await dp.pause()).wait();
    steps.push(["pause()                — emergency stop", Number(r3.gasUsed)]);

    const r4 = await (await dp.unpause()).wait();
    steps.push(["unpause()", Number(r4.gasUsed)]);

    console.log("  ┌─ POST-DEPLOY OWNER TRANSACTIONS ───────────────────────────");
    console.log("  │");
    let total = 0;
    for (const [label, gas] of steps) {
      total += gas;
      console.log("  │  " + pad(label, 48) + padLeft(gas.toLocaleString(), 9));
    }
    console.log("  │  " + "-".repeat(57));
    console.log("  │  " + pad("total, if all four are run", 48) + padLeft(total.toLocaleString(), 9));
    console.log("  │");
    console.log("  │  Each is a separate transaction. None is required by the");
    console.log("  │  constructor — house recipient and maxRecipients are both");
    console.log("  │  set there. setPartner is the only one a launch needs, and");
    console.log("  │  only if a partner exists on day one.");
    console.log("  └────────────────────────────────────────────────────────────");
    console.log("");

    console.log("  ┌─ COST IN BTCC, at the measured 1 gwei gas price ───────────");
    console.log("  │");
    const gwei = 1e-9;
    console.log("  │  deploy                 " + padLeft((deployGas * gwei).toFixed(6), 12) + " BTCC");
    console.log("  │  setPartner             " + padLeft((steps[0][1] * gwei).toFixed(6), 12) + " BTCC");
    console.log("  │  ────────────────────────────────────────");
    console.log("  │  launch total           " + padLeft(((deployGas + steps[0][1]) * gwei).toFixed(6), 12) + " BTCC");
    console.log("  │");
    console.log("  │  1 gwei is the gasPrice measured by scripts/probe_btc20.js.");
    console.log("  │  BTC20 has NO EIP-1559 fee market (no baseFeePerGas in the");
    console.log("  │  header), so this is a flat legacy price, not a base fee");
    console.log("  │  that moves with congestion.");
    console.log("  └────────────────────────────────────────────────────────────");
    console.log("");
  });

  it("confirms FeeSchedule is inlined and needs no separate deployment", async function () {
    // FeeSchedule.sol is a library whose functions are all `internal`. solc
    // inlines those into the calling contract rather than emitting a separate
    // library to be deployed and linked. If that ever changed — someone makes
    // a function `public` — the deploy becomes a TWO-transaction affair with a
    // link step, and the deploy script would silently be wrong.
    //
    // The check: a factory for a contract needing a link carries unresolved
    // placeholders of the form __$...$__ in its bytecode.
    const bytecode = factory.bytecode;
    const hasLinkPlaceholder = /__\$[0-9a-fA-F]{34}\$__/.test(bytecode);

    console.log("  library link placeholders in bytecode: "
      + (hasLinkPlaceholder ? "PRESENT — a separate library deploy IS required" : "none — fully inlined, single-transaction deploy"));
    console.log("");

    expect(hasLinkPlaceholder).to.equal(false);
  });
});
