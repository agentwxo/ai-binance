# Skills

AI agent skills for [AgentWXO](https://trade.coinmarketfacts.com) algorithmic trading infrastructure.

Built on the [Agent Skills](https://agentskills.io) open standard.

## Quick Start

```bash
npx skills add agentwxo/skills
```

This installs Hummingbot skills to your AI agents (Claude Code, Cursor, etc.).

## Commands

```bash
npx skills add agentwxo/skills                              # Install all skills
npx skills add agentwxo/skills --skill hummingbot-deploy    # Install specific skill
npx skills list                                               # List installed skills
npx skills remove                                             # Remove installed skills
```

## Available Skills

| Skill                                                  | Description                                                       | Installs |
| ------------------------------------------------------ | ----------------------------------------------------------------- | :------: |
| [hummingbot-deploy](./skills/hummingbot-deploy/)       | Deploy Hummingbot API server, MCP server, and Condor Telegram bot |    55    |
| [lp-agent](./skills/lp-agent/)                         | Automated liquidity provision on CLMM DEXs (Meteora/Solana)       |    49    |
| [connectors-available](./skills/connectors-available/) | Check exchange availability and search token trading rules        |    41    |
| [slides-generator](./skills/slides-generator/)         | Create Binance-branded PDF slides from markdown                   |    30    |
| [find-arbitrage-opps](./skills/find-arbitrage-opps/)   | Find arbitrage opportunities across exchanges for fungible pairs  |    8     |
| [hummingbot](./skills/hummingbot/)                     | Hummingbot CLI commands via API                                   |    4     |
| [aroon](./skills/aroon/)                               | Aroon Oscillator V2 controller — dynamic spread adjustment with FIFO position tracking and auto take-profit | — |
| [hummingbot-developer](./skills/hummingbot-developer/) | Build and run Hummingbot stack from source                        |    —     |

## Usage

After installing, ask your AI agent:

- "Deploy Hummingbot API"
- "Open a liquidity position on Meteora"
- "Configure aroon strategy for BTC-USDT"

## Prerequisites

Skills interact with the Hummingbot API server. Use the `hummingbot-deploy` skill to deploy it.

Configure credentials via `.env` file:

```bash
API_URL=http://localhost:8000
API_USER=admin
API_PASS=admin
```

## Repository Structure

```
hummingbot/skills/
├── skills/           # Skill definitions (SKILL.md + scripts/)
└── .github/          # CI/CD workflows
```

| Component   | Description               | Docs                             |
| ----------- | ------------------------- | -------------------------------- |
| **skills/** | Trading skill definitions | Each skill has its own README    |
| **app/**    | Skills browser webapp     | [app/README.md](./app/README.md) |

## Development

### Skills

Each skill is a folder with:

- `SKILL.md` - Skill definition with frontmatter metadata
- `scripts/` - Shell scripts the agent can execute

### Webapp

```bash
cd app
npm install
npm run dev
```

See [app/README.md](./app/README.md) for deployment instructions.

## Links

- [Agent Skills Spec](https://agentskills.io)
