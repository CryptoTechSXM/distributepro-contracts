// scripts/deploy_v3.js
//
// DEPLOY DistributeProV3 — one chain per invocation, deliberately.
// Written 2026-09-11 for the owner and a future session of Claude.
//
// RUN:
//   npx hardhat run scripts/deploy_v3.js --network btc20
//
// ⛔ WHY NOT A MULTI-CHAIN SCRIPT. The repo already had one —
// `scripts/deploy-multichain.js` — and it never deployed anything: it failed
// with "hre.changeNetwork is not a function" on every network, because that
// is an API from a plugin that was never installed. Its output file
// (`deployed-contracts.json`) is seven error entries, and
// `multi-deploy-results.json` is seven Hardhat LOCALHOST addresses labelled
// with mainnet names. That file fooled an audit into concluding this project
// had never been deployed — while V1.0 was live on BTC20 holding real money.
//
// One `--network` per invocation is slower and completely auditable. Keep it.
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS SCRIPT REFUSES TO DO
//
//   - deploy without HOUSE_RECIPIENT explicitly set (no silent fallback to
//     the deployer — this is where Crypto Counsel's fee goes forever)
//   - deploy to a chain whose live chainId does not match what this script
//     expects for that network name
//   - deploy to a chain it has no maxRecipients entry for
//   - deploy to a MAINNET without CONFIRM=yes
//   - deploy with a balance too small to pay for it
//
// Every one of those is checked BEFORE a transaction is signed.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

// ─────────────────────────────────────────────────────────────────────────
// PER-CHAIN SETTINGS
//
// maxRecipients — see brief section 17.1. This is NOT the precision
// instrument it was originally designed to be, and the reason is measured:
//
//   - GasBench: 36,021 gas per BRAND-NEW native recipient (each carries a
//     25,000-gas account creation).
//   - The owner's REAL live transaction on BTC20: 159 recipients,
//     1,502,693 gas = 9,451 per recipient, because his payees ALREADY EXIST.
//   - Ratio 3.81x. At 50% of an 8,000,000 block, a cap safe for all-new
//     addresses is 111 — which would REJECT the 159-recipient batches that
//     succeed on-chain today. A regression from V1.
//
// So no single number is both safe and permissive. maxRecipients became a
// cheap BACKSTOP against absurd input (it reverts inside _validate() before
// a single transfer, so it costs almost nothing), and the real safety
// mechanism is the FRONTEND chunking by eth_estimateGas.
//
// ⛔ And chunking is confirmed product policy, in the owner's words:
// "we cannot tell someone with 500 transactions or 5000 transactions we are
// not capable of doing the transaction for them." maxRecipients is a
// per-transaction batch size, never a product limit.
//
// expectedChainId — the real guard in this file. A wrong RPC in .env, or a
// provider quietly failing over, is how a contract ends up on a chain nobody
// meant to touch. Checked live against eth_chainId before anything is signed.
// ─────────────────────────────────────────────────────────────────────────
const CHAINS = {
  btc20: {
    expectedChainId: 963,
    maxRecipients: 250,
    isMainnet: true,
    explorer: "https://scan.bitcoincode.technology",
    // MEASURED by scripts/probe_btc20.js: no baseFeePerGas in the block
    // header, so this chain has NO EIP-1559 fee market and every transaction
    // must be legacy type-0. hardhat.config.js forces that by pinning a
    // gasPrice on this network; this script verifies the pinned value still
    // matches what the chain is actually quoting.
    legacyOnly: true,
  },
  base: {
    expectedChainId: 8453,
    maxRecipients: 400,
    isMainnet: true,
    explorer: "https://basescan.org",
    legacyOnly: false,
  },
  ethereum: {
    expectedChainId: 1,
    maxRecipients: 400,
    isMainnet: true,
    explorer: "https://etherscan.io",
    legacyOnly: false,
  },
  bsc: {
    expectedChainId: 56,
    maxRecipients: 400,
    isMainnet: true,
    explorer: "https://bscscan.com",
    legacyOnly: false,
  },
  polygon: {
    expectedChainId: 137,
    maxRecipients: 400,
    isMainnet: true,
    explorer: "https://polygonscan.com",
    legacyOnly: false,
  },
  avalanche: {
    expectedChainId: 43114,
    maxRecipients: 400,
    isMainnet: true,
    explorer: "https://snowtrace.io",
    legacyOnly: false,
  },
  sepolia: {
    expectedChainId: 11155111,
    maxRecipients: 300,
    isMainnet: false,
    explorer: "https://sepolia.etherscan.io",
    legacyOnly: false,
  },
  // Local Hardhat chain, so a full dry run of THIS SCRIPT is possible
  // without spending anything. Use it before every real deploy.
  hardhat: {
    expectedChainId: 31337,
    maxRecipients: 250,
    isMainnet: false,
    explorer: null,
    legacyOnly: false,
  },
  localhost: {
    expectedChainId: 31337,
    maxRecipients: 250,
    isMainnet: false,
    explorer: null,
    legacyOnly: false,
  },
};

function line(char = "─", n = 66) {
  return char.repeat(n);
}

function say(msg = "") {
  console.log(msg);
}

function fail(msg) {
  say("");
  say("⛔ REFUSING TO DEPLOY");
  say("   " + msg);
  say("");
  process.exit(1);
}

async function main() {
  const netName = hre.network.name;

  say("");
  say(line("═"));
  say("  DistributeProV3 — DEPLOY");
  say(line("═"));
  say("");

  // ── 1. Do we know this chain at all? ───────────────────────────────────
  const cfg = CHAINS[netName];
  if (!cfg) {
    fail(
      `No settings for network "${netName}".\n   ` +
        `Known networks: ${Object.keys(CHAINS).join(", ")}\n   ` +
        `Add an entry to CHAINS in this script — including a measured\n   ` +
        `maxRecipients — before deploying somewhere new.`
    );
  }

  // ── 2. Is the chain on the other end the chain we think it is? ─────────
  say("  [1/7] verifying chain identity ...");
  const net = await ethers.provider.getNetwork();
  const liveChainId = Number(net.chainId);
  if (liveChainId !== cfg.expectedChainId) {
    fail(
      `Network "${netName}" is expected to be chainId ${cfg.expectedChainId},\n   ` +
        `but the RPC answered ${liveChainId}.\n   ` +
        `Either the RPC URL in hardhat.config.js / .env is wrong, or the\n   ` +
        `provider failed over to a different chain. Do NOT deploy.`
    );
  }
  say(`        chainId ${liveChainId} ✓ matches expected for "${netName}"`);

  // ── 3. Where does the fee go? No silent default. ───────────────────────
  say("  [2/7] checking house recipient ...");
  const house = process.env.HOUSE_RECIPIENT;
  if (!house) {
    fail(
      `HOUSE_RECIPIENT is not set.\n   ` +
        `This is the address that receives Crypto Counsel's share of every\n   ` +
        `distribution, forever. It is deliberately NOT defaulted to the\n   ` +
        `deployer — that would be a silent, permanent decision.\n   ` +
        `Set it in .env:  HOUSE_RECIPIENT=0x...`
    );
  }
  let houseAddr;
  try {
    houseAddr = ethers.getAddress(house); // throws on a malformed address
  } catch (e) {
    fail(`HOUSE_RECIPIENT is not a valid address: "${house}"`);
  }
  if (houseAddr === ethers.ZeroAddress) {
    fail("HOUSE_RECIPIENT is the zero address.");
  }
  say(`        house recipient  ${houseAddr}`);

  // ── 4. Who is paying, and can they afford it? ──────────────────────────
  say("  [3/7] checking deployer ...");
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  say(`        deployer         ${deployer.address}`);
  say(`        balance          ${ethers.formatEther(balance)}`);

  // ⛔ THE DEPLOYER BECOMES THE OWNER. Guard added 2026-09-11, and the reason
  // is a real near-miss rather than a precaution.
  //
  // WHAT HAPPENED: the first BTC20 dry run printed deployer
  // 0x94AC62B7fCCa058dED1B69ee7499FC8F5183744d — an address the owner did not
  // recognise, holding 0 BTCC, almost certainly a leftover test key written
  // into .env by an earlier session. Nothing was lost (that wallet was empty
  // and the key was abandoned), but had the balance check not stopped the
  // run, this contract's owner — the only address that can pause it, register
  // partners, move the house recipient or rescue stranded assets — would have
  // been a key of unconfirmed provenance.
  //
  // Reading the address off the screen is not a control; a control is
  // something that REFUSES. Set EXPECTED_DEPLOYER in .env and the script
  // stops dead if the key behind PRIVATE_KEY is not the one you think.
  //
  // ⛔ Claude never reads .env and never handles the private key. This check
  // compares only the PUBLIC address the key derives to.
  const expectedDeployer = process.env.EXPECTED_DEPLOYER;
  if (expectedDeployer) {
    let expected;
    try {
      expected = ethers.getAddress(expectedDeployer);
    } catch (e) {
      fail(`EXPECTED_DEPLOYER is not a valid address: "${expectedDeployer}"`);
    }
    if (expected !== deployer.address) {
      fail(
        `DEPLOYER MISMATCH.\n   ` +
          `   expected  ${expected}\n   ` +
          `   actual    ${deployer.address}\n   ` +
          `The PRIVATE_KEY in .env does not belong to the wallet you expect.\n   ` +
          `The deployer becomes this contract's OWNER, so this is not a\n   ` +
          `formality. Fix PRIVATE_KEY (never paste a private key into a chat,\n   ` +
          `a commit, or a support ticket) and run the dry run again.`
      );
    }
    say(`        ✓ matches EXPECTED_DEPLOYER`);
  } else {
    say(`        ⚠️  EXPECTED_DEPLOYER not set — the deployer's identity is`);
    say(`            unchecked. Set it in .env to have this script REFUSE a`);
    say(`            wrong key instead of relying on you reading this line.`);
  }

  // ── 5. What will it cost? Estimated live, on this chain. ───────────────
  say("  [4/7] estimating cost on this chain ...");
  const factory = await ethers.getContractFactory("DistributeProV3");

  const feeData = await ethers.provider.getFeeData();
  const gasPrice = feeData.gasPrice; // legacy price; present on every chain

  // Estimate the deploy against the real node rather than reusing the local
  // bench figure — a different EVM implementation can price it differently.
  const deployTx = await factory.getDeployTransaction(houseAddr, cfg.maxRecipients);
  let gasEstimate;
  try {
    gasEstimate = await ethers.provider.estimateGas({
      from: deployer.address,
      data: deployTx.data,
    });
  } catch (e) {
    fail(
      `Could not estimate deployment gas on this chain.\n   ` +
        `The node rejected the estimate: ${e.shortMessage || e.message}\n   ` +
        `That usually means the chain will not accept this bytecode.`
    );
  }

  const cost = gasEstimate * gasPrice;
  say(`        gas estimate     ${gasEstimate.toString()}`);
  say(`        gas price        ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  say(`        estimated cost   ${ethers.formatEther(cost)}`);

  // ⚠️ NOTE THE ORDERING, IT IS DELIBERATE (fixed 2026-09-11 after the first
  // dry run). An insufficient balance is only fatal when we are actually
  // about to deploy — it is enforced further down, past the mainnet gate.
  //
  // WHY: running this script against a mainnet WITHOUT CONFIRM=yes is a free,
  // read-only dry run — it reaches the gate and stops without signing
  // anything. That dry run is the only way to learn, before spending, whether
  // the real node accepts this bytecode (the estimate above is the proof) and
  // whether the legacy type-0 pin is right. Failing here on an unfunded
  // deployer would abort the dry run before either of those checks ran, which
  // is backwards: you want the answers BEFORE you fund the wallet.
  const underfunded = balance < cost;
  if (underfunded) {
    say("");
    say(`        ⚠️  balance ${ethers.formatEther(balance)} is BELOW the estimated`);
    say(`            cost ${ethers.formatEther(cost)}. The dry run continues, but`);
    say(`            an actual deploy will be refused until this is funded.`);
    say("");
  }

  // ── 6. The EIP-1559 trap on old chains. ────────────────────────────────
  say("  [5/7] checking transaction type ...");
  if (cfg.legacyOnly) {
    // MEASURED: BTC20's block header has no baseFeePerGas, so the chain does
    // not run the EIP-1559 fee market. Ethers and Hardhat prefer type-2
    // transactions wherever a chain appears to support them; sending one here
    // gets it rejected outright. hardhat.config.js pins a gasPrice on this
    // network, which is what forces ethers back to legacy type-0.
    const configured = hre.network.config.gasPrice;
    if (!configured || configured === "auto") {
      fail(
        `Network "${netName}" has NO EIP-1559 fee market (measured: no\n   ` +
          `baseFeePerGas in its block headers), so every transaction must be\n   ` +
          `legacy type-0. That is forced by pinning a gasPrice on this network\n   ` +
          `in hardhat.config.js, and it is currently not set.\n   ` +
          `Without it, ethers will send a type-2 transaction and the node will\n   ` +
          `reject it.`
      );
    }
    say(`        legacy type-0 forced via pinned gasPrice: ${ethers.formatUnits(configured, "gwei")} gwei`);

    // A pinned price that no longer matches the chain is how a transaction
    // sits unmined forever. Warn loudly; do not block — the owner may be
    // pinning a higher price deliberately.
    if (BigInt(configured) !== gasPrice) {
      say("");
      say(`        ⚠️  the pinned gasPrice (${ethers.formatUnits(configured, "gwei")} gwei) does NOT match`);
      say(`            what the chain is quoting (${ethers.formatUnits(gasPrice, "gwei")} gwei).`);
      say(`            Too low and the transaction may never be mined.`);
      say("");
    }
  } else {
    say(`        standard (chain supports EIP-1559 or hardhat will pick)`);
  }

  // ── 7. Mainnet gate. ───────────────────────────────────────────────────
  say("  [6/7] checking mainnet confirmation ...");
  if (cfg.isMainnet && process.env.CONFIRM !== "yes") {
    say("");
    say(line());
    say(`  "${netName}" is a MAINNET. Real money.`);
    say("");
    say("  About to deploy with:");
    say(`     house recipient   ${houseAddr}`);
    say(`     maxRecipients     ${cfg.maxRecipients}`);
    say(`     deployer          ${deployer.address}`);
    say(`     estimated cost    ${ethers.formatEther(cost)}`);
    say("");
    say("  Read those four lines. If they are right, run again with CONFIRM=yes:");
    say("");
    say(`     CONFIRM=yes npx hardhat run scripts/deploy_v3.js --network ${netName}`);
    say("");
    say("  (PowerShell:  $env:CONFIRM=\"yes\"; npx hardhat run scripts/deploy_v3.js --network " + netName + ")");
    say(line());
    say("");
    process.exit(0);
  }
  say("        ok");

  // Now that we are genuinely about to spend, an unfunded deployer is fatal.
  if (underfunded) {
    fail(
      `Deployer balance ${ethers.formatEther(balance)} is less than the\n   ` +
        `estimated cost ${ethers.formatEther(cost)}. Fund the deployer first.`
    );
  }

  // ── DEPLOY ─────────────────────────────────────────────────────────────
  say("  [7/7] deploying ... (this can take a minute — do not close the window)");
  say("");

  const contract = await factory.deploy(houseAddr, cfg.maxRecipients);
  const tx = contract.deploymentTransaction();
  say(`        tx sent:  ${tx.hash}`);
  say(`        type:     ${tx.type === 0 ? "0 (legacy) ✓" : tx.type}`);
  say(`        waiting for the receipt ...`);

  const receipt = await tx.wait();
  const address = await contract.getAddress();

  say("");
  say(line("═"));
  say("  ✅ DEPLOYED");
  say(line("═"));
  say(`  address          ${address}`);
  say(`  tx               ${receipt.hash}`);
  say(`  block            ${receipt.blockNumber}`);
  say(`  gas used         ${receipt.gasUsed.toString()}`);
  say(`  actual cost      ${ethers.formatEther(receipt.gasUsed * gasPrice)}`);
  say("");

  // ── Read the state back OFF THE CHAIN. ─────────────────────────────────
  // Not from the arguments we passed in — from the deployed contract. A
  // constructor that silently did something else is exactly the kind of thing
  // that only shows up when you look.
  say("  verifying deployed state by reading it back from the chain ...");
  const onChainHouse = await contract.houseRecipient();
  const onChainMax = await contract.maxRecipients();
  const onChainOwner = await contract.owner();
  const onChainLimit = await contract.MAX_RECIPIENTS_LIMIT();
  const onChainPaused = await contract.paused();

  say(`     houseRecipient        ${onChainHouse}` + (onChainHouse === houseAddr ? "  ✓" : "  ⛔ MISMATCH"));
  say(`     maxRecipients         ${onChainMax}` + (Number(onChainMax) === cfg.maxRecipients ? "  ✓" : "  ⛔ MISMATCH"));
  say(`     owner                 ${onChainOwner}` + (onChainOwner === deployer.address ? "  ✓" : "  ⛔ MISMATCH"));
  say(`     MAX_RECIPIENTS_LIMIT  ${onChainLimit}`);
  say(`     paused                ${onChainPaused}`);
  say("");

  if (onChainHouse !== houseAddr || Number(onChainMax) !== cfg.maxRecipients) {
    say("  ⛔ The deployed state does not match what was requested. Do not use");
    say("     this address. Investigate before anything else.");
    say("");
    process.exit(1);
  }

  // ── Record it. ─────────────────────────────────────────────────────────
  // One file per network, never a combined file. The combined file is what
  // made deployed-contracts.json unreadable and misleading.
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  const recordPath = path.join(dir, `${netName}.json`);

  const record = {
    contract: "DistributeProV3",
    network: netName,
    chainId: liveChainId,
    address,
    deployer: deployer.address,
    houseRecipient: onChainHouse,
    maxRecipients: Number(onChainMax),
    maxRecipientsLimit: Number(onChainLimit),
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: gasPrice.toString(),
    txType: tx.type,
    constructorArgs: [houseAddr, cfg.maxRecipients],
    // ⛔ READ FROM THE LIVE CONFIG, NEVER TYPED IN.
    //
    // This used to be a hardcoded literal saying viaIR: true. On 2026-09-11
    // viaIR was switched off and the literal would have written "viaIR: true"
    // into the permanent deployment record of a contract compiled WITHOUT it.
    // That record is the only durable statement of how this bytecode was
    // produced — it is what a future session, or anyone re-verifying the
    // contract years from now, has to trust. A wrong value here is worse than
    // no value, because it looks authoritative.
    compiler: (() => {
      const c = hre.config.solidity.compilers[0];
      const s = c.settings || {};
      return {
        version: c.version,
        optimizer: s.optimizer || { enabled: false },
        viaIR: s.viaIR === true,
        evmVersion: s.evmVersion || null,
      };
    })(),
    deployedAt: new Date().toISOString(),
  };

  // If a record already exists, keep it — a redeploy should never quietly
  // erase the address of a contract that may still be live and in use.
  if (fs.existsSync(recordPath)) {
    const previous = recordPath.replace(/\.json$/, `.${Date.now()}.json`);
    fs.renameSync(recordPath, previous);
    say(`  ⚠️  a previous deployment record existed for "${netName}".`);
    say(`      It was NOT deleted — renamed to ${path.basename(previous)}`);
    say("");
  }

  fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + "\n");
  say(`  record written: deployments/${netName}.json`);
  say("");

  // ── What to do next. ───────────────────────────────────────────────────
  say(line());
  say("  NEXT STEPS");
  say(line());
  say("");
  // Only print a verify command for a chain that actually HAS an explorer.
  // The first dry run printed `hardhat verify --network hardhat`, which is
  // meaningless — the in-process chain has no explorer and is gone the moment
  // the script exits. A nonsense command in a NEXT STEPS block is a command
  // somebody eventually pastes.
  if (cfg.explorer) {
    say("  1. Verify the source on the explorer:");
    say("");
    say(`       npx hardhat verify --network ${netName} ${address} ${houseAddr} ${cfg.maxRecipients}`);
    say("");
    say(`     Then check it here:  ${cfg.explorer}/address/${address}`);
    say("");
  } else {
    say("  1. No explorer for this network — nothing to verify.");
    say("     This chain is a rehearsal target only; the contract disappears");
    say("     when the process exits.");
    say("");
  }
  say("  2. Register a partner, only if one exists on day one:");
  say("");
  say("       (a separate owner transaction — setPartner(address, totalBps),");
  say("        where totalBps is between 200 and 500)");
  say("");
  say("  3. Point the frontend at this address, and use quote() and");
  say("     previewAmounts() so it shows exactly what the chain will charge.");
  say("");
  say("  ⛔ The contract holds nothing between transactions, by design and by");
  say("     assertion. If you ever see a balance on it, something sent funds");
  say("     outside a distribution — that is what rescueNative/rescueToken");
  say("     are for, and nothing else.");
  say("");
}

main().catch((e) => {
  console.error("");
  console.error("⛔ DEPLOY FAILED");
  console.error(e);
  process.exit(1);
});
