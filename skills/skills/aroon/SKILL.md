---
name: aroon
version: 2.0.0
description: Advanced Hummingbot V2 generic controller based on the Aroon Oscillator. Dynamically adjusts bid/ask spreads based on trend strength, manages positions via FIFO tracking from SQLite, and places take-profit limit-maker orders automatically.
triggers:
  - "aroon"
  - "aroon oscillator"
  - "aroon strategy"
  - "aroon controller"
  - "aroon"
  - "use aroon"
  - "start aroon"
  - "create aroon"
  - "configure aroon"
prerequisites:
  - hummingbot-deploy
---

# 📈 Aroon Oscillator Controller

An advanced **V2 generic controller** for Hummingbot that uses the **Aroon Oscillator** to determine market trend direction and strength, then dynamically adjusts bid/ask spreads and places limit-maker orders accordingly. Positions are tracked with **FIFO accounting** from the SQLite database, and take-profit orders are managed automatically.

> ⚠️ **V2 controller only.** Requires Hummingbot API running via the `hummingbot-deploy` skill.

---

## How It Works

### 1. Aroon Indicator Calculation

The controller fetches candle data and computes:

- **Aroon Up** = `((periods since last high) / period_length) × 100`
- **Aroon Down** = `((periods since last low) / period_length) × 100`
- **Aroon Oscillator** = `Aroon Up − Aroon Down`

Range: `−100` (strong downtrend) to `+100` (strong uptrend). Values near `0` indicate consolidation.

### 2. Dynamic Spread Adjustment Formula

Spreads are recalculated every cycle:

```
diff = maximum_spread − minimum_spread

ask_increase = diff × (1 − aroon_up / 100)
bid_increase = diff × (1 − aroon_down / 100)
trend_factor = (aroon_osc / 100) × aroon_osc_strength_factor

ask_spread = (minimum_spread + ask_increase) × (1 + trend_factor)
bid_spread = (minimum_spread + bid_increase) × (1 − trend_factor)

both clamped to [minimum_spread, maximum_spread]
```

**Effect:** When trend is bullish (Aroon Up high), ask spread widens (harder to sell) and bid spread narrows (easier to buy). When trend is bearish, the opposite occurs.

### 3. Order Placement

- Orders are placed as **LIMIT_MAKER** (post-only) to avoid taker fees
- Level IDs: `aroon_buy_1`, `aroon_buy_2`, ..., `aroon_sell_1`, `aroon_sell_2`, ...
- Order size is **dynamically calculated**: `min(available_capital, order_amount)`
- Available capital = `total_amount_quote − capital_in_active_orders − capital_in_tp_orders`
- Minimum order size: **5 USDT** (orders below this are skipped)
- Orders expire after `order_lifetime` seconds and are recreated

### 4. Position Tracking (FIFO from SQLite)

On every cycle, positions are recalculated from the `TradeFill` table in the SQLite database using **FIFO accounting**:

- Each BUY fills the earliest SELL lots first (and vice versa)
- Remaining lots form the current open position with a correct **average entry price**
- This handles partial fills, multiple take-profits, and split executions correctly
- Database path is configurable via `database_path`

### 5. Take-Profit Management

- When a position is open, a **LIMIT_MAKER** take-profit order is placed automatically
- Level IDs: `tp_long` (for BUY positions) and `tp_short` (for SELL positions)
- TP price = `avg_entry_price × (1 + take_profit_long)` for longs
- TP price = `avg_entry_price × (1 − take_profit_short)` for shorts
- If TP price/amount changes (due to partial fills), the old TP is cancelled and a new one is placed
- `take_profit_respect_limits: true` prevents TP from being placed beyond `price_floor` / `price_ceiling`
- TP orders have their own lifetime: `take_profit_order_lifetime` seconds

### 6. Price Bounds

- `price_ceiling`: BUY orders suspended if market price exceeds this value (`0` = disabled)
- `price_floor`: SELL orders suspended if market price falls below this value (`0` = disabled)
- TP orders also respect these bounds when `take_profit_respect_limits: true`

### 7. Network Resilience

- Up to **5 consecutive network errors** are tolerated before entering cooldown
- Cooldown duration doubles exponentially with each additional error (starting at 10s)
- Orders are not created during network cooldown
- Executor cleanup runs when total executor count exceeds **500** (keeps 100 most recent inactive)

---

## Configuration Parameters

All parameters are set in the bot YAML config file.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `controller_name` | string | `aroon` | Must be exactly `aroon` |
| `controller_type` | string | `generic` | Must be `generic` |
| `connector_name` | string | `kucoin` | Exchange connector (e.g. `binance`, `gate_io`, `kucoin`) |
| `trading_pair` | string | `XCAD-USDT` | Trading pair in `BASE-QUOTE` format |
| `candles_connector_name` | string | same as connector | Exchange used for candle data (can differ from trading exchange) |
| `candles_trading_pair` | string | same as trading_pair | Pair used for candle data |
| `candles_interval` | string | `1m` | Candle interval: `1m`, `5m`, `15m`, `1h`, `4h`, `1d` |
| `total_amount_quote` | decimal | `100` | Total capital budget in quote currency (USDT). Hard cap for all open orders combined |
| `order_amount` | decimal | `10` | Target size per order in USDT. Actual size may be smaller if capital is constrained |
| `minimum_spread` | decimal | `0.01` | Minimum bid/ask spread fraction (0.01 = 1%). Floor for spread calculations |
| `maximum_spread` | decimal | `0.05` | Maximum bid/ask spread fraction (0.05 = 5%). Ceiling for spread calculations |
| `aroon_osc_strength_factor` | decimal | `0.5` | How strongly the Aroon Oscillator shifts spreads. Higher = stronger trend reaction. Range: 0.0–1.0 |
| `period_length` | integer | `25` | Number of candles used for Aroon calculation. Longer periods = smoother, slower signals |
| `period_duration` | float | `60.0` | Duration of one candle period in seconds (60 = 1 min candles) |
| `minimum_periods` | integer | `-1` | Minimum candle count required before indicator is used. `-1` starts immediately with any data |
| `order_levels` | integer | `1` | Number of order levels per side. `1` = one buy + one sell. `3` = three buys + three sells |
| `order_level_amount` | decimal | `0` | Fixed order amount per level in base currency. If `0`, calculated from `order_amount` automatically |
| `order_level_spread` | decimal | `0.01` | Additional spread distance between successive order levels (0.01 = 1%) |
| `price_type` | integer | `2` (MidPrice) | Price reference type. `1` = BestBid, `2` = MidPrice (default), `3` = BestAsk, `4` = LastTrade |
| `price_ceiling` | decimal | `0` | Upper price limit. BUY orders suspended above this. `0` = disabled |
| `price_floor` | decimal | `0` | Lower price limit. SELL orders suspended below this. `0` = disabled |
| `leverage` | integer | `1` | Leverage for perpetual futures. `1` = spot-equivalent (no leverage) |
| `position_mode` | string | `HEDGE` | Position mode for perpetuals: `HEDGE` (separate long/short) or `ONEWAY` |
| `recreate_order_interval` | float | `0.01` | Minimum seconds between order creation cycles (throttle). Very low = aggressive recreation |
| `order_lifetime` | float | `10.0` | Seconds before an unfilled limit order is cancelled and recreated |
| `take_profit_long` | decimal | `0.01` | Take-profit target for long positions as fraction (0.01 = 1% above entry) |
| `take_profit_short` | decimal | `0.01` | Take-profit target for short positions as fraction (0.01 = 1% below entry) |
| `take_profit_order_lifetime` | float | `1800.0` | Seconds before a TP order expires (30 min default). TP is recreated after expiry |
| `post_cancel_delay` | float | `0.01` | Seconds to wait after cancelling an order before allowing new order creation |
| `take_profit_respect_limits` | boolean | `true` | If `true`, TP orders outside `price_floor`/`price_ceiling` are not placed |
| `database_path` | string | `data/conf_v2_with_controllers_.sqlite` | Path to Hummingbot's SQLite database for FIFO position tracking |

---

## Example Configurations

### Conservative (stable coins / low volatility)

```yaml
id: aroon_stable
controller_name: aroon
controller_type: generic
connector_name: binance
trading_pair: ETH-USDT
candles_connector_name: binance
candles_trading_pair: ETH-USDT
candles_interval: 5m
total_amount_quote: 500
order_amount: 50
minimum_spread: 0.003
maximum_spread: 0.008
aroon_osc_strength_factor: 0.3
period_length: 25
order_levels: 2
order_level_spread: 0.002
take_profit_long: 0.005
take_profit_short: 0.005
take_profit_order_lifetime: 3600.0
```

### Balanced (medium volatility assets)

```yaml
id: aroon_xcad_usdt
controller_name: aroon
controller_type: generic
connector_name: kucoin
trading_pair: XCAD-USDT
candles_connector_name: kucoin
candles_trading_pair: XCAD-USDT
candles_interval: 1m
total_amount_quote: 1000
order_amount: 25
minimum_spread: 0.005
maximum_spread: 0.008
aroon_osc_strength_factor: 0.5
period_length: 25
order_levels: 3
order_level_spread: 0.003
take_profit_long: 0.01
take_profit_short: 0.015
take_profit_order_lifetime: 1800.0
```

### Aggressive (high volatility / trending markets)

```yaml
id: aroon_btc_aggressive
controller_name: aroon
controller_type: generic
connector_name: binance
trading_pair: BTC-USDT
candles_connector_name: binance
candles_trading_pair: BTC-USDT
candles_interval: 1m
total_amount_quote: 2000
order_amount: 100
minimum_spread: 0.01
maximum_spread: 0.05
aroon_osc_strength_factor: 0.8
period_length: 14
order_levels: 1
take_profit_long: 0.02
take_profit_short: 0.02
price_ceiling: 0
price_floor: 0
```

### Perpetual Futures (with leverage)

```yaml
id: aroon_btc_perp
controller_name: aroon
controller_type: generic
connector_name: binance_perpetual
trading_pair: BTC-USDT
candles_connector_name: binance_perpetual
candles_trading_pair: BTC-USDT
candles_interval: 5m
total_amount_quote: 1000
order_amount: 50
minimum_spread: 0.005
maximum_spread: 0.02
aroon_osc_strength_factor: 0.5
period_length: 25
leverage: 3
position_mode: HEDGE
take_profit_long: 0.015
take_profit_short: 0.015
take_profit_respect_limits: true
```

---

## Quick Start

### 1. Deploy Hummingbot API (if not running)

```bash
# Use hummingbot-deploy skill
```

### 2. Connect your exchange

```bash
python scripts/connect.py kucoin --api-key YOUR_KEY --secret-key YOUR_SECRET --passphrase YOUR_PASS
```

### 3. Create the controller config

```bash
python scripts/create.py controller aroon_xcad_usdt --template aroon
```

Or save the YAML config directly to the Hummingbot `conf/controllers/` directory.

### 4. Start the bot

```bash
python scripts/start.py aroon_bot --controller aroon_xcad_usdt
```

### 5. Monitor status

```bash
python scripts/status.py aroon_bot --performance
```

### 6. Check history

```bash
python scripts/history.py aroon_bot --summary
```

---

## Tuning Guide

### Aroon Oscillator Interpretation

| Aroon Osc Value | Market Condition | Recommended Action |
|-----------------|------------------|--------------------|
| `+70 to +100` | Strong uptrend | Tighten bid spread, widen ask spread |
| `+25 to +70` | Moderate uptrend | Slight bid preference |
| `-25 to +25` | Sideways / consolidation | Balanced spreads, ideal for market making |
| `-70 to -25` | Moderate downtrend | Slight ask preference |
| `-100 to -70` | Strong downtrend | Tighten ask spread, widen bid spread |

The controller handles this automatically. Use `aroon_osc_strength_factor` to control how aggressively it reacts.

### Key Parameters to Tune

| Goal | Parameter to Adjust |
|------|---------------------|
| React more to trends | Increase `aroon_osc_strength_factor` (towards 1.0) |
| Smoother, slower signals | Increase `period_length` (e.g. 50) |
| Capture faster moves | Decrease `period_length` (e.g. 14) and use shorter candle interval |
| More orders in the book | Increase `order_levels` (e.g. 3–5) |
| Better capital utilisation | Decrease `order_amount` relative to `total_amount_quote` |
| Tighter risk | Set `price_floor` and `price_ceiling` |
| Less TP rebalancing | Increase `take_profit_order_lifetime` |

### Database Path

The default database path `data/conf_v2_with_controllers_.sqlite` must match your actual Hummingbot instance. If you renamed your config file, the database name changes accordingly:

```
data/conf_v2_with_controllers_<config_suffix>.sqlite
```

Check your running Hummingbot data directory to confirm the correct path.

---

## Important Behaviours to Know

- **Startup grace period:** The controller waits **5 seconds** after start before placing any orders. This gives candle data time to load.
- **Minimum order size:** Orders below **5 USDT** are automatically skipped. Ensure `order_amount` is at least 5 USDT.
- **Capital accounting:** The controller tracks all capital in both entry orders and TP orders. It will not create new orders if `total_amount_quote` is fully deployed.
- **Max 10 orders per cycle:** To prevent API flooding, at most 10 executor creation actions are sent per decision cycle.
- **Executor cleanup:** When total executors exceed 500, inactive ones are pruned to the 100 most recent.
- **FIFO position tracking:** Positions are recalculated from the database every cycle. If the database is missing or empty, no TP orders are placed.
- **TP order recreation:** If a TP order's price or amount changes due to partial fills, the old TP is cancelled (`keep_position=True`) and a new one placed at the correct price.
- **Cycle reset:** After all TP orders complete and positions are flat, the order timer resets and a fresh cycle begins immediately.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No orders placed after start | Startup grace period | Wait 5 seconds |
| Orders placed but tiny | `order_amount` < 5 USDT | Increase `order_amount` |
| No TP orders | Database not found or position = 0 | Check `database_path` |
| Spreads not adjusting | `minimum_periods` not met | Set `minimum_periods: -1` or wait for more candles |
| Network cooldown triggered | API connection issues | Check exchange API key and connectivity |
| Position mismatch | FIFO calculation differs from exchange | Check `connector_name` matches exchange exactly |
| Price out of bounds errors | `price_ceiling` / `price_floor` set too tight | Widen bounds or set to `0` to disable |

---

## When to Use Aroon

**Aroon is ideal when:**
- You want to automatically adapt spreads to trending vs. ranging conditions
- You are market-making volatile assets with clear cyclical price swings
- You need robust position tracking across partial fills and multiple TP executions
- You are trading on KuCoin, Binance, Gate.io, or any connector supported by Hummingbot

**Consider other controllers when:**
- Market is extremely choppy with no discernible trend (Aroon may over-adjust spreads)
- You need a simpler fixed-spread approach (use `pmm_v1`)
- You need DEX liquidity provision (use `lp-agent`)

---

## Related Skills

- **hummingbot-deploy** — Deploy the Hummingbot API server (required before using this skill)
- **hummingbot** — Core CLI commands: connect, balance, start, stop, status, history
- **lp-agent** — DEX liquidity provision on Meteora/Solana CLMM pools
