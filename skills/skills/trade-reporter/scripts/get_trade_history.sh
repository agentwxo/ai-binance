#!/bin/bash
# get_trade_history.sh v1.3
# Fetches trades from /bot-orchestration/{bot}/history — the correct endpoint

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
HOURS="${HOURS:-24}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --hours) HOURS="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ "${MODE:-}" == "check" ]; then
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "${API_USER}:${API_PASS}" "${API_URL}/" --max-time 5 2>/dev/null || echo "000")
  [ "$HTTP" == "000" ] && echo "ERROR: Cannot reach ${API_URL}" && exit 1
  echo "OK: API reachable (HTTP ${HTTP})"
  exit 0
fi

echo "=== Fetching trade data ===" >&2

# Step 1: get all active bot containers (exclude infra)
CONTAINERS=$(curl -s -u "${API_USER}:${API_PASS}" \
  "${API_URL}/docker/active-containers" 2>/dev/null || echo "[]")

# Step 2: fetch history for each bot + executors summary
python3 - <<PYEOF
import json, urllib.request, urllib.error, base64, time

API_URL  = "${API_URL}"
API_USER = "${API_USER}"
API_PASS = "${API_PASS}"
HOURS    = int("${HOURS}")
NOW      = int(time.time())
START    = NOW - HOURS * 3600

INFRA = {"hummingbot-api", "hummingbot-postgres", "hummingbot-broker"}

def api_get(path):
    url = API_URL + path
    req = urllib.request.Request(url)
    creds = base64.b64encode(f"{API_USER}:{API_PASS}".encode()).decode()
    req.add_header("Authorization", f"Basic {creds}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)}

def safe(s):
    try:
        d = json.loads(s)
        return d.get("data", d) if isinstance(d, dict) and "data" in d else d
    except:
        return []

containers = safe("""${CONTAINERS}""")
bots = [c["name"] for c in (containers if isinstance(containers, list) else [])
        if c.get("name") not in INFRA]

import sys
print(f"  Active bots: {bots}", file=sys.stderr)

# Fetch history per bot, filter by time
all_trades = []
bot_histories = {}

for bot in bots:
    print(f"  → {bot}/history", file=sys.stderr)
    resp = api_get(f"/bot-orchestration/{bot}/history")

    # Unwrap nested structure: response.data.data.trades
    # Actual API response: {"status":"success","response":{"data":{"data":{"trades":[...]}}}}
    trades = []
    try:
        r = resp.get("response", {})
        # Try both depths
        trades = (r.get("data", {}).get("data", {}).get("trades", None) or
                  r.get("data", {}).get("trades", None) or
                  r.get("trades", None) or [])
    except:
        pass

    # Filter by time window
    filtered = []
    for t in (trades if isinstance(trades, list) else []):
        ts = t.get("trade_timestamp", 0)
        # timestamp may be in ms
        if ts > 1e12:
            ts = ts / 1000
        if ts >= START:
            t["_bot"] = bot
            filtered.append(t)

    bot_histories[bot] = {
        "total_trades": len(trades),
        "trades_in_window": len(filtered),
        "trades": filtered,
    }
    all_trades.extend(filtered)

# Also fetch executors summary
exec_summary = api_get("/executors/summary")
portfolio    = api_get("/portfolio/state")

# Build output summary
pairs = {}
for t in all_trades:
    sym = t.get("symbol", t.get("trading_pair", "UNKNOWN"))
    pairs.setdefault(sym, []).append(t)

summary = {
    "period_hours": HOURS,
    "start_unix": START,
    "end_unix": NOW,
    "active_bots": bots,
    "total_trades": len(all_trades),
    "pairs_traded": list(pairs.keys()),
    "trades_by_pair": {k: len(v) for k, v in pairs.items()},
}

output = {
    "summary": summary,
    "trades": all_trades,
    "bot_histories": bot_histories,
    "executors_summary": exec_summary,
    "portfolio": portfolio,
}

print(json.dumps(output, indent=2, ensure_ascii=False, default=str))
PYEOF
