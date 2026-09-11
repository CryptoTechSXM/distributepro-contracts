/**
 * probe_btc20.js  (v2, 2026-09-11)
 *
 * Written for the owner and a future session of Claude.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY v2 EXISTS — two corrections to v1, both prompted by the owner
 *
 * 1. v1 read the block gas limit from ONE block and reported 8,000,000 as
 *    though it were the chain's ceiling. The owner replied that his real
 *    transactions handle far more than that implied. His own standing rule
 *    applies to Claude here: ONE SAMPLE IS NOT A MEASUREMENT. v2 samples a
 *    span of blocks and reports min / median / max.
 *
 * 2. The audit brief's headline said DistributePro "has never been deployed
 *    to any live chain". That was read off the repo's JSON artifacts. It is
 *    WRONG — a V1.0-lineage `sendmultiple` contract is live on BTC20 and has
 *    processed hundreds of transactions. v2 inspects it directly.
 *
 * Everything here is READ-ONLY. No key, no gas, no transaction.
 *
 * Run:  node scripts/probe_btc20.js
 * from C:\CryptoNite-Smart-Contracts\DistributePro
 */

const RPC = "https://rpc.bitcoincode.technology";
const EXPECTED_CHAIN_ID = 963;

// The live V1.0-lineage contract, found 2026-09-11.
const LIVE_V1 = "0xa49e00fdC5E70Fa3E9A494b03e100E809E1d60C6";

// The owner's own distribution, offered as evidence of real capacity.
const SAMPLE_TX = "0x84e3db462663df70db4eeac6484d78bee21405163cb989b92e278b61aad98c69";

const BLOCK_SAMPLES = 40; // spread across recent history
const BLOCK_STRIDE = 500; // don't sample 40 adjacent blocks — that is one sample

async function rpc(method, params = []) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.error) throw new Error(`${body.error.message} (code ${body.error.code})`);
  return body.result;
}

const num = (h) => (h == null ? null : Number(BigInt(h)));
const big = (h) => (h == null ? null : BigInt(h));
const fmt = (n) => n.toLocaleString();
const btcc = (wei) => (Number(wei) / 1e18).toFixed(9);

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Decode how many recipients a call to process(address[],uint256[]) carried,
 * straight from the calldata. No ABI library needed.
 *
 * Layout after the 4-byte selector: two 32-byte offsets, then at each offset
 * a 32-byte length followed by that many 32-byte words.
 */
function decodeArrayLengths(input) {
  try {
    const data = input.slice(2);
    const args = data.slice(8); // drop selector
    const off1 = parseInt(args.slice(0, 64), 16) * 2;
    const off2 = parseInt(args.slice(64, 128), 16) * 2;
    const len1 = parseInt(args.slice(off1, off1 + 64), 16);
    const len2 = parseInt(args.slice(off2, off2 + 64), 16);
    return { selector: data.slice(0, 8), addresses: len1, percentages: len2 };
  } catch {
    return null;
  }
}

(async () => {
  console.log("");
  console.log("BTC20 Smart Chain probe v2 — read-only, no key, no gas, no transaction");
  console.log("=".repeat(70));

  // ── identity ──────────────────────────────────────────────────────────
  const chainId = num(await rpc("eth_chainId"));
  const client = await rpc("web3_clientVersion");
  const head = num(await rpc("eth_blockNumber"));
  console.log(`  chainId       ${chainId} ${chainId === EXPECTED_CHAIN_ID ? "✅" : "❌ EXPECTED " + EXPECTED_CHAIN_ID}`);
  console.log(`  client        ${client}`);
  console.log(`  head          #${fmt(head)}`);

  // ── 1. BLOCK GAS LIMIT, PROPERLY SAMPLED ──────────────────────────────
  console.log("");
  console.log("─".repeat(70));
  console.log(`BLOCK GAS LIMIT — sampling ${BLOCK_SAMPLES} blocks, every ${BLOCK_STRIDE}th`);
  console.log("─".repeat(70));
  console.log("  (v1 sampled ONE block and called 8,000,000 the ceiling. One sample");
  console.log("   is not a measurement — this is the correction.)");
  console.log("");

  const limits = [];
  const useds = [];
  for (let i = 0; i < BLOCK_SAMPLES; i++) {
    const n = head - i * BLOCK_STRIDE;
    if (n < 0) break;
    try {
      const b = await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
      if (!b) continue;
      const gl = num(b.gasLimit);
      const gu = num(b.gasUsed);
      limits.push(gl);
      useds.push(gu);
      if (i % 8 === 0) {
        console.log(`  #${String(fmt(n)).padStart(12)}   gasLimit ${String(fmt(gl)).padStart(12)}   gasUsed ${String(fmt(gu)).padStart(12)}`);
      }
    } catch (e) {
      console.log(`  #${fmt(n)} failed: ${e.message}`);
    }
  }

  if (limits.length) {
    const mn = Math.min(...limits), mx = Math.max(...limits), md = median(limits);
    console.log("");
    console.log(`  samples   ${limits.length}`);
    console.log(`  gasLimit  min ${fmt(mn)}   median ${fmt(md)}   max ${fmt(mx)}`);
    console.log(`  busiest block used ${fmt(Math.max(...useds))} gas`);
    console.log("");
    if (mn === mx) {
      console.log(`  ▶ The limit is FIXED at ${fmt(mn)} across every block sampled.`);
    } else {
      console.log(`  ▶ The limit VARIES (${fmt(mn)} .. ${fmt(mx)}). Plan against the MINIMUM,`);
      console.log(`    ${fmt(mn)}, because that is what a batch could land in.`);
    }
    console.log(`  ▶ USE THIS NUMBER for maxRecipients, not v1's single reading.`);
  }

  // ── 2. THE LIVE V1 CONTRACT ───────────────────────────────────────────
  console.log("");
  console.log("─".repeat(70));
  console.log("THE LIVE CONTRACT — the audit brief said nothing was ever deployed");
  console.log("─".repeat(70));

  const code = await rpc("eth_getCode", [LIVE_V1, "latest"]);
  const bal = big(await rpc("eth_getBalance", [LIVE_V1, "latest"]));
  console.log(`  address       ${LIVE_V1}`);
  console.log(`  has code      ${code && code !== "0x" ? "YES — it is a deployed contract" : "no"}`);
  console.log(`  bytecode size ${code ? (code.length - 2) / 2 : 0} bytes`);
  console.log(`  BALANCE       ${btcc(bal)} BTCC`);
  console.log("");
  if (bal > 0n) {
    console.log("  ⛔ THAT BALANCE CANNOT BE RECOVERED.");
    console.log("     V1.0 `sendmultiple` exposes exactly four functions:");
    console.log("       changeFee(uint)   changeAdmin(address)   checkSum(view)   process(payable)");
    console.log("     No withdraw. No sweep. No rescue. No receive(). No fallback.");
    console.log("     No selfdestruct. There is NO code path that moves this out.");
    console.log("");
    console.log("     How it got there: process() pays admin msg.value*2/102 and each");
    console.log("     recipient msg.value*pct/1020000. Every one of those divisions");
    console.log("     truncates DOWN, and the checkSum() guard is COMMENTED OUT, so");
    console.log("     nothing forces the percentages to total 1,000,000. Whatever is");
    console.log("     not paid out simply stays.");
    console.log("");
    console.log("     This is defect 2.6 / test D5 — stranded funds with no exit —");
    console.log("     happening on mainnet with real money, not in a test.");
  }

  // ── 3. THE OWNER'S OWN TRANSACTION ────────────────────────────────────
  console.log("");
  console.log("─".repeat(70));
  console.log("REAL-WORLD GAS — decoded from the owner's own distribution");
  console.log("─".repeat(70));

  try {
    const tx = await rpc("eth_getTransactionByHash", [SAMPLE_TX]);
    const rcpt = await rpc("eth_getTransactionReceipt", [SAMPLE_TX]);
    const gasUsed = num(rcpt.gasUsed);
    const gasLimitTx = num(tx.gas);
    const decoded = decodeArrayLengths(tx.input);

    console.log(`  block         #${fmt(num(tx.blockNumber))}`);
    console.log(`  status        ${num(rcpt.status) === 1 ? "success" : "FAILED"}`);
    console.log(`  gas used      ${fmt(gasUsed)}   (limit set: ${fmt(gasLimitTx)})`);
    console.log(`  tx type       ${tx.type ?? "0x0"}  ${(tx.type ?? "0x0") === "0x0" ? "(legacy — as expected, no EIP-1559 here)" : ""}`);

    if (decoded) {
      console.log(`  selector      0x${decoded.selector}`);
      console.log(`  recipients    ${decoded.addresses}   (percentages array: ${decoded.percentages})`);
      if (decoded.addresses > 0) {
        const perRecipient = Math.round(gasUsed / decoded.addresses);
        console.log("");
        console.log(`  ▶ ${fmt(perRecipient)} GAS PER RECIPIENT, measured on the real chain.`);
        console.log("");
        console.log("    Compare the local bench, which used BRAND-NEW addresses:");
        console.log("      native to a NEW address       ~36,021 gas  (incl. 25,000 account creation)");
        console.log("      native to an EXISTING address  ~9,300 gas  (no account creation)");
        console.log("");
        console.log("    If this number is far below 36,021, that is the explanation and");
        console.log("    the owner is right: real payee lists are mostly addresses that");
        console.log("    ALREADY EXIST, so real capacity is several times the worst case.");
        if (limits.length) {
          const mn = Math.min(...limits);
          console.log("");
          console.log(`    At ${fmt(perRecipient)} gas each, the measured minimum block limit of`);
          console.log(`    ${fmt(mn)} fits about ${fmt(Math.floor((mn * 0.5) / perRecipient))} recipients at 50% of a block.`);
        }
      }
    } else {
      console.log("  (calldata did not decode as two dynamic arrays)");
    }
  } catch (e) {
    console.log(`  failed: ${e.message}`);
  }

  console.log("");
  console.log("=".repeat(70));
  console.log("");
})();
