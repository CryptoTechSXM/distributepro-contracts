// scripts/test-distribute-token.js
const { ethers } = require("hardhat");

async function main() {
  console.log("==================================================");
  console.log("🚀 Starting DistributePro Token Distribution Test...");
  console.log("==================================================");

  // 1️⃣ Get accounts
  const [deployer, recipient1, recipient2] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Recipient 1: ${recipient1.address}`);
  console.log(`Recipient 2: ${recipient2.address}`);

  // 2️⃣ Deploy DistributePro
  const DistributePro = await ethers.getContractFactory("DistributePro");
  const distributePro = await DistributePro.deploy(deployer.address);
  await distributePro.waitForDeployment();
  const contractAddress = await distributePro.getAddress();
  console.log(`✅ DistributePro deployed at: ${contractAddress}`);

  // 3️⃣ Deploy a Mock ERC-20 token
  const MockToken = await ethers.getContractFactory("contracts/MockUSDT.sol:MockUSDT");
  const mockToken = await MockToken.deploy("Test Token", "TTK", ethers.parseEther("1000000"));
  await mockToken.waitForDeployment();
  const tokenAddress = await mockToken.getAddress();
  console.log(`✅ Mock Token deployed at: ${tokenAddress}`);

  // 4️⃣ Mint and approve tokens
  const totalSupply = await mockToken.totalSupply();
  console.log(`💰 Total Supply: ${ethers.formatEther(totalSupply)} TTK`);

  // Approve DistributePro to spend deployer’s tokens
  const approval = await mockToken.approve(contractAddress, ethers.parseEther("100000"));
  await approval.wait();
  console.log("✅ Approved DistributePro to spend tokens");

  // 5️⃣ Define recipients and token amounts
  const recipients = [recipient1.address, recipient2.address];
  const amounts = [
    ethers.parseEther("1000"),
    ethers.parseEther("2000"),
  ];

  const total = amounts.reduce((a, b) => a + b, 0n);
  const fee = await distributePro.calculateFee(total);

  console.log(`🚀 Distributing ${ethers.formatEther(total)} TTK (Fee: ${ethers.formatEther(fee)} TTK)`);

  // 6️⃣ Send tokens via contract
  const tx = await distributePro.processToken(tokenAddress, recipients, amounts, total);
  const receipt = await tx.wait();

  console.log("✅ Token distribution successful!");
  console.log(`📜 TX Hash: ${receipt.hash}`);

  // 7️⃣ Log final balances
  const bal1 = await mockToken.balanceOf(recipient1.address);
  const bal2 = await mockToken.balanceOf(recipient2.address);
  const balFee = await mockToken.balanceOf(deployer.address);

  console.log(`🎯 Recipient 1 balance: ${ethers.formatEther(bal1)} TTK`);
  console.log(`🎯 Recipient 2 balance: ${ethers.formatEther(bal2)} TTK`);
  console.log(`💼 Fee recipient balance: ${ethers.formatEther(balFee)} TTK`);

  console.log("==================================================");
  console.log("🎉 Token Distribution Test Completed Successfully!");
  console.log("==================================================");
}

// Standard Hardhat runner
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
