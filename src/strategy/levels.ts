import type { ProductConfig } from '../config.js';
import { buildDynamicLevels, type DynamicLevel } from './dynamicLevels.js';

export interface TradingLevel {
  productId: number;
  price: number;
  side: 'long' | 'short';
  size: number;
}

/**
 * Build dynamic trading levels for all products using pivot points
 */
export async function buildDynamicTradingLevels(
  nadoClient: any,
  products: ProductConfig[],
  config: { rLevelsCount: number; sLevelsCount: number; lookbackHours: number },
): Promise<{ levels: TradingLevel[]; refreshedAt: number }> {
  const productInfo = products.map((p) => ({
    productId: p.productId,
    orderSize: p.orderSize,
  }));

  const result = await buildDynamicLevels(nadoClient, productInfo, config);

  return {
    levels: result.levels,
    refreshedAt: result.refreshedAt,
  };
}
