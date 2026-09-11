require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0x00";

module.exports = {
  // Single compiler. The old 0.8.28 entry existed only for Lock.sol, the
  // Hardhat sample contract — which was never actually in this repo (the
  // stray test/Lock.js and ignition/modules/Lock.js referencing it were
  // deleted 2026-09-11). Dead entry removed.
  //
  // OPTIMIZER ON. Two reasons: deployed bytecode should always be optimized,
  // and the optimizer relieves EVM stack pressure. evmVersion is pinned to
  // "paris" — solc 0.8.20's default — deliberately: paris emits no PUSH0, so
  // the bytecode stays deployable on chains that have not adopted Shanghai.
  // That matters for the non-standard chain in section 7.4 of the brief.
  //
  // viaIR: TRUE — reversed decision, 2026-09-11. Recorded because the reason
  // matters more than the setting.
  //
  // Solidity suggested viaIR twice on "Stack too deep" and Claude declined
  // twice, on the grounds that it changes code generation project-wide and
  // compiles slower, when restructuring the function is the tidier fix. That
  // reasoning is sound WHEN YOU CAN COMPILE. Claude cannot — no shell on this
  // machine since the 2026-09-08 Windows update, and npm is blocked in the
  // cloud container — so every stack-depth guess costs the OWNER a full build
  // cycle, and two were already spent. viaIR removes the entire class of
  // failure rather than one instance of it, and it is the officially
  // supported answer, widely used in production.
  //
  // The function-level fixes (the Quote struct, block scoping, the _emit
  // helpers) were kept as well — they are better code either way. If a future
  // session wants faster compiles, try setting viaIR back to false: if it
  // still builds, those fixes were sufficient on their own and this can go.
  solidity: {
    // ⛔ 0.8.19, LOWERED FROM 0.8.20 ON 2026-09-11 — measured, not preferred.
    //
    // WHY: the BTC20 explorer refused to verify DistributeProV3 twice under
    // 0.8.20. scripts/probe_verify.js then found the owner's LIVE V1 contract
    // IS verified there, under v0.8.19+commit.7dd6d404. So the explorer can
    // verify — its solc list just appears to stop one version short of ours.
    //
    // Every contract's pragma was moved from ^0.8.20 to ^0.8.19 to match.
    // Nothing in this repo needs 0.8.20: its headline change was defaulting
    // the EVM target to Shanghai, which evmVersion below overrides to berlin
    // regardless, and OpenZeppelin 4.9 requires only ^0.8.0.
    //
    // ⚠️ Do not raise this without re-running scripts/probe_verify.js. The
    // number that matters is what the EXPLORER has, not what is newest.
    version: "0.8.19",
    settings: {
      // ⚠️ FLIPPED TO FALSE 2026-09-11 — this is a TEST, not a settled change.
      // If the compile fails with "Stack too deep", put it straight back to
      // true; that result is itself the answer and should be recorded.
      //
      // WHY: DistributeProV3 deployed fine to BTC20 mainnet
      // (0x9f4e03BcFa7db943e3E0F9484299Abf40634342F) but Blockscout REFUSED to
      // verify it — "Fail - Unable to verify". scripts/probe_verify.js then
      // measured that scan.bitcoincode.technology has NO v2 API at all (both
      // v2 endpoints 404; only the v1 API answers), i.e. an old Blockscout
      // matching the chain's 2022-vintage node.
      //
      // To verify, an explorer must recompile the source and reproduce the
      // deployed bytecode BYTE FOR BYTE. viaIR changes code generation
      // entirely, and an old Blockscout honouring that flag is the least
      // reliable part of the chain. Removing viaIR removes the whole class of
      // divergence.
      //
      // ⚠️ THIS IS NOT A GUARANTEE THAT VERIFICATION THEN SUCCEEDS. The other
      // candidate cause — the explorer not having solc 0.8.20 available — is
      // not addressed by this and could not be measured (no v2 API to ask).
      // The stopping rule agreed with the owner: ONE attempt. If verification
      // still fails after a viaIR-free redeploy, stop, publish the source on
      // GitHub, link it from the site, and move on.
      //
      // The comment block below records why viaIR went ON in the first place;
      // it is kept because the reasoning still holds if this test fails.
      viaIR: false,
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // evmVersion: "berlin" — LOWERED from "paris" on 2026-09-11 after
      // measuring the BTC20 Smart Chain (scripts/probe_btc20.js).
      //
      // MEASURED, not assumed:
      //   client        Geth/v1.1.8-0914c5e8-20221031 / go1.16.15
      //                 (a BSC-lineage fork, built 2022-10-31)
      //   baseFeePerGas ABSENT from the block header -> the chain is NOT
      //                 running the EIP-1559 fee market
      //
      // A node of that vintage, with no 1559, is old enough that targeting a
      // modern EVM is a gamble taken with real gas. Berlin (2021) predates the
      // node comfortably.
      //
      // THE COST OF THIS IS ZERO. Berlin only forbids solc from using opcodes
      // introduced later: BASEFEE (London), PREVRANDAO (Paris), PUSH0
      // (Shanghai). DistributeProV3 uses none of them — no block.basefee, no
      // block.prevrandao. And older bytecode is FORWARD compatible: it runs
      // unchanged on Base, Ethereum, BSC, Polygon and everything newer.
      //
      // So: one setting, portable across every chain in the config including
      // the oldest. Do not raise it without a reason and a measurement.
      evmVersion: "berlin",
    },
  },
  networks: {
    ethereum: {
      url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      accounts: [PRIVATE_KEY],
    },
    sepolia: {
      url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
      accounts: [PRIVATE_KEY],
    },
    bsc: {
      url: "https://bsc-dataseed.binance.org/",
      accounts: [PRIVATE_KEY],
    },
    base: {
      url: "https://mainnet.base.org",
      accounts: [PRIVATE_KEY],
    },
    polygon: {
      url: "https://polygon-rpc.com",
      accounts: [PRIVATE_KEY],
    },
    avalanche: {
      url: "https://api.avax.network/ext/bc/C/rpc",
      accounts: [PRIVATE_KEY],
    },
    // BTC20 Smart Chain. The `// confirm endpoint` comment that sat here
    // unresolved for months is CLOSED: scripts/probe_btc20.js reached this
    // exact URL and it answered. chainId 0x3c3 = 963, matching the published
    // value. The endpoint was right all along.
    //
    // ⚠️ THERE IS NO FAILOVER. The docs publish a second RPC,
    // https://rpc1.bitcoincode.technology — it is DEAD, every call to it
    // failed. This single URL is a single point of failure.
    btc20: {
      url: "https://rpc.bitcoincode.technology",
      accounts: [PRIVATE_KEY],
      chainId: 963,

      // ⛔ THIS PINNED gasPrice IS WHAT FORCES LEGACY TYPE-0 TRANSACTIONS,
      // and it is not optional on this chain.
      //
      // MEASURED by scripts/probe_btc20.js: the block header carries NO
      // `baseFeePerGas`. That means the chain never adopted EIP-1559 and has
      // no fee market — unsurprising for a node built 2022-10-31 on a
      // BSC-lineage Geth fork.
      //
      // Ethers and Hardhat default to type-2 (EIP-1559) transactions wherever
      // a chain looks like it supports them. Send a type-2 transaction to a
      // pre-1559 node and it is rejected outright. Setting an explicit
      // gasPrice here is what makes ethers fall back to a legacy type-0
      // transaction, which is the only kind this chain accepts.
      //
      // 1 gwei is the price the chain itself quoted via eth_gasPrice.
      // scripts/deploy_v3.js re-reads that at deploy time and WARNS if the
      // chain has moved away from this pinned number — a pin that is too low
      // produces a transaction that is accepted and then never mined.
      gasPrice: 1_000_000_000, // 1 gwei, measured
    },
  },
  etherscan: {
    apiKey: {
      ethereum: process.env.ETHERSCAN_API_KEY,
      bsc: process.env.BSCSCAN_API_KEY,
      polygon: process.env.POLYGONSCAN_API_KEY,
      base: process.env.BASESCAN_API_KEY,
      avalanche: process.env.SNOWTRACE_API_KEY,

      // Blockscout ignores the API key, but hardhat-verify REQUIRES an entry
      // here for the network or it refuses to start. Any non-empty string
      // works; the env var is kept in case that ever changes.
      btc20: process.env.BTC20SCAN_API_KEY || "blockscout",
    },

    // ⛔ FIX APPLIED 2026-09-11 — brief section 13.1.
    //
    // THE BUG: btc20 was listed under `etherscan` with a BTC20SCAN_API_KEY,
    // as though its explorer were an Etherscan instance. It is not.
    // scan.bitcoincode.technology is BLOCKSCOUT, which speaks a different API
    // at a different path. As configured, `npx hardhat verify` on this chain
    // could never have worked — it would have posted to an Etherscan endpoint
    // that does not exist.
    //
    // Nothing had been deployed yet, so the bug had never had a chance to
    // fire. It would have fired on the first real deploy, after the gas was
    // spent, which is the worst moment to discover it.
    //
    // ⚠️ STILL UNVERIFIED: the `/api` path below is Blockscout's standard
    // layout, but no verification has actually been run against this
    // instance. The first `npx hardhat verify --network btc20` is the test.
    // If it fails, check what path the explorer's own API docs use before
    // assuming the contract is at fault.
    customChains: [
      {
        network: "btc20",
        chainId: 963,
        urls: {
          apiURL: "https://scan.bitcoincode.technology/api",
          browserURL: "https://scan.bitcoincode.technology",
        },
      },
    ],
  },
};
