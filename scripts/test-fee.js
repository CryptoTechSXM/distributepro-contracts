const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Using deployer:", deployer.address);

  const DistributePro = await hre.ethers.getContractFactory("DistributePro");
  const dp = await DistributePro.deploy();
  await dp.waitForDeployment();

  console.log("✅ DistributePro deployed at:", await dp.getAddress());

  // Test values in ETH
  const testAmounts = [
    "9000",      // below 10k
    "10000",     // at 10k
    "20000",     // above 10k
    "500000",    // mid-scale
    "1000000",   // at 1m
    "2000000",   // above 1m
  ];

  for (const eth of testAmounts) {
    const wei = hre.ethers.parseEther(eth);
    const fee = await dp.calculateFee(wei);

    // Convert fee back to ETH for display
    const feeEth = hre.ethers.formatEther(fee);
    const percentage = (Number(fee) / Number(wei) * 100).toFixed(4);

    console.log(`💰 Amount: ${eth} ETH -> Fee: ${feeEth} ETH (${percentage}%)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
