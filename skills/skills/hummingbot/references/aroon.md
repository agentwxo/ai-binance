# Aroon Controller

An advanced generic controller that uses the Aroon Oscillator to determine market trends and place orders accordingly.

## Overview

The Aroon Controller uses the Aroon Up and Aroon Down indicators to gauge trend strength and direction. It dynamically adjusts spreads and places orders based on the oscillator's value.

**Best for:**
- Trend following and mean reversion strategies
- Markets with clear cyclical trends
- Spot and perpetual futures

## Strategy Logic

1. **Indicator Calculation:** Fetches candle data and calculates the Aroon Oscillator (Aroon Up - Aroon Down).
2. **Spread Adjustment:** Dynamically adjusts bid and ask spreads based on the oscillator strength.
3. **Order Placement:** Places buy/sell orders at the adjusted spreads.
4. **Take Profit:** Manages positions with configurable take profit limits.
5. **Position Management:** Supports leverage and specific position modes (e.g., HEDGE) for perpetuals.

## Configuration Parameters

Below is a detailed list of all parameters and their descriptions.

| Parameter | Description |
|-----------|-------------|
| `connector_name` | Exchange name (e.g. binance, gate_io) |
| `trading_pair` | Trading pair the strategy works with. Format: BASE-QUOTE |
| `candles_interval` | Candle interval used for analysis (1m, 5m, 1h) |
| `total_amount_quote` | Total strategy capital in quote currency (in USDT) |
| `order_amount` | Size of one limit order in USDT. At start, this amount must be in USDT or base currency, otherwise orders won't be placed |
| `minimum_spread` | Minimum spread between buy and sell orders (in fractions). 0.01 = 1% |
| `maximum_spread` | Maximum spread at which strategy can place orders |
| `aroon_osc_strength_factor`| Strength of Aroon indicator influence on spread changes. Higher value = stronger reaction to trend |
| `period_length` | Number of candles used for Aroon Oscillator calculation |
| `minimum_periods` | Minimum number of candles for correct indicator calculation (-1 starts calculation without waiting for candle count) |
| `order_levels` | Number of order levels in grid. 1 - one order per side, 3 - three levels per side |
| `order_level_amount` | Fixed volume (in base currency) per order level. If 0, calculated automatically |
| `order_level_spread` | Additional distance between order levels (in price fractions) |
| `price_ceiling` | Upper price boundary. If market is above this value - buying is suspended |
| `price_floor` | Lower price boundary. If market is below - selling is suspended |
| `recreate_order_interval` | Minimum time (in seconds) between order recreation |
| `order_lifetime` | Limit order lifetime (in seconds). After expiration - order is canceled and recreated |
| `take_profit_long` | Profit target (in fractions, 0.01 = 1%) for closing long positions |
| `take_profit_short` | Profit target for short positions |
| `take_profit_order_lifetime`| Take-Profit order lifetime (in seconds) |
| `take_profit_respect_limits`| If true, TP is not placed beyond price_floor and price_ceiling |
| `database_path` | Path to database (SQLite) where trades and positions are saved |

## Example Configuration

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
take_profit_long: 0.01
take_profit_short: 0.015
```

## When to Use

**Use Aroon when:**
- You want to trade based on trend strength and direction.
- You need a strategy that automatically adjusts spreads based on market momentum.
- You are trading volatile assets with clear cyclical swings.
