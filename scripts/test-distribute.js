// scripts/test-distribute.js
const { ethers } = require("hardhat");

async function main() {
  console.log("==================================================");
  console.log("🚀 Starting DistributePro Test...");
  console.log("==================================================");

  // 1️⃣ Get accounts from Hardhat local node
  const [deployer, recipient1, recipient2] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Recipient 1: ${recipient1.address}`);
  console.log(`Recipient 2: ${recipient2.address}`);

  // 2️⃣ Deploy the contract
  const DistributePro = await ethers.getContractFactory("DistributePro");
  const distributePro = await DistributePro.deploy(deployer.address);
  await distributePro.waitForDeployment();
  console.log(`✅ DistributePro deployed at: ${await distributePro.getAddress()}`);

  // 3️⃣ Define recipients and amounts
  const recipients = [recipient1.address, recipient2.address];
  const amounts = [
    ethers.parseEther("3"), // 3 ETH to first recipient
    ethers.parseEther("3")  // 3 ETH to second recipient
  ];

  // 4️⃣ Calculate total and fee
  const total = amounts.reduce((a, b) => a + b, 0n);
  const fee = await distributePro.calculateFee(total);
  const sendAmount = total + fee;

  console.log(`🚀 Sending ETH: ${ethers.formatEther(sendAmount)} ETH (Fee: ${ethers.formatEther(fee)} ETH)`);

  // 5️⃣ Check deployer’s balance before
  const balanceBefore = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Deployer balance before: ${ethers.formatEther(balanceBefore)} ETH`);

  // 6️⃣ Send ETH distribution transaction
  const tx = await distributePro.processETH(recipients, amounts, { value: sendAmount });
  const receipt = await tx.wait();

  console.log("✅ Transaction confirmed!");
  console.log(`📜 TX Hash: ${receipt.hash}`);

  // 7️⃣ Check recipient balances
  const bal1 = await ethers.provider.getBalance(recipient1.address);
  const bal2 = await ethers.provider.getBalance(recipient2.address);
  console.log(`🎯 Recipient 1 new balance: ${ethers.formatEther(bal1)} ETH`);
  console.log(`🎯 Recipient 2 new balance: ${ethers.formatEther(bal2)} ETH`);

  console.log("==================================================");
  console.log("🎉 Distribution Test Completed Successfully!");
  console.log("==================================================");
}

// Standard Hardhat run block
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
