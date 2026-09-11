require("dotenv").config();
const { changeNetwork } = require("./utils/changeNetwork");
const hre = require("hardhat");
const { ethers } = require("ethers"); // ✅ import ethers here too

const PRIVATE_KEY = process.env.PRIVATE_KEY;

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
  for (const net of networks) {
    try {
      console.log(`\n🌍 Checking network: ${net}`);
      changeNetwork(net);

      // ✅ Create wallet directly
      const provider = hre.ethers.provider;
      const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
      console.log(`🔑 Deployer address: ${wallet.address}`);

      // Check connection by fetching latest block
      const blockNumber = await provider.getBlockNumber();
      console.log(`📦 Latest block on ${net}: ${blockNumber}`);

      // Check API key presence
      const apiKey = hre.config.etherscan.apiKey[net];
      console.log(apiKey ? `🔎 Explorer API key found` : `⚠️ No API key for ${net}`);
    } catch (err) {
      console.error(`❌ Error on ${net}: ${err.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
