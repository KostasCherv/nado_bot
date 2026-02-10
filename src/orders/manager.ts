import type { NadoClient } from '@nadohq/client';
import {
  addDecimals,
  nowInSeconds,
  packOrderAppendix,
} from '@nadohq/shared';
import type { BotConfig } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('OrderManager');

export interface OrderResult {
  digest: string;
  success: boolean;
  submittedPrice?: number;
  submittedTriggerPrice?: number;
}

export class OrderManager {
  public nadoClient: NadoClient;
  private config: BotConfig;
  private priceIncrementByProduct: Map<number, number> = new Map();
  private priceIncrementLoadPromise: Promise<void> | null = null;

  constructor(nadoClient: NadoClient, config: BotConfig) {
    this.nadoClient = nadoClient;
    this.config = config;
  }

  private getExpiration(): number {
    return nowInSeconds() + this.config.orderExpirationSeconds;
  }

  private async ensurePriceIncrementsLoaded(): Promise<void> {
    if (this.priceIncrementByProduct.size > 0) return;
    if (this.priceIncrementLoadPromise) {
      await this.priceIncrementLoadPromise;
      return;
    }

    this.priceIncrementLoadPromise = (async () => {
      try {
        const markets = await this.nadoClient.market.getAllMarkets();
        for (const market of markets) {
          const productId = (market as { productId?: number }).productId;
          if (typeof productId !== 'number') continue;

          const incrementRaw = (market as { priceIncrement?: unknown }).priceIncrement;
          const increment = Number(String(incrementRaw));
          if (Number.isFinite(increment) && increment > 0) {
            this.priceIncrementByProduct.set(productId, increment);
          }
        }
      } catch (err) {
        log.warn(`Failed to load product price increments`, {
          error: (err as Error).message,
        });
      } finally {
        this.priceIncrementLoadPromise = null;
      }
    })();

    await this.priceIncrementLoadPromise;
  }

  private decimalPlaces(value: number): number {
    if (!Number.isFinite(value)) return 0;
    const text = value.toString().toLowerCase();
    if (text.includes('e-')) {
      return Number(text.split('e-')[1] ?? '0');
    }
    const [, decimals = ''] = text.split('.');
    return decimals.length;
  }

  private async normalizePrice(productId: number, price: number): Promise<number> {
    await this.ensurePriceIncrementsLoaded();

    const increment = this.priceIncrementByProduct.get(productId);
    if (!increment) return price;

    const steps = Math.round(price / increment);
    const snapped = steps * increment;
    const normalized = Number(snapped.toFixed(this.decimalPlaces(increment)));
    return normalized;
  }

  /**
   * Place a limit order at a given price level.
   * Positive amount = buy (long), negative amount = sell (short).
   */
  async placeLimitOrder(
    productId: number,
    price: number,
    amount: number,
  ): Promise<OrderResult> {
    try {
      const normalizedPrice = await this.normalizePrice(productId, price);

      log.info(`Placing limit order`, {
        productId,
        price: normalizedPrice,
        originalPrice: price,
        amount,
      });

      const result = await this.nadoClient.market.placeOrder({
        productId,
        order: {
          subaccountName: this.config.subaccountName,
          price: normalizedPrice,
          amount: addDecimals(amount),
          expiration: this.getExpiration(),
          appendix: packOrderAppendix({
            orderExecutionType: 'default',
          }),
        },
      });

      const digest = result.data.digest;
      log.info(`Limit order placed`, {
        productId,
        price: normalizedPrice,
        amount,
        digest: digest.slice(0, 10) + '...',
      });

      return { digest, success: true, submittedPrice: normalizedPrice };
    } catch (err) {
      log.error(`Failed to place limit order`, {
        productId,
        price,
        amount,
        error: (err as Error).message,
      });
      return { digest: '', success: false };
    }
  }

  /**
   * Place a take-profit trigger order.
   *
   * For a long position: sells when oracle price goes above triggerPrice.
   * For a short position: buys when oracle price goes below triggerPrice.
   */
  async placeTakeProfitOrder(
    productId: number,
    triggerPrice: number,
    limitPrice: number,
    amount: number,
    isLong: boolean,
  ): Promise<OrderResult> {
    try {
      const normalizedTriggerPrice = await this.normalizePrice(productId, triggerPrice);
      const normalizedLimitPrice = await this.normalizePrice(productId, limitPrice);

      log.info(`Placing take-profit order`, {
        productId,
        triggerPrice: normalizedTriggerPrice,
        originalTriggerPrice: triggerPrice,
        limitPrice: normalizedLimitPrice,
        originalLimitPrice: limitPrice,
        amount,
        isLong,
      });

      const result = await this.nadoClient.market.placeTriggerOrder({
        productId,
        order: {
          subaccountName: this.config.subaccountName,
          price: normalizedLimitPrice,
          amount: addDecimals(amount),
          expiration: this.getExpiration(),
          appendix: packOrderAppendix({
            orderExecutionType: 'ioc',
            reduceOnly: true,
            triggerType: 'price',
          }),
        },
        triggerCriteria: {
          type: 'price',
          criteria: {
            // Long TP: sell when price goes above target
            // Short TP: buy when price goes below target
            type: isLong ? 'oracle_price_above' : 'oracle_price_below',
            triggerPrice: normalizedTriggerPrice,
          },
        },
      });

      const digest = result.data.digest;
      log.info(`Take-profit order placed`, {
        productId,
        triggerPrice: normalizedTriggerPrice,
        digest: digest.slice(0, 10) + '...',
      });

      return { digest, success: true, submittedPrice: normalizedLimitPrice, submittedTriggerPrice: normalizedTriggerPrice };
    } catch (err) {
      log.error(`Failed to place take-profit order`, {
        productId,
        triggerPrice,
        error: (err as Error).message,
      });
      return { digest: '', success: false };
    }
  }

  /**
   * Place a stop-loss trigger order.
   *
   * For a long position: sells when oracle price drops below triggerPrice.
   * For a short position: buys when oracle price rises above triggerPrice.
   */
  async placeStopLossOrder(
    productId: number,
    triggerPrice: number,
    limitPrice: number,
    amount: number,
    isLong: boolean,
  ): Promise<OrderResult> {
    try {
      const normalizedTriggerPrice = await this.normalizePrice(productId, triggerPrice);
      const normalizedLimitPrice = await this.normalizePrice(productId, limitPrice);

      log.info(`Placing stop-loss order`, {
        productId,
        triggerPrice: normalizedTriggerPrice,
        originalTriggerPrice: triggerPrice,
        limitPrice: normalizedLimitPrice,
        originalLimitPrice: limitPrice,
        amount,
        isLong,
      });

      const result = await this.nadoClient.market.placeTriggerOrder({
        productId,
        order: {
          subaccountName: this.config.subaccountName,
          price: normalizedLimitPrice,
          amount: addDecimals(amount),
          expiration: this.getExpiration(),
          appendix: packOrderAppendix({
            orderExecutionType: 'ioc',
            reduceOnly: true,
            triggerType: 'price',
          }),
        },
        triggerCriteria: {
          type: 'price',
          criteria: {
            // Long SL: sell when price drops below stop
            // Short SL: buy when price rises above stop
            type: isLong ? 'oracle_price_below' : 'oracle_price_above',
            triggerPrice: normalizedTriggerPrice,
          },
        },
      });

      const digest = result.data.digest;
      log.info(`Stop-loss order placed`, {
        productId,
        triggerPrice: normalizedTriggerPrice,
        digest: digest.slice(0, 10) + '...',
      });

      return { digest, success: true, submittedPrice: normalizedLimitPrice, submittedTriggerPrice: normalizedTriggerPrice };
    } catch (err) {
      log.error(`Failed to place stop-loss order`, {
        productId,
        triggerPrice,
        error: (err as Error).message,
      });
      return { digest: '', success: false };
    }
  }

  /**
   * Cancel a regular order by digest.
   */
  async cancelOrder(digest: string, productId: number): Promise<boolean> {
    try {
      log.info(`Cancelling order`, {
        digest: digest.slice(0, 10) + '...',
        productId,
      });

      await this.nadoClient.market.cancelOrders({
        digests: [digest],
        productIds: [productId],
        subaccountName: this.config.subaccountName,
      });

      log.info(`Order cancelled`, { digest: digest.slice(0, 10) + '...' });
      return true;
    } catch (err) {
      log.error(`Failed to cancel order`, {
        digest: digest.slice(0, 10) + '...',
        error: (err as Error).message,
      });
      return false;
    }
  }

  /**
   * Cancel a trigger order (TP/SL) by digest.
   */
  async cancelTriggerOrder(
    digest: string,
    productId: number,
  ): Promise<boolean> {
    try {
      log.info(`Cancelling trigger order`, {
        digest: digest.slice(0, 10) + '...',
        productId,
      });

      await this.nadoClient.market.cancelTriggerOrders({
        digests: [digest],
        productIds: [productId],
        subaccountName: this.config.subaccountName,
      });

      log.info(`Trigger order cancelled`, {
        digest: digest.slice(0, 10) + '...',
      });
      return true;
    } catch (err) {
      log.error(`Failed to cancel trigger order`, {
        digest: digest.slice(0, 10) + '...',
        error: (err as Error).message,
      });
      return false;
     }
   }

   /**
    * Fetch current market price for a product.
    */
   async getMarketPrice(
     productId: number,
   ): Promise<{ bid: number; ask: number; mid: number } | null> {
     try {
       const priceData = await this.nadoClient.market.getLatestMarketPrice({
         productId,
       });

       const bid = priceData.bid.toNumber();
       const ask = priceData.ask.toNumber();
       const mid = (bid + ask) / 2;

       return { bid, ask, mid };
     } catch (err) {
       log.error(`Failed to get market price`, {
         productId,
         error: (err as Error).message,
       });
       return null;
     }
   }
 }
