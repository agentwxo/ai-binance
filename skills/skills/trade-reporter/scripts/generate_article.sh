#!/bin/bash
# generate_article.sh v2.0
# Fetches real trades and outputs a complete ready-to-print article.
# Run this script and print output verbatim.

set -e

for ENV_FILE in ".env" "$HOME/.hummingbot/.env" "$HOME/.env"; do
  if [ -f "$ENV_FILE" ]; then
    export $(grep -v '^#' "$ENV_FILE" | xargs)
    break
  fi
done

API_URL="${API_URL:-http://localhost:8000}"
API_USER="${API_USER:-admin}"
API_PASS="${API_PASS:-admin}"

echo "📡 Загружаю данные..." >&2
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRADE_DATA=$(bash "$SCRIPT_DIR/get_trade_history.sh" 2>/dev/null)

echo "✅ Генерирую статью..." >&2

python3 - "$TRADE_DATA" << 'PYEOF'
import sys, json, datetime

trade_data = json.loads(sys.argv[1])
trades     = trade_data.get("trades", [])
summary    = trade_data.get("summary", {})
exec_s     = trade_data.get("executors_summary", {})

total   = summary.get("total_trades", 0)
bots    = summary.get("active_bots", [])
bot     = bots[0] if bots else "unknown"
now     = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

if total == 0:
    print(f"😴 **За последние 24 часа сделок не было.**\n🤖 Бот {bot} ожидает сигнала.\n⚡ AgentWXO · {now}")
    sys.exit(0)

volume   = sum(float(t.get("price","0")) * float(t.get("quantity","0")) for t in trades)
buys     = [t for t in trades if t.get("trade_type") == "BUY"]
sells    = [t for t in trades if t.get("trade_type") == "SELL"]
prices   = [float(t.get("price","0")) for t in trades]
avg      = sum(prices)/len(prices) if prices else 0
symbol   = trades[0].get("symbol","?")
market   = trades[0].get("market","?").upper()
base     = trades[0].get("base_asset", symbol.split("-")[0])
pnl      = exec_s.get("total_pnl_quote", 0)

CURR = {
    "WOD":   "WOD — игровой токен экосистемы World of Dypians.",
    "BTC":   "Bitcoin — первая и крупнейшая криптовалюта.",
    "ETH":   "Ethereum — платформа для смарт-контрактов.",
    "SOL":   "Solana — высокоскоростной блокчейн.",
    "BNB":   "BNB — нативный токен Binance.",
    "BIFI":  "Beefy Finance — yield оптимизатор.",
    "AUDIO": "Audius — децентрализованная музыкальная платформа.",
}
desc = CURR.get(base, f"{base} — криптовалюта на {market}.")

lines = []
for t in sorted(trades, key=lambda x: x.get("trade_timestamp",0))[:20]:
    ts  = t.get("trade_timestamp", 0)
    if ts > 1e12: ts /= 1000
    dt  = datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")
    p   = float(t.get("price","0"))
    q   = float(t.get("quantity","0"))
    em  = "📉 ПРОДАЖА" if t.get("trade_type")=="SELL" else "📈 ПОКУПКА"
    lines.append(f"   {em} | {dt}\n      💲 {p:.5f} USDT  📦 {q:.2f} {base}  💵 {p*q:.2f} USDT")

if len(trades) > 20:
    lines.append(f"   ...и ещё {len(trades)-20} сделок")

print(f"""📊 **ДНЕВНОЙ ОТЧЁТ О ТОРГОВЛЕ**
🗓️ За последние 24 часа
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🤖 Бот: {bot}
📋 Сделок: {total}
💵 Объём: {volume:.2f} USDT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 **СДЕЛКИ — {symbol} на {market}**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   📈 Покупок: {len(buys)}  📉 Продаж: {len(sells)}

""" + "\n\n".join(lines) + f"""

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 **{base}** — {desc}
   💹 Средняя цена: {avg:.5f} USDT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 **ИТОГИ**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧩 Стратегия: aroon | Сделок: {total} | P&L: {pnl:.4f} USDT

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏁 Бот {bot} совершил {total} сделок по {symbol} на {market}. Объём {volume:.2f} USDT, средняя цена {avg:.5f} USDT. Покупок: {len(buys)}, продаж: {len(sells)}.

⚡ AI AgentWXO · {now}""")
PYEOF
