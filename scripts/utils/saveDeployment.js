const fs = require("fs");
const path = require("path");

const DEPLOY_FILE = path.join(__dirname, "../../deployed-contracts.json");

/**
 * Save contract deployment info (address, network, timestamp, etc.)
 */
function saveDeployment(network, contractName, contractAddress) {
  let deployments = {};

  // Load existing deployments if file exists
  if (fs.existsSync(DEPLOY_FILE)) {
    deployments = JSON.parse(fs.readFileSync(DEPLOY_FILE, "utf-8"));
  }

  if (!deployments[network]) {
    deployments[network] = {};
  }

  deployments[network][contractName] = {
    address: contractAddress,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(DEPLOY_FILE, JSON.stringify(deployments, null, 2));

  console.log(
    `💾 Saved deployment: ${contractName} @ ${contractAddress} on ${network}`
  );
}

module.exports = { saveDeployment };
