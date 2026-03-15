#!/bin/bash
# get_bot_performance.sh v1.2
# Fetches bot performance using correct Hummingbot API v1.0.1 endpoints

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

fetch() {
  curl -s -u "${API_USER}:${API_PASS}" \
    -H "Content-Type: application/json" \
    --max-time 30 "$1" 2>/dev/null || echo '{"error":"request failed"}'
}

echo "Fetching bot performance..." >&2

# Active containers to find bot names
CONTAINERS=$(fetch "${API_URL}/docker/active-containers")
BOT_RUNS=$(fetch "${API_URL}/bot-orchestration/bot-runs")
EXEC_POSITIONS=$(fetch "${API_URL}/executors/positions/summary")
PORTFOLIO_HIST=$(fetch "${API_URL}/portfolio/history")

# Fetch history for each bot
BOTS_HISTORY="{}"
INFRA='["hummingbot-api","hummingbot-postgres","hummingbot-broker"]'

python3 - <<PYEOF
import sys, json, subprocess

def parse(s):
    try:
        d = json.loads(s)
        return d.get("data", d) if isinstance(d, dict) and "data" in d else d
    except:
        return {}

containers = parse("""${CONTAINERS}""")
bot_runs   = parse("""${BOT_RUNS}""")
exec_pos   = parse("""${EXEC_POSITIONS}""")
portfolio  = parse("""${PORTFOLIO_HIST}""")

INFRA = {"hummingbot-api", "hummingbot-postgres", "hummingbot-broker"}
bots = [c["name"] for c in (containers if isinstance(containers, list) else [])
        if c.get("name") not in INFRA]

import urllib.request, urllib.error, base64

def api_get(path):
    url = "${API_URL}" + path
    req = urllib.request.Request(url)
    creds = base64.b64encode(b"${API_USER}:${API_PASS}").decode()
    req.add_header("Authorization", f"Basic {creds}")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except:
        return {}

bot_histories = {}
for bot in bots:
    hist = api_get(f"/bot-orchestration/{bot}/history")
    if hist:
        bot_histories[bot] = hist

output = {
    "active_bots": bots,
    "bot_runs": bot_runs,
    "bot_histories": bot_histories,
    "executor_positions": exec_pos,
    "portfolio_history": portfolio,
}
print(json.dumps(output, indent=2, ensure_ascii=False, default=str))
PYEOF
