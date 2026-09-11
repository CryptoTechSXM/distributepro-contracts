/**
 * Simple logger with colors for better console output
 */
const chalk = require("chalk");

function logInfo(msg) {
  console.log(chalk.blue(`ℹ️  ${msg}`));
}

function logSuccess(msg) {
  console.log(chalk.green(`✅ ${msg}`));
}

function logError(msg) {
  console.log(chalk.red(`❌ ${msg}`));
}

function logWarn(msg) {
  console.log(chalk.yellow(`⚠️  ${msg}`));
}

module.exports = {
  logInfo,
  logSuccess,
  logError,
  logWarn,
};
