# Nado Level-Based Perp Trading Bot

A high-performance TypeScript trading bot built on the [Nado SDK](https://docs.nado.xyz/developer-resources/typescript-sdk). This bot executes a level-based strategy for BTC and ETH perpetuals on the Ink network (Testnet & Mainnet).

## 🚀 Overview

The bot monitors real-time price feeds via WebSockets and automatically manages limit orders at predefined support and resistance levels. When an entry is filled, it immediately attaches take-profit (TP) and stop-loss (SL) trigger orders to manage the position.

### Key Features
- **Real-time execution**: Uses WebSockets for sub-second reaction to price changes and fills.
- **Level-based strategy**: Automated buying at support and selling at resistance.
- **Automated Risk Management**: Automatic TP/SL placement on every fill.
- **Position Tracking**: In-memory state machine to track order lifecycle and clean up on exits.
- **Graceful Handling**: Automatically cancels active orders on shutdown.

## 🛠 Prerequisites

- [Bun](https://bun.sh/) (recommended) or Node.js
- An Ethereum private key with funds on **Ink** or **Ink Sepolia**
- Testnet USDT0 (for Ink Sepolia) - Get it from the [Nado Faucet](https://testnet.nado.xyz/portfolio/faucet)

## 📦 Installation

1. **Clone and install dependencies:**
   ```bash
   bun install
   ```

2. **Setup environment variables:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and provide your `PRIVATE_KEY` and preferred trading levels.

## ⚙️ Configuration

Configure the bot via the `.env` file:

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Your wallet's private key (with 0x prefix) |
| `CHAIN_ENV` | `inkTestnet` or `inkMainnet` |
| `BTC_SUPPORT_LEVELS` | Comma-separated prices to place buy orders |
| `BTC_RESISTANCE_LEVELS`| Comma-separated prices to place sell orders |
| `TP_PERCENT` | Percentage profit target from entry |
| `SL_PERCENT` | Percentage stop loss from entry |
| `ORDER_SIZE_BTC` | Amount of BTC to trade per level |

## 📈 Strategy Logic

1. **Initialization**: On startup, the bot fetches the latest market prices for BTC and ETH.
2. **Level Loading**: It places limit buy orders at support levels (below current price) and limit sell orders at resistance levels (above current price).
3. **Execution**:
   - When a limit order is **filled**, the bot receives a WebSocket event.
   - It immediately calculates and places a **Take Profit** (limit/trigger) and a **Stop Loss** (reduce-only trigger).
4. **Position Exit**: 
   - If TP or SL is triggered, the bot cancels the remaining paired order (e.g., if TP hits, it cancels the SL).
   - The bot then "re-arms" the level, placing a new limit order if the price has moved sufficiently away from the level.

## 📂 Project Structure

```text
src/
├── index.ts              # Entry point - initializes and boots all modules
├── config.ts             # Environment variable loading and validation
├── client.ts             # Nado SDK client and Viem wallet initialization
├── ws/
│   ├── manager.ts        # WebSocket connection and reconnection logic
│   └── subscriptions.ts  # Stream subscription and event parsing
├── strategy/
│   ├── engine.ts         # Core strategy logic and event handlers
│   └── levels.ts         # Level generation and logic
├── orders/
│   ├── manager.ts        # SDK wrappers for placing/cancelling orders
│   └── tracker.ts        # In-memory position and state management
└── utils/
    └── logger.ts         # Structured logging with timestamps
```

## ⚠️ Disclaimer

This bot is for educational purposes. Trading perpetuals involves significant risk. Always test your strategies on `inkTestnet` before moving to `inkMainnet`. The authors are not responsible for any financial losses incurred.
