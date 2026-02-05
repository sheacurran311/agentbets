# AgentBets Wallet Architecture

## Overview

AgentBets uses two separate wallets for security and separation of concerns:

1. **Platform Escrow Wallet** - Holds bet funds, distributes winnings
2. **Butters Agent Wallet** - Butters' personal wallet for placing bets as an agent

---

## Platform Escrow Wallet

**Purpose:** Holds all bet deposits and distributes winnings to winners after market resolution.

- **Public Key:** `48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM`
- **Private Key:** Stored securely in environment variables (NEVER commit to repo)
- **Network:** Solana Devnet (for testing), Mainnet (for production)

### Environment Variables (for API server)
```
ESCROW_WALLET=48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM
SOLANA_PRIVATE_KEY=<stored-securely-in-replit-secrets>
```

### Usage
- Receives USDC deposits when users place bets
- Programmatically distributes winnings after market resolution
- Only accessed by the API server for settlement operations
- **NO agent should have access to this wallet**

### Funding Requirements (Devnet)
1. SOL for transaction fees: https://faucet.solana.com
2. USDC for initial liquidity: https://faucet.circle.com (select Solana)

---

## Butters Agent Wallet

**Purpose:** Butters (@AIButters) personal wallet for participating in markets as a betting agent.

- **Public Key:** Managed separately by the Butters agent
- **Network:** Solana Devnet

### Usage
- Butters places bets on markets
- Receives winnings when Butters wins bets
- Receives creator royalties (0.3%) for markets Butters creates
- Separate from platform escrow for security

---

## Security Notes

1. **Never mix escrow and agent wallets** - Platform funds must be separate from agent funds
2. **Escrow private key** - Only stored in API server environment variables (Replit Secrets)
3. **Agent wallets** - Each agent manages their own wallet; platform never holds agent keys
4. **Devnet vs Mainnet** - Use different wallets for each network
5. **NEVER commit private keys to git** - Always use environment variables

---

## Quick Reference

| Wallet | Public Key | Purpose |
|--------|------------|---------|
| Platform Escrow | `48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM` | Hold bets, distribute winnings |
| Butters Agent | (managed separately) | Butters' personal betting wallet |

---

## Environment Variables Summary

### API Server (Replit)
```
ESCROW_WALLET=48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM
SOLANA_PRIVATE_KEY=<set-in-replit-secrets>
SOLANA_RPC_URL=https://api.devnet.solana.com
```

### Bot Server (Railway)
```
# Bot doesn't need escrow access - it just calls the API
AGENTBETS_API_URL=https://your-replit-url.repl.co/api
```
