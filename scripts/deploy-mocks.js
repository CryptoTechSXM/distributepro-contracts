const hre = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // Deploy MockUSDT
  const MockUSDT = await hre.ethers.getContractFactory("MockUSDT");
  const usdt = await MockUSDT.deploy();
  await usdt.waitForDeployment();
  console.log(`✅ MockUSDT deployed at: ${usdt.target}`);

  // Deploy MockUSDC
  const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  console.log(`✅ MockUSDC deployed at: ${usdc.target}`);

  // Save addresses for later use
  const data = {
    deployer: deployer.address,
    MockUSDT: usdt.target,
    MockUSDC: usdc.target,
    network: hre.network.name,
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync("deployed-mocks.json", JSON.stringify(data, null, 2));
  console.log("📦 Deployment info saved to deployed-mocks.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
