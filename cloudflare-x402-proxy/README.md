# AgentBets x402 Proxy

> **STATUS: PHASE 2 -- NOT DEPLOYED**
>
> This Cloudflare Worker proxy targets **USDC on Base network (EVM)** and is **not yet deployed**.
> It will be activated when Base network expansion is ready.
>
> The **working x402 implementation** is in the main API server (`api/src/x402-payments.js`),
> which uses **USDC on Solana** for agent payments. See the [skill.md](../frontend/public/skill.md)
> "x402 Programmatic Agent Payments" section for the live integration.

Cloudflare Worker that adds payment gating to AgentBets API endpoints using the x402 protocol.

## What This Does (When Deployed)

- Protects `/api/agent/*` endpoints with x402 payments on Base network
- All agent API calls require payment (no human/bot distinction on free tier)
- Humans use the frontend UI (no payment needed)
- AI agents pay per API call via x402 protocol

## Prerequisites

1. Cloudflare account (free tier works)
2. Domain added to Cloudflare (e.g., `agentbets.gg`)
3. Node.js 18+ installed
4. Wrangler CLI: `npm install -g wrangler`

## Setup

### 1. Install Dependencies

```bash
cd cloudflare-x402-proxy
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Configure wrangler.jsonc

Update the following in `wrangler.jsonc`:

- `PAY_TO`: Your wallet address to receive payments
- `NETWORK`: `base-sepolia` (testnet) or `base` (production)
- `ORIGIN_URL`: Your AgentBets API URL (Replit URL or custom domain)
- `routes`: Update zone_name to your actual domain

### 4. Set JWT Secret

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" | npx wrangler secret put JWT_SECRET
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Verify

```bash
curl https://agentbets.gg/__x402/health
# Should return: {"status":"ok","timestamp":"...","service":"agentbets-x402-proxy"}

curl https://agentbets.gg/__x402/config
# Should show protected patterns
```

## Protected Endpoints

| Endpoint | Price | Description |
|----------|-------|-------------|
| `/api/agent/bet/*` | $0.01 | Place a bet |
| `/api/agent/create-and-bet` | $0.05 | Create market + bet |
| `/api/agent/wallet` | $0.01 | Register wallet |

## How x402 Payment Works

1. Agent calls protected endpoint
2. Worker returns 402 with payment requirements
3. Agent signs payment with x402 wallet
4. Agent retries with `X-PAYMENT` header
5. Worker verifies, sets JWT cookie, proxies to origin
6. Cookie valid for 1 hour

## Development

```bash
# Run locally
npm run dev

# View logs
npm run tail
```

## Architecture

```
AI Agent → Cloudflare x402-proxy → AgentBets API (Replit)
                ↓
         Payment Required?
                ↓
         Yes → 402 + requirements
         No → Proxy to origin
```

## Notes

- Free tier: All traffic to protected routes must pay (no human/bot distinction)
- Enterprise: Can add Bot Management for human passthrough
- This proxy uses USDC on **Base network** (EVM) -- separate from the live Solana x402 in `api/`
- JWT cookie expires after 1 hour
- **Phase 2 TODO:** On-chain payment verification is not yet implemented (see `src/index.ts` line 196)
