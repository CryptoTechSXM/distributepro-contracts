require("dotenv").config();

async function main() {
  console.log("🔎 Checking environment variables...");

  if (!process.env.ALCHEMY_API_KEY) {
    throw new Error("❌ Missing ALCHEMY_API_KEY in .env");
  } else {
    console.log("✅ Alchemy API Key loaded");
  }

  if (!process.env.SEPOLIA_PRIVATE_KEY) {
    throw new Error("❌ Missing SEPOLIA_PRIVATE_KEY in .env");
  } else {
    console.log("✅ Sepolia Private Key loaded");
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("❌ Missing ETHERSCAN_API_KEY in .env");
  } else {
    console.log("✅ Etherscan API Key loaded");
  }

  console.log("🎉 All environment variables are loaded correctly!");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
