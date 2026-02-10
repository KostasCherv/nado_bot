import { createNadoClient, type NadoClient } from '@nadohq/client';
import type { ChainEnv } from '@nadohq/shared';
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ink, inkSepolia } from 'viem/chains';
import type { BotConfig } from './config.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('Client');

function getChain(chainEnv: ChainEnv) {
  switch (chainEnv) {
    case 'inkMainnet':
      return ink;
    case 'inkTestnet':
      return inkSepolia;
    case 'local':
      return inkSepolia;
    default:
      throw new Error(`Unsupported chain environment: ${chainEnv}`);
  }
}

export interface BotClient {
  nadoClient: NadoClient;
  walletAddress: string;
  chainId: number;
}

export function initClient(config: BotConfig): BotClient {
  const account = privateKeyToAccount(config.privateKey);
  const chain = getChain(config.chainEnv);

  log.info(`Initializing client`, {
    chainEnv: config.chainEnv,
    chain: chain.name,
    wallet: account.address,
  });

  let walletClient;
  try {
    walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    });
  } catch (err) {
    log.error(`Failed to create wallet client`, { error: err instanceof Error ? err.message : String(err) });
    throw err;
  }

  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });

  const nadoClient = createNadoClient(config.chainEnv, {
    walletClient,
    publicClient: publicClient as unknown as PublicClient,
  });

  log.info('NadoClient initialized successfully');

  return {
    nadoClient,
    walletAddress: account.address,
    chainId: chain.id,
  };
}
