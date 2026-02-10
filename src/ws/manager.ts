import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS } from '@nadohq/engine-client';
import type { ChainEnv } from '@nadohq/shared';
import type { EngineServerSubscriptionEvent } from '@nadohq/engine-client';
import { createLogger } from '../utils/logger.js';

const log = createLogger('WSManager');

export interface WebSocketManagerEvents {
  event: [EngineServerSubscriptionEvent];
  connected: [];
  disconnected: [];
  error: [Error];
}

export class WebSocketManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 20;
  private baseReconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private isShuttingDown = false;
  private pendingMessages: string[] = [];
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(chainEnv: ChainEnv) {
    super();
    this.url = ENGINE_WS_SUBSCRIPTION_CLIENT_ENDPOINTS[chainEnv];
    log.info(`WebSocket URL: ${this.url}`);
  }

  connect(): void {
    if (this.isShuttingDown) return;

    log.info('Connecting to WebSocket...');
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      log.info('WebSocket connected');
      this.reconnectAttempts = 0;
      this.emit('connected');

      // Send any queued messages
      for (const msg of this.pendingMessages) {
        this.ws?.send(msg);
      }
      this.pendingMessages = [];

      // Start ping/pong keepalive
      this.startPing();
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const raw = data.toString();
        const parsed = JSON.parse(raw);

        // Subscription responses have an `id` field; events do not
        if (parsed.id !== undefined) {
          log.debug('Subscription response', parsed);
          return;
        }

        // Events have a `type` field
        if (parsed.type) {
          this.emit('event', parsed as EngineServerSubscriptionEvent);
        } else {
          log.debug('Unknown WS message', parsed);
        }
      } catch (err) {
        log.error('Failed to parse WS message', {
          error: (err as Error).message,
        });
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.warn(`WebSocket closed: code=${code} reason=${reason.toString()}`);
      this.stopPing();
      this.emit('disconnected');

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      log.error('WebSocket error', { message: err.message });
      this.emit('error', err);
    });
  }

  send(message: object): void {
    const payload = JSON.stringify(message);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      log.debug('Sent WS message', message);
    } else {
      log.debug('WS not open, queueing message');
      this.pendingMessages.push(payload);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnect attempts reached, giving up');
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts++;

    log.info(
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this.isShuttingDown = true;
    this.stopPing();

    if (this.ws) {
      this.ws.close(1000, 'Bot shutting down');
      this.ws = null;
    }

    log.info('WebSocket disconnected');
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
