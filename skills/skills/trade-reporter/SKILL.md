---
name: trade-reporter
version: 1.0.0
description: Fetches trade history for the last 24 hours from Hummingbot API and generates a beautiful emoji-rich article summarizing all trades, including pair info, buy/sell direction, prices, volumes, and P&L.
triggers:
  - "напиши статью"
  - "write article"
  - "trade report"
  - "отчёт о сделках"
  - "покажи сделки за сутки"
  - "what trades happened"
  - "daily trade summary"
  - "история торговли"
prerequisites:
  - hummingbot-deploy
---

# 📰 Trade Reporter Skill

This skill connects to the Hummingbot API, retrieves all trades executed in the last **24 hours**, and formats them into a beautiful, human-readable article with emojis covering:

- 🪙 Which cryptocurrency pairs were traded
- 📈 Buy (LONG) or 📉 Sell (SHORT) direction
- 💰 Entry price, quantity, and total value
- ✅ Realized profit (only if positive)
- 🤖 Which bot/strategy executed the trade
- 🕒 Timestamp of each trade

## Trigger

When the user says **"Напиши статью"**, **"Write article"**, **"Trade report"**, or any similar phrase asking for a summary of recent trades, execute this skill automatically.

## Execution Flow

### Step 1 — Check prerequisites

```bash
bash scripts/get_trade_history.sh --check
```

Verify that `API_URL`, `API_USER`, and `API_PASS` are set. If not, instruct the user to run `hummingbot-deploy` skill first or configure `.env`.

### Step 2 — Fetch trade history (last 24 hours)

```bash
bash scripts/get_trade_history.sh
```

This script calls the Hummingbot API endpoint `GET /api/v1/trades` with a filter for the last 86400 seconds and returns a JSON array of trade objects.

Expected JSON fields per trade:
- `id` — trade ID
- `timestamp` — ISO 8601 datetime
- `trading_pair` — e.g. `BTC-USDT`
- `trade_type` — `BUY` or `SELL`
- `price` — execution price
- `amount` — quantity traded
- `quote_amount` — total value in quote currency
- `realized_pnl` — profit/loss (null if not closed)
- `exchange` — exchange name
- `bot_id` — bot that executed the trade
- `strategy` — strategy name

### Step 3 — Fetch bot performance (optional enrichment)

```bash
bash scripts/get_bot_performance.sh
```

Retrieves overall P&L per bot for the last 24h to enrich the article with summary statistics.

### Step 4 — Generate the article

Using the data retrieved in Steps 2–3, compose a **beautiful emoji-rich article** in the language the user is speaking (Russian or English) following the **Article Template** below.

---

## 📝 Article Template

Use this exact structure when composing the article. Fill in real data from the API responses.

```
📊 **ДНЕВНОЙ ОТЧЁТ О ТОРГОВЛЕ**
🗓️ За период: {DATE_FROM} — {DATE_TO}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🤖 Всего ботов торговало: {BOT_COUNT}
📋 Всего сделок за сутки: {TOTAL_TRADES}
💵 Общий объём торгов: {TOTAL_VOLUME} USDT

{IF TOTAL_PNL > 0}
💚 Итоговая прибыль за сутки: +{TOTAL_PNL} USDT 🎉
{ELSE IF TOTAL_PNL == 0}
⚖️ Итог за сутки: безубыточно
{END}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 **СДЕЛКИ ПО ПАРАМ**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{FOR EACH TRADING_PAIR}
🪙 **{TRADING_PAIR}** ({EXCHANGE})
   🔢 Сделок: {PAIR_TRADE_COUNT}
   {FOR EACH TRADE IN PAIR}
   {IF TRADE_TYPE == BUY}
   📈 ПОКУПКА | {TIMESTAMP}
   {ELSE}
   📉 ПРОДАЖА | {TIMESTAMP}
   {END}
      💲 Цена: {PRICE}
      📦 Количество: {AMOUNT} {BASE_CURRENCY}
      💵 Сумма: {QUOTE_AMOUNT} {QUOTE_CURRENCY}
      {IF REALIZED_PNL != null AND REALIZED_PNL > 0}
      ✅ Прибыль: +{REALIZED_PNL} USDT
      {END}
      🤖 Бот: {BOT_ID} | 📐 Стратегия: {STRATEGY}
   {END}
{END}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💡 **О КРИПТОВАЛЮТАХ**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{FOR EACH UNIQUE BASE_CURRENCY TRADED}
🔹 **{CURRENCY}** — {BRIEF_DESCRIPTION_OF_CURRENCY}
   📊 Всего сделок с этим активом: {CURRENCY_TRADE_COUNT}
   💹 Средняя цена исполнения: {AVG_PRICE}
{END}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈 **ИТОГИ ПО СТРАТЕГИЯМ**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

{FOR EACH STRATEGY}
🧩 Стратегия: **{STRATEGY_NAME}**
   ✅ Прибыльных сделок: {WIN_COUNT}
   💰 P&L: {STRATEGY_PNL} USDT
{END}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏁 **ЗАКЛЮЧЕНИЕ**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{SUMMARY_SENTENCE — 2-3 предложения об итогах дня, самой активной паре, лучшей сделке}

⚡ Отчёт сгенерирован автоматически Hummingbot AI Agent
🕒 {CURRENT_DATETIME}
```

---

## ⚠️ Edge Cases

- **No trades in 24h**: Output a friendly message:
  > 😴 За последние 24 часа сделок не было. Боты отдыхают!

- **API unreachable**: Instruct user to check `.env` settings and run `hummingbot-deploy`.

- **Missing P&L**: If `realized_pnl` is null for all trades, skip the profit section gracefully with a note:
  > ℹ️ P&L недоступен — позиции ещё открыты.

- **Large number of trades (>50)**: Show top 10 by volume, then summarize the rest:
  > ...и ещё {N} сделок

- **Losses**: Do NOT mention losing trades or negative P&L in the article. Only report profitable trades and neutral results.

---

## 🌐 Currency Info Integration

When generating the article, use your built-in knowledge to add a brief 1-sentence description of each traded cryptocurrency in the "О КРИПТОВАЛЮТАХ" section. Examples:

- **BTC**: "Bitcoin — первая и крупнейшая децентрализованная криптовалюта."
- **ETH**: "Ethereum — платформа для смарт-контрактов и децентрализованных приложений."
- **SOL**: "Solana — высокоскоростной блокчейн с низкими комиссиями."
- **BNB**: "BNB — нативный токен экосистемы Binance."
- **USDC**: "USDC — стейблкоин, привязанный к доллару США."
- **XRP**: "XRP — токен сети Ripple для быстрых международных платежей."
- **ADA**: "Cardano — блокчейн платформа с научным подходом к разработке."
- **DOGE**: "Dogecoin — популярная мем-криптовалюта с активным сообществом."
- **MATIC**: "Polygon — решение второго уровня для масштабирования Ethereum."
- **DOT**: "Polkadot — мультичейн протокол для соединения разных блокчейнов."

For unlisted currencies, use your general knowledge to provide a brief description.

---

## 📖 Language Detection

- If the user's request is in **Russian** → generate the article in Russian using the Russian template above.
- If the user's request is in **English** → generate the article in English with equivalent emoji formatting.
- Default language: Russian.

---

## References

- Hummingbot API docs: `{API_URL}/docs`
- Trade history endpoint: `GET /api/v1/trades?start_time={UNIX_TS}&end_time={UNIX_TS}`
- Bot performance endpoint: `GET /api/v1/bots/{bot_id}/performance`
- Related skill: `hummingbot-deploy` — used to set up API connection
