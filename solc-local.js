// EXPERIMENT (session 13): point hardhat at the npm-bundled solc.
//
// binaries.soliditylang.org is blocked by org egress, so hardhat's own
// compiler downloader dies on list.json with a 403 before it compiles a line.
// The `solc` npm package bundles the same compiler as an Emscripten build and
// needs no network at all. This overrides the one subtask that decides which
// compiler binary hardhat uses.
//
// Opt-in via DPB_LOCAL_SOLC=1 so the laptop's normal (downloaded) path is
// untouched unless the variable is set.
const path = require("path");
const { subtask } = require("hardhat/config");
const {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
} = require("hardhat/builtin-tasks/task-names");

subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (process.env.DPB_LOCAL_SOLC !== "1") return runSuper();

  const solc = require("solc");
  const longVersion = solc.version(); // e.g. 0.8.20+commit.a1b79de6.Emscripten.clang
  const version = longVersion.split("+")[0];

  if (version !== args.solcVersion) {
    throw new Error(
      "DPB_LOCAL_SOLC=1 but the bundled solc is " +
        version +
        " and hardhat asked for " +
        args.solcVersion +
        ". Refusing rather than compiling with the wrong compiler."
    );
  }

  return {
    compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
    isSolcJs: true,
    version,
    longVersion,
  };
});
