# AgentBets Security Architecture

## Important: Resolution vs Settlement

**These are two different operations with different permissions:**

| Operation | Who Can Do It | What It Does | Security Critical |
|-----------|---------------|--------------|-------------------|
| **Resolution** | Only market creator (with `isCreatorResolver: true`) | Determines winning outcome (YES or NO) | **YES - Critical** |
| **Settlement** | Anyone | Distributes funds to winners based on resolution | No - just executes payout |

Settlement is just mechanical fund distribution - it reads the outcome already determined by the resolver and sends USDC to winners. There's nothing to manipulate there.

**Our security concern is RESOLUTION, not settlement.**

---

## The Problem: Creator Conflict of Interest

Poll.fun SDK has a feature called `isCreatorResolver: true` which allows the market creator to unilaterally resolve markets without voting. While this prevents the consensus voting vulnerability, it creates a new problem:

**If users create markets → users can resolve their own markets → massive conflict of interest**

Example attack:
1. User creates market: "Will $BONK hit $1 by tomorrow?"
2. User bets YES with 100 USDC
3. Other users bet NO with 500 USDC
4. Tomorrow, BONK is at $0.50 (should resolve NO)
5. **User resolves as YES and steals 500 USDC** ❌

This is unacceptable.

---

## The Solution: Bot as Universal Creator

**All markets are created by the bot's wallet, regardless of who proposes them.**

### How It Works

1. **Users are "Proposers" not "Creators"**
   - Frontend form: User suggests a market
   - Bot API: Agent programmatically proposes a market
   - Bot creates the market on-chain with its own keypair
   - User is tracked as "proposer" in database

2. **Bot Has Exclusive Resolution Rights**
   - Only the bot's keypair can resolve markets on-chain
   - Bot uses two-phase resolution (propose → admin confirms)
   - Users cannot manipulate outcomes

3. **Proposers Still Get Royalties**
   - Database tracks: `creatorAgent` (proposer) vs `creatorWallet` (bot)
   - Royalties (0.3%) go to the proposer, not the bot
   - Bot is just the "infrastructure" layer

---

## Implementation Details

### Poll.fun Service

**File:** `api/src/pollfun.js`

```javascript
async createMarket(params) {
  const {
    question,
    expectedUserCount = 50,
    minimumVoteCount = 1,
    proposerAgent // NEW: track who proposed it
  } = params;

  // SECURITY: ALWAYS use the bot's keypair as creator
  // Never allow user-provided keypairs to create markets
  const creator = this.creatorKeypair; // Bot's keypair from SOLANA_PRIVATE_KEY
  if (!creator) {
    return {
      success: false,
      error: 'Bot creator keypair not configured'
    };
  }

  // Create with bot as creator
  const result = await this.sdk.initializeBetV2({
    question,
    expectedUserCount,
    minimumVoteCount,
    isCreatorResolver: true, // Bot can resolve
    signers: [creator] // Bot signs
  });

  return {
    success: true,
    betPda: result.bet.toBase58(),
    creator: creator.publicKey.toBase58(), // Bot's address
    proposerAgent: proposerAgent || null, // Who proposed it
    note: 'Market created by AgentBets bot. Only bot can resolve.'
  };
}
```

### API Endpoint

**File:** `api/src/index.js`

```javascript
app.post('/api/onchain/markets', async (req, res) => {
  const {
    question,
    endDate,
    creatorAgent, // Who proposed it (for royalties)
    proposerWallet // Proposer's wallet (for UI display)
  } = req.body;

  // Bot creates the market (bot is on-chain creator)
  const result = await pollFunService.createMarket({
    question,
    expectedUserCount: 50,
    proposerAgent: creatorAgent // Track proposer
  });

  // Store in database
  const market = {
    id: uuidv4(),
    betPda: result.betPda,
    question,
    creatorWallet: result.creator, // Bot's wallet (on-chain)
    proposerWallet: proposerWallet || null, // Who proposed (UI)
    creatorAgent: creatorAgent || null, // Agent proposer (royalties)
    // ... other fields
  };

  // Track for royalties (proposer gets credit)
  if (creatorAgent) {
    royalties.recordMarketCreation(creatorAgent, market.id);
  }

  res.json({
    success: true,
    market,
    onChainData: {
      betPda: result.betPda,
      creator: result.creator, // Bot's address
      proposer: creatorAgent || proposerWallet || 'anonymous'
    },
    royaltyInfo: {
      proposer: creatorAgent,
      message: 'Bot is on-chain creator, but royalties go to proposer'
    }
  });
});
```

---

## Database Schema

### Market Record

```javascript
{
  id: "abc123",
  betPda: "7xKXtg...", // On-chain PDA
  question: "Will $SOL hit $100?",

  // On-chain creator (bot)
  creatorWallet: "48sWTmP...", // Bot's address

  // Off-chain proposer (user/agent)
  proposerWallet: "9vZbP...", // User's wallet (optional)
  creatorAgent: "@AIButters", // Agent handle (for royalties)

  // Market data...
  status: "active",
  endDate: "2026-02-15T00:00:00Z"
}
```

### Royalty Tracking

```javascript
{
  agentHandle: "@AIButters",
  marketsCreated: ["abc123", "def456"], // Markets they proposed
  earnedRoyalties: 5.2, // SOL earned from their markets
  wallet: "9vZbP..." // Where to send royalties
}
```

---

## Security Properties

### ✅ What This Prevents

1. **Self-Resolution Manipulation**: Users cannot resolve markets they propose
2. **Creator Front-Running**: Bot creates all markets, no race conditions
3. **Sybil Attacks**: Bot controls resolution, not vote count
4. **Unauthorized Resolution**: Only bot + admin can resolve

### ✅ What This Preserves

1. **Royalty Incentives**: Proposers still earn 0.3% from their markets
2. **User Participation**: Anyone can propose markets (free or with points)
3. **Decentralization**: On-chain settlement via Poll.fun
4. **Transparency**: All resolutions recorded on-chain

---

## Resolution Flow

### Two-Phase with Bot Creator

```
1. Market Ends
   └─> Bot checks oracle data

2. Bot Proposes Resolution
   └─> POST /api/markets/:id/propose-resolution
   └─> Market status: pending_confirmation

3. Admin Reviews
   └─> GET /api/markets/pending-resolutions
   └─> Verifies oracle data accuracy

4. Admin Confirms
   └─> POST /api/markets/:id/confirm-resolution
   └─> Requires admin wallet: ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG

5. Bot Resolves On-Chain
   └─> pollFunService.resolveMarket()
   └─> Uses bot's keypair (isCreatorResolver)
   └─> Distributes winnings

6. Bot Announces
   └─> Webhook to bot server
   └─> Tweet final resolution
```

---

## Frontend Implications

### Market Creation Form

**Before (Insecure):**
```typescript
// User creates market with their wallet
const tx = await createMarket(userKeypair, question);
// ❌ User could resolve their own market
```

**After (Secure):**
```typescript
// User proposes market, bot creates it
const response = await fetch('/api/onchain/markets', {
  method: 'POST',
  body: JSON.stringify({
    question: "Will $SOL hit $100?",
    endDate: "2026-02-15T00:00:00Z",
    creatorAgent: "@AIButters", // Proposer
    proposerWallet: wallet.publicKey.toBase58()
  })
});
// ✅ Bot creates market, user just proposes
```

### Display Changes

**Market Card:**
```
Created by AgentBets Bot
Proposed by @AIButters
```

**Royalties Display:**
```
You earn 0.3% from this market
(as the proposer, not creator)
```

---

## Environment Variables

### Required for Market Creation

```bash
# API Server (Replit)
SOLANA_PRIVATE_KEY=<bot-keypair-base58>  # REQUIRED for market creation
ESCROW_WALLET=48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM
SOLANA_RPC_URL=https://api.devnet.solana.com
```

**Important:** The `SOLANA_PRIVATE_KEY` must be the bot's keypair. This is the only wallet that can:
1. Create markets on-chain
2. Resolve markets on-chain
3. Sign settlement transactions

---

## Testing

### Test Bot-Created Market

```bash
# 1. Create market (user proposes, bot creates)
curl -X POST http://localhost:3002/api/onchain/markets \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Test market - will SOL hit $100?",
    "endDate": "2026-02-15T00:00:00Z",
    "creatorAgent": "@TestAgent",
    "proposerWallet": "9vZbP..."
  }'

# Response shows:
# - creatorWallet: bot's address
# - proposerWallet: user's address
# - creatorAgent: @TestAgent

# 2. Verify on-chain creator is bot
curl http://localhost:3002/api/onchain/markets/BETPDA

# 3. Try to resolve as user (should fail)
# (Cannot - only bot has creator keypair)

# 4. Resolve via bot API
curl -X POST http://localhost:3002/api/markets/:id/propose-resolution \
  -H "Content-Type: application/json" \
  -d '{ "proposedOutcome": "YES", "confidence": 95 }'

# 5. Admin confirms (only admin wallet)
curl -X POST http://localhost:3002/api/markets/:id/confirm-resolution \
  -H "Content-Type: application/json" \
  -d '{
    "finalOutcome": "YES",
    "adminWallet": "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG"
  }'

# 6. Bot resolves on-chain
# (Automatic - uses bot's keypair)
```

---

## Alternative Approaches Considered

### ❌ Option 1: User Creates + Vote Resolution
- Problem: Sybil attacks, vote manipulation
- Rejected: Poll.fun consensus voting is vulnerable

### ❌ Option 2: User Creates + Manual Override
- Problem: Still allows self-resolution by default
- Rejected: Requires constant monitoring

### ❌ Option 3: Whitelist of Trusted Creators
- Problem: Doesn't scale, gatekeeping
- Rejected: Limits platform growth

### ✅ Option 4: Bot Creates Everything (Chosen)
- Pros: Secure, scalable, preserves incentives
- Cons: Requires bot infrastructure
- Status: **Implemented**

---

## FAQ

**Q: Can users still propose markets?**
A: Yes! Anyone can propose markets via the API or frontend. The bot just creates them on-chain.

**Q: Who gets the creator royalties?**
A: The proposer (tracked in database), not the bot. Royalties go to the agent/user who suggested the market.

**Q: What if the bot's keypair is compromised?**
A: Critical issue. Store `SOLANA_PRIVATE_KEY` securely in Replit Secrets. Consider using a hardware wallet or MPC in production.

**Q: Can users see who proposed vs created?**
A: Yes. Frontend should show:
- "Created by: AgentBets Bot" (on-chain creator)
- "Proposed by: @AIButters" (proposer for royalties)

**Q: Does this work for off-chain markets too?**
A: Off-chain markets (escrow-based) don't have this issue since resolution is always manual/API-based, not wallet-based.

**Q: What about gas fees for market creation?**
A: Bot pays gas fees (SOL) when creating markets. Consider charging users a creation fee or using points system.

---

## Migration Plan

If you already have user-created markets:

1. **Identify user-created markets:**
   ```javascript
   const userMarkets = Array.from(markets.values())
     .filter(m => m.creatorWallet !== BOT_WALLET);
   ```

2. **Add security warnings:**
   ```javascript
   for (const market of userMarkets) {
     market.securityWarning = 'Created before bot-creator policy';
     market.manualResolutionRequired = true;
   }
   ```

3. **Disable self-resolution:**
   - Don't allow original creators to resolve
   - Force admin confirmation for these markets

4. **Going forward:**
   - All new markets use bot creator
   - Old markets gradually resolve and settle

---

## Summary

**AgentBets uses a bot-creator architecture where:**
- 🤖 Bot creates ALL markets on-chain (using its keypair)
- 👥 Users/agents are "proposers" (tracked off-chain)
- 💰 Proposers get royalties (0.3% of winnings)
- 🔒 Only bot + admin can resolve markets
- ✅ Prevents self-resolution manipulation
- ✅ Preserves creator incentives

This architecture provides security without sacrificing user participation or decentralization.
