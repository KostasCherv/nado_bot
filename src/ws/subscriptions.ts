import type { NadoClient } from '@nadohq/client';
import type {
  EngineServerSubscriptionEvent,
  EngineServerSubscriptionBestBidOfferEvent,
  EngineServerSubscriptionFillEvent,
  EngineServerSubscriptionOrderUpdateEvent,
  EngineServerSubscriptionPositionChangeEvent,
} from '@nadohq/engine-client';
import { subaccountToHex } from '@nadohq/shared';
import type { BotConfig, ProductConfig } from '../config.js';
import type { WebSocketManager } from './manager.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Subscriptions');

// Re-export event types for downstream consumers
export type {
  EngineServerSubscriptionBestBidOfferEvent as BestBidOfferEvent,
  EngineServerSubscriptionFillEvent as FillEvent,
  EngineServerSubscriptionOrderUpdateEvent as OrderUpdateEvent,
  EngineServerSubscriptionPositionChangeEvent as PositionChangeEvent,
};

export type BotEventHandler = {
  onBestBidOffer?: (event: EngineServerSubscriptionBestBidOfferEvent) => void;
  onFill?: (event: EngineServerSubscriptionFillEvent) => void;
  onOrderUpdate?: (event: EngineServerSubscriptionOrderUpdateEvent) => void;
  onPositionChange?: (
    event: EngineServerSubscriptionPositionChangeEvent,
  ) => void;
};

/**
 * Subscribes to the relevant WebSocket streams and dispatches events.
 */
export function setupSubscriptions(
  wsManager: WebSocketManager,
  nadoClient: NadoClient,
  config: BotConfig,
  walletAddress: string,
  handler: BotEventHandler,
): void {
  const subaccountHex = subaccountToHex({
    subaccountOwner: walletAddress,
    subaccountName: config.subaccountName,
  });

  let msgId = 1;

  // When connected, subscribe to all streams
  wsManager.on('connected', () => {
    log.info('Subscribing to streams...');

    // Subscribe to best_bid_offer for each product
    for (const product of config.products) {
      const bboParams = nadoClient.ws.subscription.buildSubscriptionParams(
        'best_bid_offer',
        { product_id: product.productId },
      );
      const bboMsg = nadoClient.ws.subscription.buildSubscriptionMessage(
        msgId++,
        'subscribe',
        bboParams,
      );
      wsManager.send(bboMsg);
      log.info(
        `Subscribed to best_bid_offer for product ${product.productId}`,
      );
    }

    // Subscribe to order_update for our subaccount (all products)
    const orderUpdateParams =
      nadoClient.ws.subscription.buildSubscriptionParams('order_update', {
        subaccount: subaccountHex,
      });
    const orderUpdateMsg =
      nadoClient.ws.subscription.buildSubscriptionMessage(
        msgId++,
        'subscribe',
        orderUpdateParams,
      );
    wsManager.send(orderUpdateMsg);
    log.info('Subscribed to order_update');

    // Subscribe to fill for our subaccount (all products)
    const fillParams = nadoClient.ws.subscription.buildSubscriptionParams(
      'fill',
      { subaccount: subaccountHex },
    );
    const fillMsg = nadoClient.ws.subscription.buildSubscriptionMessage(
      msgId++,
      'subscribe',
      fillParams,
    );
    wsManager.send(fillMsg);
    log.info('Subscribed to fill');

    // Subscribe to position_change for our subaccount
    const posParams = nadoClient.ws.subscription.buildSubscriptionParams(
      'position_change',
      { subaccount: subaccountHex },
    );
    const posMsg = nadoClient.ws.subscription.buildSubscriptionMessage(
      msgId++,
      'subscribe',
      posParams,
    );
    wsManager.send(posMsg);
    log.info('Subscribed to position_change');
  });

  // Route events to the handler
  wsManager.on('event', (event: EngineServerSubscriptionEvent) => {
    switch (event.type) {
      case 'best_bid_offer':
        handler.onBestBidOffer?.(event);
        break;
      case 'fill':
        handler.onFill?.(event);
        break;
      case 'order_update':
        handler.onOrderUpdate?.(event);
        break;
      case 'position_change':
        handler.onPositionChange?.(event);
        break;
      default:
        log.debug('Unhandled event type', { type: (event as any).type });
    }
  });
}
