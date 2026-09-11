// ═══════════════════════════════════════════════════════════════════
//  ⛔⛔ RETIRED — THIS SCRIPT IS DISABLED. DO NOT RE-ENABLE IT.
// ═══════════════════════════════════════════════════════════════════
//  Written by an early session, kept only so the history is legible.
//  Neutralised 2026-09-11. TWO independent reasons, either one fatal:
//
//   1. IT DEPLOYS THE WRONG CONTRACT. It deploys `DistributePro` —
//      V2.1 — which is the DEFECTIVE contract the whole V3 rewrite
//      exists to replace. Its confirmed defects include a caller-
//      supplied `total` an attacker can drain (an attacker paid 102
//      USDC and took out 10,000) and ETH overpayment that is
//      PERMANENTLY STRANDED with no exit function. Running this
//      would put that on a mainnet, and it lists SEVEN of them.
//
//   2. IT CANNOT WORK ANYWAY. `hre.changeNetwork()` is not a
//      function in this Hardhat version. It never ran successfully;
//      the localhost-addresses-under-mainnet-names in
//      deployed-contracts.json / multi-deploy-results.json are the
//      residue of it failing.
//
//  ▶ THE REAL DEPLOY SCRIPT IS `scripts/deploy_v3.js`.
//    One `--network` per invocation, five refusal conditions checked
//    BEFORE signing, and it reads the deployed state back off the
//    chain. See docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md §18.
//
//  The original body is preserved below, unreachable.
// ═══════════════════════════════════════════════════════════════════
console.error("");
console.error("  \u26d4 scripts/%s is RETIRED and will not run.", require("path").basename(__filename));
console.error("     It deploys the DEFECTIVE V2.1 contract, and its");
console.error("     hre.changeNetwork() call does not exist in this Hardhat.");
console.error("");
console.error("  \u25b6 Use:  npx hardhat run scripts/deploy_v3.js --network <chain>");
console.error("");
process.exit(1);

/* ─── original body below, kept for the record, never reached ───

// scripts/deploy-multi.js
require("dotenv").config();
const hre = require("hardhat");
const readline = require("readline");

const networks = [
  "ethereum",
  "sepolia",
  "bsc",
  "polygon",
  "base",
  "avalanche",
  "btc20",
];

async function askContinue(network) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`👉 Deploy to ${network}? (y/n): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  const results = {};

  for (const network of networks) {
    console.log(`\n🌍 Checking network: ${network}`);

    // Confirm with user before deploying
    const proceed = await askContinue(network);
    if (!proceed) {
      console.log(`⏩ Skipping ${network}`);
      continue;
    }

    try {
      // Switch network
      hre.changeNetwork(network);
      const [deployer] = await hre.ethers.getSigners();

      console.log(`🔑 Deployer: ${deployer.address}`);

      if (dryRun) {
        console.log(`🧪 Dry-run → estimating gas on ${network}...`);
        const Factory = await hre.ethers.getContractFactory("DistributePro");
        const gasEstimate = await Factory.signer.estimateGas(
          Factory.getDeployTransaction(process.env.FEE_RECIPIENT)
        );
        console.log(`⛽ Estimated gas on ${network}: ${gasEstimate}`);
        results[network] = { gasEstimate: gasEstimate.toString() };
      } else {
        console.log(`🚀 Deploying DistributePro to ${network}...`);
        const Factory = await hre.ethers.getContractFactory("DistributePro");
        const contract = await Factory.deploy(process.env.FEE_RECIPIENT);
        await contract.deployed();
        console.log(`✅ DistributePro deployed at: ${contract.address}`);
        results[network] = { address: contract.address };
      }
    } catch (err) {
      console.error(`❌ Error on ${network}:`, err.message);
      results[network] = { error: err.message };
    }
  }

  // Save results
  const fs = require("fs");
  fs.writeFileSync("deployed-contracts.json", JSON.stringify(results, null, 2));
  console.log(`\n✅ Results saved in deployed-contracts.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

─── end of preserved original ─── */
