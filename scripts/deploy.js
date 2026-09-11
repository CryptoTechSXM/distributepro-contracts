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

require("dotenv").config();
const hre = require("hardhat");
const fs = require("fs");

const networks = [
  "ethereum",
  "sepolia",
  "bsc",
  "polygon",
  "base",
  "avalanche",
  "btc20"
];

async function main() {
  let results = {};

  for (const net of networks) {
    console.log(`\n🌍 Deploying to: ${net}`);

    try {
      await hre.changeNetwork(net); // ✅ use our custom changeNetwork util

      const DistributePro = await hre.ethers.getContractFactory("DistributePro");
      const distributePro = await DistributePro.deploy();
      await distributePro.waitForDeployment();

      const address = await distributePro.getAddress();
      console.log(`✅ Deployed DistributePro on ${net}: ${address}`);

      // Save result
      results[net] = { address };

      // Try verifying if API key exists
      const apiKey = hre.config.etherscan.apiKey[net];
      if (apiKey) {
        console.log(`⏳ Verifying contract on ${net} explorer...`);
        try {
          await hre.run("verify:verify", {
            address,
            constructorArguments: [],
          });
          console.log(`🎉 Verified on ${net}!`);
          results[net].verified = true;
        } catch (err) {
          console.warn(`⚠️ Verification failed on ${net}: ${err.message}`);
          results[net].verified = false;
        }
      } else {
        console.log(`⚠️ No API key for ${net}, skipping verification.`);
        results[net].verified = false;
      }
    } catch (err) {
      console.error(`❌ Deployment failed on ${net}: ${err.message}`);
      results[net] = { error: err.message };
    }
  }

  // Write deployed addresses
  fs.writeFileSync("deployed-contracts.json", JSON.stringify(results, null, 2));
  console.log(`\n✅ Deployment results saved in deployed-contracts.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

─── end of preserved original ─── */
