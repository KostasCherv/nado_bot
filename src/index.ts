import { loadConfig } from './config.js';
import { initClient } from './client.js';
import { WebSocketManager } from './ws/manager.js';
import { setupSubscriptions } from './ws/subscriptions.js';
import { OrderManager } from './orders/manager.js';
import { StrategyEngine } from './strategy/engine.js';
import { createLogger, setLogLevel } from './utils/logger.js';

const log = createLogger('Main');

async function main(): Promise<void> {
  // 1. Load configuration
  log.info('Loading configuration...');
  const config = loadConfig();
  setLogLevel(config.logLevel);

  log.info('Configuration loaded', {
    chainEnv: config.chainEnv,
    products: config.products.map((p) => ({
      id: p.productId,
      orderSize: p.orderSize,
    })),
    levelRefreshMinutes: config.levelRefreshMinutes,
    lookbackHours: config.lookbackHours,
    rLevelsCount: config.rLevelsCount,
    sLevelsCount: config.sLevelsCount,
    tpPercent: config.tpPercent,
    slPercent: config.slPercent,
  });

  // 2. Initialize Nado client
  log.info('Initializing client...');
  const { nadoClient, walletAddress } = initClient(config);

  // 3. Create order manager
  const orderManager = new OrderManager(nadoClient, config);

  // 4. Create strategy engine
  const strategy = new StrategyEngine(orderManager, config);

  // 5. Set up WebSocket manager
  const wsManager = new WebSocketManager(config.chainEnv);

  // 6. Wire up subscriptions to strategy
  setupSubscriptions(wsManager, nadoClient, config, walletAddress, {
    onBestBidOffer: (event) => {
      strategy.onBestBidOffer(event);
    },
    onFill: (event) => {
      strategy.onFill(event).catch((err) => {
        log.error('Error handling fill event', {
          error: (err as Error).message,
        });
      });
    },
    onOrderUpdate: (event) => {
      strategy.onOrderUpdate(event).catch((err) => {
        log.error('Error handling order update event', {
          error: (err as Error).message,
        });
      });
    },
    onPositionChange: (event) => {
      log.info('Position change', {
        productId: event.product_id,
        amount: event.amount,
        reason: event.reason,
      });
    },
  });

  // 7. Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down gracefully...`);

    try {
      await strategy.stop();
    } catch (err) {
      log.error('Error stopping strategy', {
        error: (err as Error).message,
      });
    }

    wsManager.disconnect();
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 8. Connect WebSocket
  wsManager.connect();

  // 9. Start strategy once WebSocket is connected
  wsManager.on('connected', async () => {
    // Small delay to let subscriptions establish
    await sleep(1000);

    try {
      await strategy.start();
      log.info('Bot is running!', strategy.getStatus());
    } catch (err) {
      log.error('Failed to start strategy', {
        error: (err as Error).message,
      });
      process.exit(1);
    }
  });

  // 10. Status logging every 60 seconds
  setInterval(() => {
    if (wsManager.isConnected) {
      log.info('Status', strategy.getStatus());
    }
  }, 60_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Boot
main().catch((err) => {
  log.error('Fatal error', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
