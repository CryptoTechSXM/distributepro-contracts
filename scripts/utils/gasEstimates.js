const { ethers } = require("hardhat");

/**
 * Estimate gas cost for deployment on the current network
 */
async function estimateDeploymentGas(factory) {
  const gasEstimate = await factory.signer.estimateGas(factory.getDeployTransaction());
  const gasPrice = await factory.signer.getGasPrice();
  const totalCost = gasEstimate.mul(gasPrice);

  return {
    gasEstimate: gasEstimate.toString(),
    gasPrice: ethers.utils.formatUnits(gasPrice, "gwei"),
    totalCostEth: ethers.utils.formatEther(totalCost),
  };
}

module.exports = { estimateDeploymentGas };
