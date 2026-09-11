# DistributePro

**Batch coin distribution. One transaction pays a whole list.**

Upload a list of wallets and percentages, send once, and every recipient is paid in the same
transaction. Built by **Crypto Counsel**. Runs on EVM chains — currently live on the
BTC20 Smart Chain, with Ethereum, Base, BSC, Polygon and Avalanche configured.

---

## The one rule this contract is built around

> **It never holds your money.**

The contract's balance is **zero before your transaction and zero after it**. There is no
accrual, no treasury, no "withdraw fees later", and no `receive()` function to take stray coin.
Your payout and the fee are both paid out inside the same call, and the contract requires the
arithmetic to close exactly:

```
amount sent to recipients + house fee + partner fee == msg.value
```

That is not a style choice. The previous version on this chain (V1, still live) has **5.848 BTCC
permanently stuck inside it** — rounding dust that accumulated over 597 transactions with no
function that can ever move it out. V3 exists so that cannot happen again, and the rule is
verified on mainnet, not asserted: see §19 of the design brief.

---

## Fees

A **2% floor and a 5% hard cap**, with an optional partner revenue share.

```
houseBps = max(200, ceil(totalBps / 2))
partnerBps = totalBps - houseBps
```

| total fee | Crypto Counsel | partner |
|---|---|---|
| 2.0% | 2.00% | 0.00% |
| 3.0% | 2.00% | 1.00% |
| 4.0% | 2.00% | 2.00% |
| 5.0% | 2.50% | 2.50% |

The house share never falls below 2%, so naming yourself as the partner costs you more, never
less. Partners must be registered by the owner first — an unregistered partner **reverts**
rather than quietly charging the floor.

The fee is charged **on top** of the payout, so recipients receive exactly the percentages you
specified. Call `quote()` and `previewAmounts()` before sending and the contract will tell you
precisely what it is going to do.

---

## Live contracts

| | address | chain | status |
|---|---|---|---|
| **V3** | `0x51bEeDc09D969CE3b5d64F1Be23171B99D700C79` | BTC20 (963) | ✅ live, proven with real money |
| V1 | `0xa49e00fdC5E70Fa3E9A494b03e100E809E1d60C6` | BTC20 (963) | ⚠️ still what the website points at — 597 txs, 5.848 BTCC stranded |

Owner and house recipient: `0x4B05184738df5F5e13c6EEEf3b1Ebe079b772372`.
`maxRecipients` 250, hard ceiling 500, unpaused.

Every deploy this project has made is recorded in `deployments/` — the deploy script **renames**
old records rather than overwriting them, so the full history is on disk.

⚠️ **Source verification on the BTC20 explorer is impossible today** — that Blockscout instance
has **zero compiler binaries installed**, so it cannot recompile and cannot verify any contract
by any method. This repository being public is the substitute. See §20 of the brief.

---

## Batch size

`maxRecipients` is a **backstop against absurd input, not a product limit.**

Gas per recipient depends on whether the payee address already exists on chain: roughly
**9,451 gas** if it does, **36,021** if it is brand new (account creation). At BTC20's 8,000,000
block limit there is no single count that is both safe and permissive — 111 would reject batches
that succeed on chain today; 423 would let a batch of new addresses fail *after* the gas is paid.

So the real mechanism lives in the frontend: **estimate gas on the candidate batch and split
until each chunk fits under ~50% of the block limit.** The chain knows which addresses already
exist, so the estimate is accurate per batch, per chain, per list. A 5,000-name list is simply
`ceil(5000 / chunk)` transactions with a progress bar. The answer is always yes.

---

## Running it

```bash
npm install
npx hardhat test                 # 73 passing
```

| script | what it does |
|---|---|
| `scripts/deploy_v3.js` | **the** deploy script. One `--network` per run. Refuses on five conditions before signing. |
| `scripts/testrun_v3.js` | sends one small real distribution and checks the books against the chain |
| `scripts/probe_btc20.js` | read-only chain survey — client, gas limits over 40 blocks, decodes a live batch |
| `scripts/probe_verify.js` | read-only — asks the explorer whether a given address is verified |

Deploy, then prove it:

```bash
HOUSE_RECIPIENT=0x...  npx hardhat run scripts/deploy_v3.js --network btc20   # dry run
CONFIRM=yes            npx hardhat run scripts/deploy_v3.js --network btc20   # for real
                       npx hardhat run scripts/testrun_v3.js --network btc20  # dry run
CONFIRM=yes            npx hardhat run scripts/testrun_v3.js --network btc20  # for real
```

Without `CONFIRM` both scripts print exactly what they *would* do and stop. Use that first, every
time.

### Test files, and what green means

⚠️ **`test/V2_1_defects.js` is inverted from every other file here.** It asserts that each defect
in the old V2.1 contract **is still real**, so **green means the bug reproduces** — it is a guard
against the audit quietly becoming wrong, not a health check. Everywhere else green means the
code is correct. Each file says so in its own header.

| file | tests | |
|---|---|---|
| `FeeSchedule.js` | 13 | the fee curve, in isolation |
| `V2_1_defects.js` | 8 | ⚠️ green = the old bugs are still real |
| `V3_spec.js` | 24 | every one of those defects, flipped |
| `GasBench.js` | 23 | gas per recipient, new vs existing addresses |
| `DeployBench.js` | 5 | deploy cost and bytecode size vs EIP-170 |

---

## Building on BTC20 — read this before writing any script

The BTC20 node is a BSC-lineage fork **built in October 2022**. Three things a modern EVM script
assumes are simply not there, and each one has already bitten this project:

- **No EIP-1559.** There is no `baseFeePerGas`, so a default type-2 transaction is rejected.
  `hardhat.config.js` pins `gasPrice`, and that pin is what forces the legacy type-0 fallback.
- **No `effectiveGasPrice` in receipts.** `receipt.gasPrice` comes back as **0**, which once made
  a verification script compute a gas cost of zero and report a false mismatch against a
  perfectly correct contract. Fall back to `tx.gasPrice`.
- **No Blockscout v2 API.** Verification config cannot be queried, and verification does not work
  at all (see above).

`evmVersion` is pinned to **berlin** and the compiler to **solc 0.8.19** for the same reason —
old bytecode is forward compatible, so one setting serves every chain here. ⛔ Do not raise
either without a measurement.

**Assume the fourth quirk exists and check every 1559-era field before relying on it.**

---

## Repository map

```
contracts/DistributeProV3.sol     the live contract
contracts/FeeSchedule.sol         the fee curve (library, fully inlined)
contracts/mocks/                  tokens that misbehave on purpose, for the tests
contracts/DistributePro.sol       V2.1 — superseded, kept as the defect specimen
deployments/                      one record per chain; old records renamed, never overwritten
docs/V3.0-AUDIT-AND-DESIGN-BRIEF.md   ← the real documentation
```

**The brief is the source of truth for this project.** It records what was measured, what was
predicted wrongly and corrected, and what each decision cost. Start at §18 for current state,
§21 for what is still open.

⛔ Scripts named `deploy.js`, `deploy-multi.js` and `verify-networks.js` are **retired and
disabled**. They deploy the defective V2.1 contract and depend on an `hre.changeNetwork()` that
does not exist in this Hardhat version. They are kept only so the history stays legible. Likewise
`deployed-contracts.json`, `multi-deploy-results.json` and `deployed-mocks.json` are the residue
of those failures — **localhost addresses under mainnet names**. Ignore all of it and use
`deployments/`.

---

## Status, honestly

- ✅ V3 is deployed on BTC20 mainnet and has moved real money; the books balanced to the unit.
- ⚠️ **The website still points at V1.** Deployed is not announced. V1 has real users — 597
  transactions — and superseding it needs a story told to them, not a silent cutover.
- ⚠️ No external security audit has been commissioned. That decision is still open.
