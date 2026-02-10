import { initClient } from '../client.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DebugSubaccounts');

async function main() {
  try {
    logger.info('Loading configuration...');
    const config = loadConfig();

    logger.info('Initializing NadoClient...');
    const { nadoClient, walletAddress } = initClient(config);

    logger.info(`Fetching subaccount summary for: ${walletAddress} on ${config.chainEnv}...`);

    const summary = await nadoClient.subaccount.getSubaccountSummary({
      subaccountOwner: walletAddress,
      subaccountName: config.subaccountName,
    });

    logger.info('Subaccount summary:', { summary });

  } catch (error) {
    logger.error('Failed to fetch subaccount summary', { error: error instanceof Error ? error.message : String(error) });
  }
}

main();
