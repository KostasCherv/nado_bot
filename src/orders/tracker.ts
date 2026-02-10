import { createLogger } from '../utils/logger.js';

const log = createLogger('Tracker');

export type OrderSide = 'long' | 'short';

export type LevelStatus =
  | 'pending'       // Limit order placed, waiting for fill
  | 'filled'        // Entry filled, TP/SL placed
  | 'tp_hit'        // Take-profit triggered
  | 'sl_hit'        // Stop-loss triggered
  | 'cancelled';    // Manually cancelled

export interface LevelPosition {
  /** Unique ID for this level position */
  id: string;
  /** Product ID (e.g., BTC perp = 4, ETH perp = 3) */
  productId: number;
  /** The price level */
  level: number;
  /** Long (buy at support) or short (sell at resistance) */
  side: OrderSide;
  /** Order size */
  size: number;
  /** Entry limit order digest (from the engine) */
  entryOrderDigest: string | null;
  /** Take-profit trigger order digest */
  tpOrderDigest: string | null;
  /** Stop-loss trigger order digest */
  slOrderDigest: string | null;
  /** Current status */
  status: LevelStatus;
  /** Fill price (set when entry is filled) */
  fillPrice: number | null;
  /** Timestamp of creation */
  createdAt: number;
  /** Timestamp of last update */
  updatedAt: number;
}

/**
 * In-memory tracker for all level positions and their associated orders.
 */
export class PositionTracker {
  private positions: Map<string, LevelPosition> = new Map();
  /** Map from order digest to position ID for quick lookup */
  private digestToPositionId: Map<string, string> = new Map();

  /**
   * Create a new level position when a limit order is placed.
   */
  createPosition(params: {
    productId: number;
    level: number;
    side: OrderSide;
    size: number;
    entryOrderDigest: string;
  }): LevelPosition {
    const id = `${params.productId}-${params.side}-${params.level}`;
    const now = Date.now();

    const position: LevelPosition = {
      id,
      productId: params.productId,
      level: params.level,
      side: params.side,
      size: params.size,
      entryOrderDigest: params.entryOrderDigest,
      tpOrderDigest: null,
      slOrderDigest: null,
      status: 'pending',
      fillPrice: null,
      createdAt: now,
      updatedAt: now,
    };

    this.positions.set(id, position);
    this.digestToPositionId.set(params.entryOrderDigest, id);

    log.info(`Position created: ${id}`, {
      side: params.side,
      level: params.level,
      digest: params.entryOrderDigest.slice(0, 10) + '...',
    });

    return position;
  }

  /**
   * Mark position as filled and record TP/SL digests.
   */
  markFilled(
    entryDigest: string,
    fillPrice: number,
    tpDigest: string,
    slDigest: string,
  ): LevelPosition | null {
    const posId = this.digestToPositionId.get(entryDigest);
    if (!posId) return null;

    const position = this.positions.get(posId);
    if (!position) return null;

    position.status = 'filled';
    position.fillPrice = fillPrice;
    position.tpOrderDigest = tpDigest;
    position.slOrderDigest = slDigest;
    position.updatedAt = Date.now();

    this.digestToPositionId.set(tpDigest, posId);
    this.digestToPositionId.set(slDigest, posId);

    log.info(`Position filled: ${posId}`, {
      fillPrice,
      tpDigest: tpDigest.slice(0, 10) + '...',
      slDigest: slDigest.slice(0, 10) + '...',
    });

    return position;
  }

  /**
   * Mark that a TP or SL was triggered. Returns the paired digest to cancel.
   */
  markExit(
    digest: string,
    exitType: 'tp_hit' | 'sl_hit',
  ): { position: LevelPosition; pairedDigest: string | null } | null {
    const posId = this.digestToPositionId.get(digest);
    if (!posId) return null;

    const position = this.positions.get(posId);
    if (!position) return null;

    position.status = exitType;
    position.updatedAt = Date.now();

    // Return the paired order digest that needs to be cancelled
    let pairedDigest: string | null = null;
    if (exitType === 'tp_hit' && position.slOrderDigest) {
      pairedDigest = position.slOrderDigest;
    } else if (exitType === 'sl_hit' && position.tpOrderDigest) {
      pairedDigest = position.tpOrderDigest;
    }

    log.info(`Position exited: ${posId} via ${exitType}`, {
      pairedDigest: pairedDigest?.slice(0, 10) ?? 'none',
    });

    return { position, pairedDigest };
  }

  /**
   * Mark position as cancelled and clean up digest mappings.
   */
  markCancelled(digest: string): LevelPosition | null {
    const posId = this.digestToPositionId.get(digest);
    if (!posId) return null;

    const position = this.positions.get(posId);
    if (!position) return null;

    // Only cancel if still pending (entry not yet filled)
    if (position.status === 'pending') {
      position.status = 'cancelled';
      position.updatedAt = Date.now();
      log.info(`Position cancelled: ${posId}`);
    }

    return position;
  }

  /**
   * Find position by entry order digest.
   */
  getByEntryDigest(digest: string): LevelPosition | null {
    const posId = this.digestToPositionId.get(digest);
    if (!posId) return null;
    return this.positions.get(posId) ?? null;
  }

  /**
   * Find position by any associated digest (entry, TP, or SL).
   */
  getByDigest(digest: string): LevelPosition | null {
    const posId = this.digestToPositionId.get(digest);
    if (!posId) return null;
    return this.positions.get(posId) ?? null;
  }

  /**
   * Check if a level already has an active position.
   */
  hasActivePosition(productId: number, side: OrderSide, level: number): boolean {
    const id = `${productId}-${side}-${level}`;
    const pos = this.positions.get(id);
    if (!pos) return false;
    return pos.status === 'pending' || pos.status === 'filled';
  }

  /**
   * Remove completed/cancelled positions to free memory.
   */
  cleanup(): void {
    for (const [id, pos] of this.positions) {
      if (
        pos.status === 'tp_hit' ||
        pos.status === 'sl_hit' ||
        pos.status === 'cancelled'
      ) {
        // Clean up digest mappings
        if (pos.entryOrderDigest)
          this.digestToPositionId.delete(pos.entryOrderDigest);
        if (pos.tpOrderDigest)
          this.digestToPositionId.delete(pos.tpOrderDigest);
        if (pos.slOrderDigest)
          this.digestToPositionId.delete(pos.slOrderDigest);
        this.positions.delete(id);
      }
    }
  }

  /**
   * Get all active positions.
   */
  getActivePositions(): LevelPosition[] {
    return [...this.positions.values()].filter(
      (p) => p.status === 'pending' || p.status === 'filled',
    );
  }

  /**
   * Get a summary for logging.
   */
  getSummary(): { pending: number; filled: number; total: number } {
    let pending = 0;
    let filled = 0;
    for (const pos of this.positions.values()) {
      if (pos.status === 'pending') pending++;
      if (pos.status === 'filled') filled++;
    }
    return { pending, filled, total: this.positions.size };
  }
}
