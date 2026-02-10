import type {
  EngineServerSubscriptionBestBidOfferEvent,
  EngineServerSubscriptionFillEvent,
  EngineServerSubscriptionOrderUpdateEvent,
} from '@nadohq/engine-client';
import type { BotConfig } from '../config.js';
import { OrderManager } from '../orders/manager.js';
import { PositionTracker } from '../orders/tracker.js';
import { createLogger } from '../utils/logger.js';
import { buildDynamicTradingLevels, type TradingLevel } from './levels.js';

const log = createLogger('Strategy');

/**
 * Level-based trading strategy.
 *
 * Places limit buy orders at support levels and limit sell orders at resistance levels.
 * On fill, attaches take-profit and stop-loss trigger orders.
 * On TP/SL trigger, cancels the paired order and optionally re-arms the level.
 */
export class StrategyEngine {
  private orderManager: OrderManager;
  private tracker: PositionTracker;
  private config: BotConfig;
  private levels: TradingLevel[];
  private isRunning = false;

  /** Track latest mid prices per product */
  private latestPrices: Map<number, number> = new Map();

  /** Interval for refreshing levels (when dynamic levels enabled) */
  private levelRefreshInterval: ReturnType<typeof setInterval> | null = null;

  constructor(orderManager: OrderManager, config: BotConfig) {
    this.orderManager = orderManager;
    this.tracker = new PositionTracker();
    this.config = config;
    this.levels = [];
  }

  /**
   * Initialize: build dynamic levels, fetch current prices and place initial orders.
   */
  async start(): Promise<void> {
    log.info('Starting strategy engine...');

    // Build dynamic levels
    log.info('Fetching dynamic levels...');
    await this.refreshLevels();

    this.isRunning = true;

    // Fetch initial market prices for each product
    const productIds = [...new Set(this.levels.map((l) => l.productId))];
    for (const productId of productIds) {
      const price = await this.orderManager.getMarketPrice(productId);
      if (price) {
        this.latestPrices.set(productId, price.mid);
        log.info(`Initial price for product ${productId}`, price);
      } else {
        log.warn(`Could not fetch initial price for product ${productId}`);
      }
    }

    // Place initial limit orders at each level
    await this.placeInitialOrders();

    // Set up periodic level refresh
    const refreshMs = this.config.levelRefreshMinutes * 60 * 1000;
    log.info(`Setting up dynamic levels refresh every ${this.config.levelRefreshMinutes} minutes`);

    this.levelRefreshInterval = setInterval(async () => {
      if (this.isRunning) {
        try {
          await this.refreshLevels();
          await this.cancelAndReplaceOrders();
        } catch (err) {
          log.error('Failed to refresh dynamic levels', {
            error: (err as Error).message,
          });
        }
      }
    }, refreshMs);

    log.info('Strategy engine started', this.tracker.getSummary());
  }

  /**
   * Place limit orders at all configured levels.
   * Only places orders at levels that don't already have an active position.
   */
  private async placeInitialOrders(): Promise<void> {
    for (const level of this.levels) {
      if (this.tracker.hasActivePosition(level.productId, level.side, level.price)) {
        log.debug(`Skipping level (already active)`, level);
        continue;
      }

      const rawCurrentPrice = this.latestPrices.get(level.productId);
      if (!rawCurrentPrice) {
        log.warn(`No price available for product ${level.productId}, skipping level ${level.price}`);
        continue;
      }

      const currentPrice = rawCurrentPrice;

      // Long = positive amount (buy), short = negative amount (sell)
      const amount = level.side === 'long' ? level.size : -level.size;

      const result = await this.orderManager.placeLimitOrder(
        level.productId,
        level.price,
        amount,
      );

      if (result.success) {
        this.tracker.createPosition({
          productId: level.productId,
          level: result.submittedPrice ?? level.price,
          side: level.side,
          size: level.size,
          entryOrderDigest: result.digest,
        });
      }

      // Small delay between orders to avoid rate limiting
      await sleep(200);
    }
  }

  /**
   * Handle best_bid_offer updates -- track latest prices.
   */
  onBestBidOffer(event: EngineServerSubscriptionBestBidOfferEvent): void {
    const bid = this.normalizeStreamPrice(event.bid_price);
    const ask = this.normalizeStreamPrice(event.ask_price);
    const mid = (bid + ask) / 2;

     this.latestPrices.set(event.product_id, mid);

     const formattedBid = this.formatPrice(bid);
     const formattedAsk = this.formatPrice(ask);
     const formattedMid = this.formatPrice(mid);

     log.debug(`Price update product=${event.product_id}`, {
       bid: formattedBid,
       ask: formattedAsk,
       mid: formattedMid,
     });
  }

  /**
   * Handle fill events -- when our limit order gets filled, place TP/SL.
   */
  async onFill(event: EngineServerSubscriptionFillEvent): Promise<void> {
    const digest = event.order_digest;
    const position = this.tracker.getByEntryDigest(digest);

    if (!position) {
      log.debug(`Fill for unknown order, ignoring`, {
        digest: digest.slice(0, 10) + '...',
      });
      return;
    }

    if (position.status !== 'pending') {
      log.debug(`Fill for non-pending position, ignoring`, {
        positionId: position.id,
        status: position.status,
      });
      return;
    }

    const fillPrice = this.normalizeStreamPrice(event.price);
    const isLong = position.side === 'long';

    log.info(`Entry filled!`, {
      positionId: position.id,
      side: position.side,
      fillPrice,
      filledQty: this.normalizeStreamPrice(event.filled_qty),
      remainingQty: this.normalizeStreamPrice(event.remaining_qty),
    });

    // Prevent hedge/flip conflicts: once one side is filled, cancel opposite pending entries.
    await this.cancelOppositePendingEntries(position.productId, position.side, digest);

    // Calculate TP and SL prices
    const tpOffset = fillPrice * (this.config.tpPercent / 100);
    const slOffset = fillPrice * (this.config.slPercent / 100);

    let tpTriggerPrice: number;
    let tpLimitPrice: number;
    let slTriggerPrice: number;
    let slLimitPrice: number;
    let exitAmount: number;

    if (isLong) {
      // Long: TP above entry, SL below entry
      tpTriggerPrice = fillPrice + tpOffset;
      tpLimitPrice = tpTriggerPrice * 0.995; // Slight slippage buffer
      slTriggerPrice = fillPrice - slOffset;
      slLimitPrice = slTriggerPrice * 0.995;
      exitAmount = -position.size; // Sell to close long
    } else {
      // Short: TP below entry, SL above entry
      tpTriggerPrice = fillPrice - tpOffset;
      tpLimitPrice = tpTriggerPrice * 1.005;
      slTriggerPrice = fillPrice + slOffset;
      slLimitPrice = slTriggerPrice * 1.005;
      exitAmount = position.size; // Buy to close short
    }

    log.info(`Placing TP/SL for ${position.id}`, {
      tpTriggerPrice: tpTriggerPrice.toFixed(4),
      slTriggerPrice: slTriggerPrice.toFixed(4),
    });

    // Place TP and SL
    const [tpResult, slResult] = await Promise.all([
      this.orderManager.placeTakeProfitOrder(
        position.productId,
        tpTriggerPrice,
        tpLimitPrice,
        exitAmount,
        isLong,
      ),
      this.orderManager.placeStopLossOrder(
        position.productId,
        slTriggerPrice,
        slLimitPrice,
        exitAmount,
        isLong,
      ),
    ]);

    if (tpResult.success && slResult.success) {
      this.tracker.markFilled(
        digest,
        fillPrice,
        tpResult.digest,
        slResult.digest,
      );
    } else {
      log.error(`Failed to place TP/SL for position ${position.id}`, {
        tpSuccess: tpResult.success,
        slSuccess: slResult.success,
        tpDigest: tpResult.digest || null,
        slDigest: slResult.digest || null,
      });
    }
  }

  /**
   * Cancel pending entry orders on the opposite side for the same product.
   */
  private async cancelOppositePendingEntries(
    productId: number,
    filledSide: 'long' | 'short',
    filledEntryDigest: string,
  ): Promise<void> {
    const oppositeSide = filledSide === 'long' ? 'short' : 'long';
    const candidates = this.tracker.getActivePositions().filter(
      (p) =>
        p.productId === productId &&
        p.status === 'pending' &&
        p.side === oppositeSide &&
        p.entryOrderDigest &&
        p.entryOrderDigest !== filledEntryDigest,
    );

    if (candidates.length === 0) return;

    log.info(`Cancelling opposite pending entries`, {
      productId,
      filledSide,
      oppositeSide,
      count: candidates.length,
    });

    for (const pos of candidates) {
      if (!pos.entryOrderDigest) continue;

      const cancelled = await this.orderManager.cancelOrder(
        pos.entryOrderDigest,
        pos.productId,
      );

      if (cancelled) {
        this.tracker.markCancelled(pos.entryOrderDigest);
      } else {
        log.warn(`Failed to cancel opposite pending entry`, {
          productId: pos.productId,
          side: pos.side,
          level: pos.level,
          digest: pos.entryOrderDigest.slice(0, 10) + '...',
        });
      }
    }
  }

  /**
   * Handle order update events -- detect TP/SL triggers.
   */
  async onOrderUpdate(
    event: EngineServerSubscriptionOrderUpdateEvent,
  ): Promise<void> {
    const digest = event.digest;
    const position = this.tracker.getByDigest(digest);

    if (!position) return;

    if (event.reason === 'filled') {
      // Check if this is a TP or SL fill
      const isTp = digest === position.tpOrderDigest;
      const isSl = digest === position.slOrderDigest;

      if (isTp || isSl) {
        const exitType = isTp ? 'tp_hit' : 'sl_hit';
        const exitResult = this.tracker.markExit(digest, exitType);

        if (exitResult?.pairedDigest) {
          log.info(`${exitType.toUpperCase()} triggered, cancelling paired order`, {
            positionId: position.id,
            pairedDigest: exitResult.pairedDigest.slice(0, 10) + '...',
          });

          // Cancel the paired TP or SL trigger order
          await this.orderManager.cancelTriggerOrder(
            exitResult.pairedDigest,
            position.productId,
          );
        }

        log.info(`Position closed: ${position.id} via ${exitType}`, {
          level: position.level,
          side: position.side,
          fillPrice: position.fillPrice,
        });

        // Optionally re-arm this level for the next trade
        if (this.isRunning) {
          await this.rearmLevel(position.productId, position.side, position.level, position.size);
        }
      }
    }

    if (event.reason === 'cancelled') {
      // If entry order was cancelled externally, mark the position
      if (digest === position.entryOrderDigest && position.status === 'pending') {
        this.tracker.markCancelled(digest);
      }
    }
  }

  /**
   * Re-arm a level by placing a new limit order after TP/SL closes.
   */
  private async rearmLevel(
    productId: number,
    side: 'long' | 'short',
    level: number,
    size: number,
  ): Promise<void> {
    // Clean up old completed positions first
    this.tracker.cleanup();

    const rawCurrentPrice = this.latestPrices.get(productId);
    if (!rawCurrentPrice) {
      log.warn(`No price to re-arm level ${level}`);
      return;
    }

    const currentPrice = rawCurrentPrice;

    // Only re-arm if the level is still valid relative to price
    if (side === 'long' && level >= currentPrice) return;
    if (side === 'short' && level <= currentPrice) return;

    log.info(`Re-arming level ${level.toFixed(2)} (${side}) for product ${productId}`);

    const amount = side === 'long' ? size : -size;
    const result = await this.orderManager.placeLimitOrder(productId, level, amount);

    if (result.success) {
      this.tracker.createPosition({
        productId,
        level: result.submittedPrice ?? level,
        side,
        size,
        entryOrderDigest: result.digest,
      });
    }
  }

  /**
   * Refresh dynamic levels: cancel all pending orders and recalculate levels
   */
  async refreshLevels(): Promise<void> {
    log.info('Refreshing dynamic levels...');

    // Build new dynamic levels
    const result = await buildDynamicTradingLevels(
      (this.orderManager as any).nadoClient,
      this.config.products,
      {
        rLevelsCount: this.config.rLevelsCount,
        sLevelsCount: this.config.sLevelsCount,
        lookbackHours: this.config.lookbackHours,
      },
    );

    this.levels = result.levels;
    log.info(`Refreshed ${this.levels.length} dynamic levels`);
  }

  /**
   * Cancel all pending orders and place new ones at fresh levels
   */
  async cancelAndReplaceOrders(): Promise<void> {
    log.info('Canceling and replacing all pending orders at new levels...');

    // Cancel all pending entry orders
    const pendingPositions = this.tracker.getActivePositions().filter(
      (p) => p.status === 'pending'
    );

    for (const pos of pendingPositions) {
      if (pos.entryOrderDigest) {
        try {
          await this.orderManager.cancelOrder(
            pos.entryOrderDigest,
            pos.productId,
          );
          log.info(`Cancelled pending order ${pos.entryOrderDigest.slice(0, 10)}...`);
        } catch (err) {
          log.error(`Failed to cancel order ${pos.entryOrderDigest}`, {
            error: (err as Error).message,
          });
        }
      }
    }

    // Cancel TP/SL for filled positions
    const filledPositions = this.tracker.getActivePositions().filter(
      (p) => p.status === 'filled'
    );

    for (const pos of filledPositions) {
      if (pos.tpOrderDigest) {
        try {
          await this.orderManager.cancelTriggerOrder(
            pos.tpOrderDigest,
            pos.productId,
          );
        } catch (err) {
          log.error(`Failed to cancel TP order`, {
            error: (err as Error).message,
          });
        }
      }
      if (pos.slOrderDigest) {
        try {
          await this.orderManager.cancelTriggerOrder(
            pos.slOrderDigest,
            pos.productId,
          );
        } catch (err) {
          log.error(`Failed to cancel SL order`, {
            error: (err as Error).message,
          });
        }
      }
    }

    // Clean up tracker
    this.tracker.cleanup();

    // Place new orders at fresh levels
    await this.placeInitialOrders();

    log.info('Finished canceling and replacing orders');
  }

  /**
   * Stop the strategy and cancel all active orders.
   */
  async stop(): Promise<void> {
    log.info('Stopping strategy engine...');
    this.isRunning = false;

    // Clear refresh interval
    if (this.levelRefreshInterval) {
      clearInterval(this.levelRefreshInterval);
      this.levelRefreshInterval = null;
    }

    const activePositions = this.tracker.getActivePositions();
    log.info(`Cancelling ${activePositions.length} active positions...`);

    for (const pos of activePositions) {
      try {
        if (pos.status === 'pending' && pos.entryOrderDigest) {
          await this.orderManager.cancelOrder(
            pos.entryOrderDigest,
            pos.productId,
          );
        }
        if (pos.status === 'filled') {
          if (pos.tpOrderDigest) {
            await this.orderManager.cancelTriggerOrder(
              pos.tpOrderDigest,
              pos.productId,
            );
          }
          if (pos.slOrderDigest) {
            await this.orderManager.cancelTriggerOrder(
              pos.slOrderDigest,
              pos.productId,
            );
          }
        }
      } catch (err) {
        log.error(`Error cancelling position ${pos.id}`, {
          error: (err as Error).message,
        });
      }
    }

    log.info('Strategy engine stopped');
  }

  /**
   * Get tracker summary for monitoring.
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      positions: this.tracker.getSummary(),
      prices: Object.fromEntries(this.latestPrices),
      dynamicLevels: {
        refreshMinutes: this.config.levelRefreshMinutes,
        levelsCount: this.levels.length,
      },
    };
  }

  /**
   * Format normalized prices for logs.
   */
  private formatPrice(value: number): string {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  /**
   * Engine stream fields can arrive as human values or x18-scaled values.
   * Normalize to human units for strategy math and logs.
   */
  private normalizeStreamPrice(value: string | number): number {
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.abs(parsed) > 1e12 ? parsed / 1e18 : parsed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
