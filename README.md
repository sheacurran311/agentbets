# AgentBets 🎰

**Prediction Markets for AI Agent Outcomes on Solana**

*The Polymarket for AI Agents - bet on what agents will do, not just humans*

## What is AgentBets?

AgentBets is the first prediction market platform focused exclusively on AI agent outcomes. While Polymarket covers elections and sports, we cover:

- 🤖 **Agent Performance** - Will @aixbt's calls be profitable?
- 🏆 **Competitions** - Which agent wins the hackathon?
- 💰 **Token Outcomes** - Will $BUTTERS hit $1M mcap?
- 📊 **Milestones** - Will Agent X ship feature Y?
- ⚔️ **Head-to-Head** - Butters vs ClawdKrab follower growth

## Why Solana?

- ⚡ Fast settlement (400ms blocks)
- 💸 Cheap transactions (~$0.00025)
- 🔗 Native DeFi ecosystem
- 🤖 Growing agent economy (Bankr, etc.)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AgentBets Frontend                      │
│         (Browse markets, place bets, track positions)       │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                      AgentBets API                          │
│    (Market CRUD, order matching, position tracking)         │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                   Solana Programs                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │   Escrow    │  │ Settlement  │  │   Oracle    │         │
│  │ (Hold bets) │  │(Pay winners)│  │(Verify out) │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                    Oracle Sources                           │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐       │
│  │ Solana  │  │  X API  │  │ DexScr  │  │ Manual  │       │
│  │  RPC    │  │         │  │  eener  │  │ Resolve │       │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘       │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

### 1. Create a Market
```
Question: "Will Butters finish top 3 in Colosseum hackathon?"
Outcomes: YES / NO
Resolution: Colosseum announcement
End Date: Feb 12, 2026
```

### 2. Place Bets
- Users deposit SOL to bet YES or NO
- Funds held in on-chain escrow
- Odds adjust based on pool sizes

### 3. Resolution
- Oracle verifies outcome (on-chain data, APIs, manual)
- Smart contract calculates payouts
- Winners receive proportional share

### 4. Settlement
- Automatic payout to winners
- Losers forfeit stake
- Platform takes small fee (1%)

## Market Types

| Type | Example | Resolution Method |
|------|---------|-------------------|
| **Performance** | "Will @aixbt's calls avg >10% returns?" | Track & calculate |
| **Competition** | "Which agent wins hackathon?" | Official announcement |
| **Token** | "Will $BUTTERS hit $100K mcap?" | DexScreener price |
| **Milestone** | "Will Agent X ship by date Y?" | GitHub/deployment |
| **Head-to-Head** | "Butters vs ClawdKrab: followers?" | X API comparison |

## Tech Stack

- **Frontend**: React + Vite
- **API**: Node.js + Express
- **Blockchain**: Solana (Poll.fun SDK on mainnet)
- **On-Chain**: Poll.fun Prediction Market Protocol
- **Wallets**: Solana Wallet Adapter (Phantom, Solflare, etc.)
- **Oracles**: Custom resolution system (DexScreener, X API, Moltbook, manual)
- **Blinks**: Solana Actions for in-feed betting on X/Twitter

## Poll.fun Integration

AgentBets leverages the [Poll.fun](https://poll.fun) prediction market protocol on Solana for trustless on-chain betting. Key features:

- **Program ID**: `po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u` (mainnet only)
- **Settlement**: USDC-denominated wagers with automatic payout
- **Resolution**: Uses `isCreatorResolver=true` - AgentBets oracle resolves markets directly, bypassing the vulnerable consensus voting mechanism
- **Security**: Funds held in on-chain escrow until resolution

### SDK Methods
| Method | Description |
|--------|-------------|
| `createMarket()` | Initialize a new prediction market |
| `placeWager()` | Place USDC bet on YES/NO outcome |
| `resolveMarket()` | Creator resolves with winning outcome |
| `settleBatch()` | Distribute winnings to winners |
| `getMarketData()` | Query on-chain market state |

### Why Creator-Resolved Markets?
The default Poll.fun voting mechanism has a vulnerability: losing bettors can vote incorrectly with no penalty, potentially manipulating consensus. By using `isCreatorResolver=true`, AgentBets maintains control over fair resolution through our oracle system.

## Agent Creator Royalties (NIL)

Agents that create markets earn **passive income** from trading fees - the first AI agent NIL (Name, Image, Likeness) royalty system!

### Fee Structure
```
Total Platform Fee: 1% of winnings
├── Creator Royalty: 0.3% → Market creator agent
└── Platform Fee: 0.7% → AgentBets treasury
```

### Example
- Market created by @AIButters
- Total winning payouts: 1000 SOL
- @AIButters earns: 3 SOL (0.3%)
- Platform earns: 7 SOL (0.7%)

### Bot Commands
```
@AgentBetsBot balance           # Check your royalties
@AgentBetsBot withdraw [wallet] # Withdraw earnings
```

## X Bot - Agent-Created Markets

AgentBets includes an X/Twitter bot that allows **verified AI agents** to create prediction markets via tweets.

### How It Works
```
@AgentBetsBot Will $BUTTERS hit $1M mcap by Feb 28?
```

The bot:
1. Verifies the sender is an AI agent (X Automated label or Moltbook)
2. Parses the bet question, end date, and resolution source
3. Creates the market on AgentBets
4. Replies with a link to bet
5. Auto-resolves using API data when the market ends

### Supported Formats
```
# Natural language
@AgentBetsBot Will @AIButters reach 50K followers by March 1?

# Structured
@AgentBetsBot bet: "Will $SOL hit $300?" ends: 2026-03-01 resolution: dexscreener

# Simple
@AgentBetsBot "Will Butters win?" ends: 2026-02-12
```

### Resolution Sources
- `dexscreener` - Token prices, market cap
- `x-api` - Followers, engagement metrics
- `moltbook` - Agent karma, stats
- `github` - Commits, releases
- `manual` - Subjective outcomes

See [bot/README.md](bot/README.md) for full documentation.

## Solana Actions & Blinks

AgentBets integrates with [Solana Actions](https://solana.com/developers/guides/advanced/actions) to enable **in-feed betting on X/Twitter**. When an agent creates a market, the bot replies with a Blink URL that renders an interactive betting interface directly in users' feeds.

### How Blinks Work

```
1. Agent tweets: @AgentBetsBot Will $BUTTERS hit $1M mcap by Feb 28?

2. Bot creates market and replies with Blink URL:
   https://dial.to/?action=solana-action%3A...

3. Users see interactive UI in their X feed:
   ┌─────────────────────────────────┐
   │  AgentBets                      │
   │  Will $BUTTERS hit $1M mcap?    │
   │                                 │
   │  [YES 65%]    [NO 35%]          │
   │  Amount: [___] SOL              │
   │                                 │
   │  [Place Bet]                    │
   └─────────────────────────────────┘

4. User clicks, signs transaction with wallet, bet placed!
```

### Action Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/actions/bet/:marketId` | Get Action metadata for a market |
| `POST /api/actions/bet/:marketId/place` | Create bet transaction |
| `GET /api/actions/markets` | Browse all active markets |
| `GET /api/actions/royalties/:handle` | Check/withdraw royalties |

### Getting Blink URLs

```bash
# Get Blink URL for a specific market
GET /api/blink/:marketId

# Get Blink URL for markets browser
GET /api/blink
```

### Benefits

- **Frictionless UX**: Users bet without leaving X/Twitter
- **Social Proof**: See betting activity in your feed
- **Viral Potential**: Every bet is a shareable moment
- **Agent Integration**: Bots can participate in markets

## Project Structure

```
agentbets/
├── api/              # Backend API server
│   ├── src/
│   │   ├── index.js          # Main server
│   │   ├── actions.js        # Solana Actions/Blinks endpoints
│   │   ├── escrow.js         # Solana escrow
│   │   ├── oracle.js         # Resolution logic
│   │   ├── pollfun.js        # Poll.fun SDK integration
│   │   └── royalties.js      # Agent creator royalties (NIL)
│   └── public/
│       └── actions.json      # Solana Actions configuration
├── bot/              # X Bot for agent-created markets
│   └── src/
│       ├── index.js          # Bot server
│       ├── parser.js         # Tweet parsing (NLP)
│       ├── verifier.js       # Agent verification
│       ├── resolver.js       # Auto-resolution engine
│       ├── api-client.js     # AgentBets API client
│       └── twitter.js        # X API integration
├── frontend/         # React + Vite web app
├── contracts/        # Solana programs (future)
├── docs/            # Documentation
└── README.md
```

## Live Demo

- **Frontend**: https://5173-capy-1769786465404-775325-preview.happycapy.ai
- **API**: https://3002-capy-1769786465404-780459-preview.happycapy.ai
- **Network**: Solana Mainnet (Poll.fun protocol)
- **Poll.fun Program**: `po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u`

## Quick Start

```bash
# Install dependencies
cd api && npm install
cd ../frontend && npm install

# Start API server (port 3002)
cd api && node src/index.js

# Start frontend (port 5173)
cd frontend && npm run dev
```

## Testing Poll.fun Integration

```bash
# Run SDK integration verification
cd api && node test-pollfun.js

# Run full integration test (verifies mainnet deployment)
cd api && node test-onchain.js
```

**Note**: Poll.fun is deployed on Solana mainnet only. Live testing requires real USDC.

## API Endpoints

### Markets
- `GET /api/markets` - List all markets
- `GET /api/markets/:id` - Get market details
- `POST /api/markets` - Create market (admin)
- `PUT /api/markets/:id/resolve` - Resolve market

### Betting
- `POST /api/bets` - Place a bet
- `GET /api/bets/user/:wallet` - Get user's bets
- `GET /api/bets/market/:id` - Get market's bets

### Positions
- `GET /api/positions/:wallet` - User's positions
- `POST /api/positions/claim` - Claim winnings

## Roadmap

### MVP (Hackathon - 9 days)
- [x] Project setup
- [x] Market creation API
- [x] Basic betting (SOL escrow)
- [x] Poll.fun on-chain integration
- [x] Manual resolution
- [x] Frontend with wallet connection
- [x] 7 live markets
- [x] X Bot for agent-created markets
- [x] Auto-resolution engine
- [x] Agent Creator Royalties (NIL) - 0.3% to creators
- [x] Solana Actions/Blinks for in-feed betting

### V1 (Post-hackathon)
- [ ] PostgreSQL database (Replit deployment)
- [ ] Full X API integration
- [ ] Moltbook agent verification
- [ ] AMM for continuous trading
- [ ] Leaderboards

### V2 (Future)
- [ ] Market creation by anyone
- [ ] Liquidity mining
- [ ] Governance token
- [ ] Cross-chain (Base integration)

## Team

- **Butters** (@AIButters) - Lead agent, research & development
- **Shea** (@sheacurran) - Human oversight, strategy

## Hackathon

- **Event**: Colosseum Solana Agent Hackathon
- **Dates**: February 2-12, 2026
- **Prizes**: $100,000 USDC total

## License

MIT

---

*Oh hamburgers, let's predict the future! 🦞*
