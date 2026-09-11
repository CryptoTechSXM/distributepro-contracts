// scripts/probe_verify.js
//
// IS ANYTHING ACTUALLY VERIFIED ON THIS EXPLORER — AND WITH WHICH COMPILER?
// Written 2026-09-11 for the owner and a future session of Claude.
//
// RUN:  node scripts/probe_verify.js
//
// Read-only. No key, no gas, no transaction. Node's built-in fetch only.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS WAS REWRITTEN — the owner's screenshot reopened a closed question
//
// Two `hardhat verify` attempts on V3 failed with "Fail - Unable to verify",
// once with viaIR and once without. That was recorded as "verification is not
// achievable on BTC20", with an explicit condition for reopening it: NEW
// EVIDENCE ABOUT THE EXPLORER ITSELF.
//
// The owner then sent a screenshot of the explorer showing his V1 contract as
//
//     sendmultiple (0xa49e00–1d60c6)
//
// A NAME, not a bare address. Blockscout gets a contract's NAME from its
// SOURCE. If V1 carries a name, this explorer holds source for it — and an
// explorer that has verified one contract can verify another. That is exactly
// the new evidence the stopping rule asked for.
//
// ⚠️ It is also possible Blockscout is showing a name from a BYTECODE-SIMILAR
// match verified elsewhere, rather than a real verification of that address.
// This probe distinguishes the two: a genuine verification returns SourceCode
// AND a CompilerVersion.
//
// THE PRIZE IF V1 IS VERIFIED: its CompilerVersion tells us a solc release
// this explorer definitely has. V3 failing while V1 succeeded would point
// straight at solc 0.8.20 being absent — and recompiling V3 against a version
// the explorer owns is then a real, cheap path to a verified contract.
//
// This also answers the owner's actual question: the explorer shows
// "DistributePro" instead of a raw address ONLY once the contract is verified.

const BASE = "https://scan.bitcoincode.technology";

const TARGETS = [
  {
    label: "V1  `sendmultiple` — LIVE, 597 txs, shows a NAME on the explorer",
    address: "0xa49e00fdC5E70Fa3E9A494b03e100E809E1d60C6",
    note: "the screenshot that reopened this question",
  },
  {
    label: "V3  LIVE (no viaIR) — the one we want to read as DistributePro",
    address: "0x3092F4b1E5D71ED872E06BC1A066781c33c60390",
    note: "verification refused twice",
  },
  {
    label: "V3  ABANDONED (viaIR build)",
    address: "0x9f4e03BcFa7db943e3E0F9484299Abf40634342F",
    note: "superseded; listed only for completeness",
  },
];

function line(c = "─", n = 72) {
  return c.repeat(n);
}
const say = (m = "") => console.log(m);

async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      /* keep raw */
    }
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: "", error: e.message };
  }
}

async function inspect(t) {
  say("");
  say(line());
  say("  " + t.label);
  say("  " + t.address);
  say("  (" + t.note + ")");
  say(line());

  const r = await getJson(
    `${BASE}/api?module=contract&action=getsourcecode&address=${t.address}`
  );

  if (!r.json) {
    say(`  ⚠️  no JSON (HTTP ${r.status}) — raw: ${(r.text || "").slice(0, 200)}`);
    return null;
  }

  const row = Array.isArray(r.json.result) ? r.json.result[0] : null;
  if (!row) {
    say(`  ⚠️  no result row. status=${r.json.status} message=${r.json.message}`);
    return null;
  }

  // Blockscout returns "" (or the string "Contract source code not verified")
  // for an unverified address rather than omitting the field.
  const src = String(row.SourceCode || "");
  const verified = src.length > 0 && !/not verified/i.test(src);

  say(`  VERIFIED             ${verified ? "✅ YES" : "❌ no"}`);
  if (row.ContractName) say(`  ContractName         ${row.ContractName}`);
  if (row.CompilerVersion) say(`  CompilerVersion      ${row.CompilerVersion}`);
  if (row.OptimizationUsed !== undefined)
    say(`  OptimizationUsed     ${row.OptimizationUsed}`);
  if (row.Runs) say(`  Runs                 ${row.Runs}`);
  if (row.EVMVersion) say(`  EVMVersion           ${row.EVMVersion}`);
  if (verified) say(`  source length        ${src.length} chars`);
  if (row.ABI && !/not verified/i.test(String(row.ABI)))
    say(`  ABI                  present (${String(row.ABI).length} chars)`);

  return { ...t, verified, row };
}

async function main() {
  say("");
  say(line("═"));
  say("  BTC20 EXPLORER — WHAT IS ACTUALLY VERIFIED?");
  say("  " + BASE);
  say(line("═"));
  say("");
  say("  V3 is compiled with: solc 0.8.20, optimizer on (200 runs), evm berlin,");
  say("  viaIR FALSE. If another contract here is verified under a DIFFERENT");
  say("  solc version, that version is one this explorer definitely has.");

  const results = [];
  for (const t of TARGETS) results.push(await inspect(t));

  const v1 = results[0];
  const v3 = results[1];

  say("");
  say(line("═"));
  say("  WHAT THIS MEANS");
  say(line("═"));
  say("");

  if (v1 && v1.verified) {
    say("  ✅ V1 IS GENUINELY VERIFIED ON THIS EXPLORER.");
    say("");
    say("     So verification WORKS here, and the earlier conclusion that it is");
    say("     unachievable on BTC20 was WRONG. Two prior notes need correcting:");
    say("     the brief's claim that V1 is unverified, and the memory entry");
    say("     saying verification cannot be done on this chain.");
    say("");
    if (v1.row.CompilerVersion) {
      say(`     V1 verified under compiler: ${v1.row.CompilerVersion}`);
      say("");
      say("     ▶ NEXT MOVE: that is a solc release this explorer HAS. If it is");
      say("       not 0.8.20, the most likely cause of V3's failure is simply");
      say("       that 0.8.20 is missing from its list. Recompiling V3 against a");
      say("       version the explorer owns — and redeploying, ~0.0017 BTCC — is");
      say("       then a real path to a verified contract that reads as");
      say("       'DistributePro' instead of a bare address.");
      say("");
      say("       ⚠️ Check the Solidity version pragma first. DistributeProV3");
      say("          declares ^0.8.20, and OpenZeppelin v4.9 needs >=0.8.0. A");
      say("          LOWER solc may not compile it, and that has to be tested");
      say("          locally — free — before any redeploy.");
    }
  } else if (v1) {
    say("  ❌ V1 IS NOT VERIFIED after all.");
    say("");
    say("     The name in the explorer screenshot therefore does NOT come from a");
    say("     verification of that address — most likely Blockscout matched its");
    say("     bytecode to a similar contract verified elsewhere and borrowed the");
    say("     name. That is a display convenience, not proof of anything.");
    say("");
    say("     ▶ The stopping rule stands: no further verification attempts on");
    say("       BTC20. Publish the V3 source on GitHub and link it from the site.");
  }

  if (v3 && v3.verified) {
    say("");
    say("  ⚠️ AND V3 NOW READS AS VERIFIED — worth re-checking the explorer page,");
    say("     since one of the earlier submissions may have landed after all.");
  }

  say("");
}

main().catch((e) => {
  console.error("");
  console.error("PROBE FAILED");
  console.error(e);
  process.exit(1);
});
