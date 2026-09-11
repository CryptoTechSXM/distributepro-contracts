// scripts/utils/changeNetwork.js

function changeNetwork(hre, networkName) {
  if (!hre.config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in hardhat.config.js`);
  }

  // Update the provider dynamically
  hre.network.name = networkName;
  hre.network.config = hre.config.networks[networkName];
  hre.ethers.provider = new hre.ethers.JsonRpcProvider(
    hre.network.config.url,
    {
      name: networkName,
      chainId: hre.network.config.chainId,
    }
  );
}

module.exports = { changeNetwork };
