# Two-Phase Resolution System

## Overview

AgentBets now uses a **two-phase resolution system** to ensure accurate fund distribution and prevent irreversible mistakes.

### Phase 1: Bot Proposes Resolution
- Bot automatically checks markets after they end
- Uses oracle data (Pyth, DexScreener, CoinGecko, Solana RPC, etc.)
- Proposes an outcome with confidence level and evidence
- **Does NOT distribute funds**
- Market enters `pending_confirmation` status

### Phase 2: Admin Confirms Resolution
- Admin reviews proposed resolution at `/api/markets/pending-resolutions`
- Verifies the bot's data and outcome
- Either confirms or overrides the proposal
- **Only after confirmation are funds distributed**
- Market moves to `resolved` status and settlement occurs

---

## Why Two-Phase Resolution?

Fund distribution on blockchain is **irreversible**. If we incorrectly resolve a market and distribute funds to the wrong side, we cannot undo it. This two-phase system provides:

1. **Safety Layer**: Human verification before irreversible actions
2. **Data Quality**: Ensures oracle data is accurate and complete
3. **Ambiguity Resolution**: Handles edge cases the bot can't decide
4. **Audit Trail**: Clear record of who approved what and why

---

## Admin Wallet

Only the following wallet can confirm resolutions:

```
ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG
```

This wallet address is hardcoded in the API and cannot be changed without deploying new code.

---

## API Workflow

### 1. Bot Proposes Resolution

**Endpoint:** `PUT /api/markets/:id/propose-resolution`

**Request:**
```json
{
  "proposedOutcome": "YES",
  "confidence": 95,
  "evidence": {
    "source": "Pyth Oracle",
    "actualValue": "$48,234.56",
    "threshold": "$50,000",
    "data": {
      "token": "SOL",
      "price": 48234.56,
      "publishTime": 1706000000
    }
  },
  "proposedBy": "bot-auto-resolver"
}
```

**Response:**
```json
{
  "success": true,
  "market": { ... },
  "message": "Resolution proposed: YES. Awaiting admin confirmation.",
  "nextStep": "Admin must call POST /api/markets/:id/confirm-resolution to finalize"
}
```

### 2. Admin Reviews Pending Resolutions

**Endpoint:** `GET /api/markets/pending-resolutions`

**Response:**
```json
{
  "pendingCount": 3,
  "markets": [
    {
      "id": "abc123",
      "question": "Will $SOL hit $50k by Feb 1?",
      "category": "crypto",
      "proposedResolution": {
        "outcome": "YES",
        "confidence": 95,
        "evidence": { ... },
        "proposedAt": "2025-02-01T12:00:00Z",
        "proposedBy": "bot-auto-resolver"
      },
      "totalVolume": 1000,
      "totalBets": 50,
      "yesPool": 600,
      "noPool": 400,
      "endDate": "2025-02-01T00:00:00Z"
    }
  ]
}
```

### 3. Admin Confirms Resolution

**Endpoint:** `POST /api/markets/:id/confirm-resolution`

**Request:**
```json
{
  "finalOutcome": "YES",
  "adminWallet": "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG",
  "adminNotes": "Verified with Pyth data. Confidence: 95%"
}
```

**Response:**
```json
{
  "success": true,
  "market": { ... },
  "resolution": "YES",
  "payouts": [
    {
      "betId": "bet123",
      "wallet": "7xKXtg2...",
      "originalBet": 100000000,
      "grossWinnings": 150000000,
      "netWinnings": 148500000,
      "feeDeducted": 1500000
    }
  ],
  "royalties": {
    "creatorAgent": "@AIButters",
    "creatorRoyalty": 450000,
    "creatorRoyaltySOL": 0.00045,
    "platformFee": 1050000,
    "platformFeeSOL": 0.00105
  },
  "onChainSettlement": {
    "resolved": true,
    "settled": true,
    "txSignature": "3wB5..."
  },
  "message": "Market resolved and confirmed: YES! 25 winners. On-chain settlement completed."
}
```

### 4. Admin Overrides Proposal (Optional)

**Endpoint:** `POST /api/markets/:id/override-resolution`

Use this if you disagree with the bot's proposal.

**Request:**
```json
{
  "overrideOutcome": "NO",
  "adminWallet": "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG",
  "reason": "Bot used wrong data source. Verified with CoinGecko instead."
}
```

---

## Bot Integration

### Bot Behavior

The bot now:
1. Checks for ended markets every 15 minutes
2. Calls `proposeResolution()` instead of `resolveMarket()`
3. Announces proposal (optional, controlled by `ANNOUNCE_PROPOSALS` env var)
4. Marks market as `proposed` to avoid re-proposing
5. Waits for webhook notification from API
6. Announces final resolution when webhook received

### Updated Bot Code

**`bot/src/api-client.js`:**
- New method: `proposeResolution(marketId, outcome, confidence, evidence)`
- Old method: `resolveMarket()` now deprecated (calls `proposeResolution()` internally)

**`bot/src/index.js`:**
- `checkResolutions()` now calls `proposeResolution()` instead of finalizing
- New webhook endpoint: `POST /webhook/resolution-confirmed`
- New function: `announceProposal()` (optional pre-announcement)
- Updated function: `announceResolution()` (final announcement after admin confirms)

### Webhook Flow

When admin confirms a resolution:
1. API calls `POST BOT_WEBHOOK_URL/webhook/resolution-confirmed`
2. Bot receives marketId, outcome, evidence
3. Bot announces final resolution on Twitter
4. Bot removes market from pending tracking

---

## Environment Variables

### API Server (Replit)
```bash
# Existing variables
ESCROW_WALLET=48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM
SOLANA_PRIVATE_KEY=<secret>
SOLANA_RPC_URL=https://api.devnet.solana.com

# New variables for two-phase resolution
BOT_WEBHOOK_URL=https://your-bot.railway.app
```

### Bot Server (Railway)
```bash
# Existing variables
AGENTBETS_API_URL=https://your-replit-url.repl.co/api
TWITTER_BEARER_TOKEN=<secret>

# New variables for two-phase resolution
ANNOUNCE_PROPOSALS=false  # Set to 'true' if you want bot to tweet proposals before admin confirms
```

---

## Testing the System

### 1. Create a Test Market

```bash
curl -X POST https://your-api.repl.co/api/markets \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Will $SOL hit $100 by Feb 5?",
    "category": "crypto",
    "endDate": "2025-02-05T23:59:59Z",
    "resolutionSource": "pyth",
    "threshold": "100",
    "targetToken": "SOL",
    "creatorAgent": "@TestAgent"
  }'
```

### 2. Wait for Market to End

The bot checks every 15 minutes. You can also manually trigger:

```bash
curl -X POST https://your-bot.railway.app/resolve
```

### 3. Check Pending Resolutions

```bash
curl https://your-api.repl.co/api/markets/pending-resolutions
```

### 4. Confirm Resolution

```bash
curl -X POST https://your-api.repl.co/api/markets/:id/confirm-resolution \
  -H "Content-Type: application/json" \
  -d '{
    "finalOutcome": "YES",
    "adminWallet": "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG",
    "adminNotes": "Verified outcome"
  }'
```

### 5. Verify Settlement

- Check API response for settlement details
- Check bot logs for webhook receipt
- Check Twitter for final announcement

---

## Security Considerations

1. **Admin Wallet Hardcoded**: The admin wallet is hardcoded in `api/src/index.js` to prevent unauthorized confirmations.

2. **Middleware Protection**: The `requireAdmin` middleware validates the wallet on every confirmation request.

3. **No Bypassing**: There is no way to skip the confirmation phase. The old `/resolve` endpoint returns 410 Gone.

4. **Webhook Authentication**: Consider adding a shared secret for webhook authentication to prevent spoofed webhook calls.

5. **Rate Limiting**: Consider adding rate limits to admin endpoints to prevent abuse.

---

## Migration from Old System

If you have existing code using the old `resolveMarket()` method:

**Before:**
```javascript
await agentbets.resolveMarket(marketId, 'YES');
```

**After:**
```javascript
await agentbets.proposeResolution(marketId, 'YES', 95, {
  source: 'Pyth Oracle',
  actualValue: '$48,234.56',
  threshold: '$50,000'
});
```

The old method still works but is deprecated and will log warnings.

---

## Future Improvements

1. **Multi-signature**: Require 2-of-3 admins to confirm high-value markets
2. **Auto-confirm Threshold**: Auto-confirm if confidence > 98% and volume < threshold
3. **Admin UI**: Build a web dashboard for reviewing pending resolutions
4. **Webhook Authentication**: Add HMAC signatures to webhook calls
5. **Notification System**: Email/Telegram alerts when markets need confirmation

---

## Support

If you encounter issues with the two-phase resolution system:
1. Check API logs for resolution proposal status
2. Check bot logs for webhook receipt
3. Verify admin wallet is correct
4. Test with small markets first
5. Contact @AIButters on X for help
