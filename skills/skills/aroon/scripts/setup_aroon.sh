#!/bin/bash
# setup_aroon.sh
# Helper script: creates a ready-to-use aroon controller config
# and optionally starts a bot with it.
#
# Usage:
#   bash setup_aroon.sh --pair BTC-USDT --connector binance --capital 1000
#   bash setup_aroon.sh --help

set -e

# Load environment variables from .env if present
if [ -f ".env" ]; then
  export $(grep -v '^#' .env | xargs)
fi

API_URL="${API_URL:-http://localhost:8000}"
API_USER="${API_USER:-admin}"
API_PASS="${API_PASS:-admin}"

# ─── Defaults ────────────────────────────────────────────────────────────────
TRADING_PAIR="XCAD-USDT"
CONNECTOR="kucoin"
CANDLES_INTERVAL="1m"
TOTAL_AMOUNT="100"
ORDER_AMOUNT="10"
MIN_SPREAD="0.01"
MAX_SPREAD="0.05"
AROON_STRENGTH="0.5"
PERIOD_LENGTH="25"
ORDER_LEVELS="1"
TP_LONG="0.01"
TP_SHORT="0.01"
CONFIG_NAME=""
START_BOT=""
BOT_NAME=""

# ─── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pair) TRADING_PAIR="$2"; shift 2 ;;
    --connector) CONNECTOR="$2"; shift 2 ;;
    --interval) CANDLES_INTERVAL="$2"; shift 2 ;;
    --capital) TOTAL_AMOUNT="$2"; shift 2 ;;
    --order-amount) ORDER_AMOUNT="$2"; shift 2 ;;
    --min-spread) MIN_SPREAD="$2"; shift 2 ;;
    --max-spread) MAX_SPREAD="$2"; shift 2 ;;
    --strength) AROON_STRENGTH="$2"; shift 2 ;;
    --period) PERIOD_LENGTH="$2"; shift 2 ;;
    --levels) ORDER_LEVELS="$2"; shift 2 ;;
    --tp-long) TP_LONG="$2"; shift 2 ;;
    --tp-short) TP_SHORT="$2"; shift 2 ;;
    --config-name) CONFIG_NAME="$2"; shift 2 ;;
    --start) START_BOT="yes"; BOT_NAME="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: bash setup_aroon.sh [options]"
      echo ""
      echo "Options:"
      echo "  --pair        PAIR       Trading pair (default: XCAD-USDT)"
      echo "  --connector   NAME       Exchange connector (default: kucoin)"
      echo "  --interval    INTERVAL   Candle interval (default: 1m)"
      echo "  --capital     AMOUNT     Total capital in USDT (default: 100)"
      echo "  --order-amount AMOUNT    Per-order size in USDT (default: 10)"
      echo "  --min-spread  DECIMAL    Minimum spread fraction (default: 0.01)"
      echo "  --max-spread  DECIMAL    Maximum spread fraction (default: 0.05)"
      echo "  --strength    DECIMAL    Aroon oscillator strength factor (default: 0.5)"
      echo "  --period      INT        Aroon period length in candles (default: 25)"
      echo "  --levels      INT        Number of order levels per side (default: 1)"
      echo "  --tp-long     DECIMAL    Take profit for long positions (default: 0.01)"
      echo "  --tp-short    DECIMAL    Take profit for short positions (default: 0.01)"
      echo "  --config-name NAME       Config name (auto-generated if not set)"
      echo "  --start       BOT_NAME   Also start a bot with this name after config creation"
      echo ""
      echo "Examples:"
      echo "  bash setup_aroon.sh --pair BTC-USDT --connector binance --capital 500"
      echo "  bash setup_aroon.sh --pair ETH-USDT --capital 1000 --levels 3 --start eth_bot"
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

# Auto-generate config name from pair if not set
if [ -z "$CONFIG_NAME" ]; then
  SAFE_PAIR=$(echo "$TRADING_PAIR" | tr '[:upper:]' '[:lower:]' | tr '-' '_')
  CONFIG_NAME="aroon_${SAFE_PAIR}"
fi

echo "======================================================"
echo " Aroon Oscillator Controller Setup"
echo "======================================================"
echo "  Pair:          $TRADING_PAIR"
echo "  Connector:     $CONNECTOR"
echo "  Capital:       $TOTAL_AMOUNT USDT"
echo "  Order amount:  $ORDER_AMOUNT USDT"
echo "  Spreads:       $MIN_SPREAD – $MAX_SPREAD"
echo "  Aroon period:  $PERIOD_LENGTH candles ($CANDLES_INTERVAL)"
echo "  Order levels:  $ORDER_LEVELS per side"
echo "  TP Long/Short: $TP_LONG / $TP_SHORT"
echo "  Config name:   $CONFIG_NAME"
echo "======================================================"
echo ""

# ─── Prerequisite check ──────────────────────────────────────────────────────
echo "Checking API connection..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -u "${API_USER}:${API_PASS}" \
  "${API_URL}/api/v1/bots" \
  --max-time 5 2>/dev/null || echo "000")

if [ "$HTTP_STATUS" == "000" ] || [ "$HTTP_STATUS" == "401" ]; then
  echo "ERROR: Cannot connect to Hummingbot API at $API_URL (HTTP $HTTP_STATUS)"
  echo "Run the hummingbot-deploy skill first."
  exit 1
fi
echo "API reachable (HTTP $HTTP_STATUS)"
echo ""

# ─── Build config payload ─────────────────────────────────────────────────────
CONFIG_PAYLOAD=$(cat <<EOF
{
  "id": "$CONFIG_NAME",
  "controller_name": "aroon",
  "controller_type": "generic",
  "connector_name": "$CONNECTOR",
  "trading_pair": "$TRADING_PAIR",
  "candles_connector_name": "$CONNECTOR",
  "candles_trading_pair": "$TRADING_PAIR",
  "candles_interval": "$CANDLES_INTERVAL",
  "total_amount_quote": $TOTAL_AMOUNT,
  "order_amount": $ORDER_AMOUNT,
  "minimum_spread": $MIN_SPREAD,
  "maximum_spread": $MAX_SPREAD,
  "aroon_osc_strength_factor": $AROON_STRENGTH,
  "period_length": $PERIOD_LENGTH,
  "minimum_periods": -1,
  "order_levels": $ORDER_LEVELS,
  "order_level_amount": 0,
  "order_level_spread": 0.01,
  "take_profit_long": $TP_LONG,
  "take_profit_short": $TP_SHORT,
  "take_profit_order_lifetime": 1800.0,
  "take_profit_respect_limits": true,
  "order_lifetime": 10.0,
  "recreate_order_interval": 0.01,
  "post_cancel_delay": 0.01,
  "leverage": 1
}
EOF
)

# ─── Submit config to API ─────────────────────────────────────────────────────
echo "Creating controller config '$CONFIG_NAME'..."
RESPONSE=$(curl -s -X POST \
  -u "${API_USER}:${API_PASS}" \
  -H "Content-Type: application/json" \
  -d "$CONFIG_PAYLOAD" \
  "${API_URL}/api/v1/controllers/configs" \
  --max-time 30 2>/dev/null)

echo "API response:"
echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
echo ""

# ─── Optionally start the bot ─────────────────────────────────────────────────
if [ -n "$START_BOT" ] && [ -n "$BOT_NAME" ]; then
  echo "Starting bot '$BOT_NAME' with controller '$CONFIG_NAME'..."
  START_PAYLOAD=$(cat <<EOF
{
  "bot_name": "$BOT_NAME",
  "controller_config_name": "$CONFIG_NAME"
}
EOF
  )
  START_RESPONSE=$(curl -s -X POST \
    -u "${API_USER}:${API_PASS}" \
    -H "Content-Type: application/json" \
    -d "$START_PAYLOAD" \
    "${API_URL}/api/v1/bots" \
    --max-time 30 2>/dev/null)
  echo "Start response:"
  echo "$START_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$START_RESPONSE"
  echo ""
fi

echo "Done! Config '$CONFIG_NAME' is ready."
if [ -z "$START_BOT" ]; then
  echo "To start a bot: python scripts/start.py my_bot --controller $CONFIG_NAME"
fi
