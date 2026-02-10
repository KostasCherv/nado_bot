import type { NadoClient } from '@nadohq/client';
import { CandlestickPeriod } from '@nadohq/indexer-client';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DynamicLevels');

/**
 * Fetch historical candlesticks from the indexer API
 */
async function fetchCandlesticks(
  nadoClient: NadoClient,
  productId: number,
  period: CandlestickPeriod,
  lookbackHours: number,
): Promise<{ high: number; low: number; close: number } | null> {
  try {
    // Fetch candlesticks - using HOUR period, returns an array directly
    const result = await nadoClient.market.getCandlesticks({
      productId,
      period,
      limit: lookbackHours,
    });

    if (!result || result.length === 0) {
      log.warn(`No candlesticks found for product ${productId}`);
      return null;
    }

    // Extract highest high, lowest low, and latest close from the fetched candles
    let highestHigh = -Infinity;
    let lowestLow = Infinity;
    let latestClose = 0;

    for (const candle of result) {
      // Parse BigDecimal values from candlesticks
      const high = parseFloat(String(candle.high));
      const low = parseFloat(String(candle.low));
      const close = parseFloat(String(candle.close));

      if (high > highestHigh) highestHigh = high;
      if (low < lowestLow) lowestLow = low;
      latestClose = close;
    }

    log.debug(`Fetched candlesticks for product ${productId}`, {
      candles: result.length,
      highestHigh,
      lowestLow,
      latestClose,
    });

    return {
      high: highestHigh,
      low: lowestLow,
      close: latestClose,
    };
  } catch (err) {
    log.error(`Failed to fetch candlesticks for product ${productId}`, {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Calculate pivot point levels from price data
 */
export function calculatePivotLevels({
  high,
  low,
  close,
  rLevelsCount,
  sLevelsCount,
}: {
  high: number;
  low: number;
  close: number;
  rLevelsCount: number;
  sLevelsCount: number;
}): { price: number; side: 'long' | 'short'; pivotType: string }[] {
  const pivot = (high + low + close) / 3;
  const range = high - low;

  const levels: { price: number; side: 'long' | 'short'; pivotType: string }[] = [];

  // Resistance levels (short entries)
  for (let i = 1; i <= rLevelsCount; i++) {
    const price = pivot + i * range;
    // Round to 4 decimal places for price increment compatibility
    levels.push({ price: Math.round(price * 10000) / 10000, side: 'short', pivotType: `R${i}` });
  }

  // Support levels (long entries)
  for (let i = 1; i <= sLevelsCount; i++) {
    const price = pivot - i * range;
    // Round to 4 decimal places for price increment compatibility
    levels.push({ price: Math.round(price * 10000) / 10000, side: 'long', pivotType: `S${i}` });
  }

  return levels;
}

/**
 * Build dynamic trading levels for all products
 */
export async function buildDynamicLevels(
  nadoClient: NadoClient,
  products: { productId: number; orderSize: number }[],
  config: DynamicLevelsConfig,
): Promise<{ levels: DynamicLevel[]; refreshedAt: number }> {
  const { rLevelsCount, sLevelsCount, lookbackHours } = config;
  const levels: DynamicLevel[] = [];
  const period = CandlestickPeriod.HOUR;

  log.info(`Fetching dynamic levels for ${products.length} product(s)...`);

  // Fetch candlesticks for all products in parallel
  const productData = await Promise.all(
    products.map(async (product) => {
      const candleData = await fetchCandlesticks(
        nadoClient,
        product.productId,
        period,
        lookbackHours,
      );

      if (!candleData) {
        log.warn(`Skipping product ${product.productId} - no candlestick data`);
        return null;
      }

      return {
        productId: product.productId,
        orderSize: product.orderSize,
        ...candleData,
      };
    }),
  );

  // Calculate pivot levels for each product
  for (const data of productData) {
    if (!data) continue;

    const pivotLevels = calculatePivotLevels({
      high: data.high,
      low: data.low,
      close: data.close,
      rLevelsCount,
      sLevelsCount,
    });

    for (const level of pivotLevels) {
      levels.push({
        productId: data.productId,
        price: level.price,
        side: level.side,
        size: data.orderSize,
        pivotType: level.pivotType,
      });
    }

    const currentPrice = data.close;
    log.info(`Product ${data.productId} pivot levels calculated`, {
      currentPrice: currentPrice.toFixed(2),
      rLevels: pivotLevels.filter((l) => l.side === 'short').map((l) => l.price.toFixed(2)),
      sLevels: pivotLevels.filter((l) => l.side === 'long').map((l) => l.price.toFixed(2)),
    });
  }

  log.info(`Built ${levels.length} dynamic levels from ${productData.length} product(s)`);

  return {
    levels,
    refreshedAt: Date.now(),
  };
}

export interface DynamicLevel {
  productId: number;
  price: number;
  side: 'long' | 'short';
  size: number;
  pivotType: string;
}

export interface DynamicLevelsConfig {
  rLevelsCount: number;
  sLevelsCount: number;
  lookbackHours: number;
}
