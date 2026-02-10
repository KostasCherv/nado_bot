import 'dotenv/config';
import type { ChainEnv } from '@nadohq/shared';

export interface ProductConfig {
  productId: number;
  orderSize: number;
}

export interface BotConfig {
  privateKey: `0x${string}`;
  chainEnv: ChainEnv;
  subaccountName: string;
  products: ProductConfig[];
  tpPercent: number;
  slPercent: number;
  orderExpirationSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  levelRefreshMinutes: number;
  lookbackHours: number;
  rLevelsCount: number;
  sLevelsCount: number;
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function parsePositiveInt(value: string, defaultValue: number): number {
  const n = Number(value);
  return isNaN(n) || n < 0 ? defaultValue : n;
}

export function loadConfig(): BotConfig {
  const privateKey = requireEnv('PRIVATE_KEY') as `0x${string}`;
  const chainEnv = (process.env.CHAIN_ENV ?? 'inkTestnet') as ChainEnv;
  const subaccountName = process.env.SUBACCOUNT_NAME ?? 'default';

  const btcProductId = Number(process.env.BTC_PERP_PRODUCT_ID ?? '4');
  const ethProductId = Number(process.env.ETH_PERP_PRODUCT_ID ?? '3');

  const orderSizeBtc = Number(process.env.ORDER_SIZE_BTC ?? '0.01');
  const orderSizeEth = Number(process.env.ORDER_SIZE_ETH ?? '0.1');

  const levelRefreshMinutes = parsePositiveInt(process.env.LEVEL_REFRESH_MINUTES ?? '60', 60);
  const lookbackHours = parsePositiveInt(process.env.LOOKBACK_HOURS ?? '24', 24);
  const rLevelsCount = parsePositiveInt(process.env.R_LEVELS_COUNT ?? '2', 2);
  const sLevelsCount = parsePositiveInt(process.env.S_LEVELS_COUNT ?? '2', 2);

  const tpPercent = Number(process.env.TP_PERCENT ?? '1.5');
  const slPercent = Number(process.env.SL_PERCENT ?? '0.75');
  const orderExpirationSeconds = Number(
    process.env.ORDER_EXPIRATION_SECONDS ?? '2592000',
  );
  const logLevel = (process.env.LOG_LEVEL ?? 'info') as BotConfig['logLevel'];

  const products: ProductConfig[] = [
    {
      productId: btcProductId,
      orderSize: orderSizeBtc,
    },
    {
      productId: ethProductId,
      orderSize: orderSizeEth,
    },
  ];

  return {
    privateKey,
    chainEnv,
    subaccountName,
    products,
    tpPercent,
    slPercent,
    orderExpirationSeconds,
    logLevel,
    levelRefreshMinutes,
    lookbackHours,
    rLevelsCount,
    sLevelsCount,
  };
}
