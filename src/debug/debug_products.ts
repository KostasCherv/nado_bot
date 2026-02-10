import { initClient } from '../client.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';
import * as fs from "fs";

const logger = createLogger('DebugProducts');

async function main() {
  try {
    logger.info('Loading configuration...');
    const config = loadConfig();

    logger.info('Initializing NadoClient...');
    const { nadoClient } = initClient(config);

    logger.info(`Fetching products on ${config.chainEnv}...\n`);

    // Get products - we need to use the engine client to get symbols
    let symbolsResult = await nadoClient.market.getAllMarkets()
    symbolsResult = symbolsResult.filter(o => o.type === 1)
    // save to file 
    fs.writeFileSync('data.json', JSON.stringify(symbolsResult))

  } catch(error: unknown) {
    console.log(error)
  }

}

main();
