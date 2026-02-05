# Two-Phase Resolution Deployment Checklist

## Pre-Deployment

- [ ] Review all code changes in this PR
- [ ] Read TWO_PHASE_RESOLUTION.md documentation
- [ ] Backup current database/state (if applicable)
- [ ] Test endpoints locally before deploying

---

## API Server Changes (Replit)

### Files Modified:
- `api/src/index.js` - Added two-phase resolution endpoints

### New Environment Variables:
```bash
BOT_WEBHOOK_URL=https://your-bot.railway.app
```

### Deployment Steps:
1. [ ] Add `BOT_WEBHOOK_URL` to Replit Secrets
2. [ ] Deploy to Replit
3. [ ] Verify health endpoint: `GET /health`
4. [ ] Test pending resolutions endpoint: `GET /api/markets/pending-resolutions`
5. [ ] Verify admin wallet is correct in logs

---

## Bot Server Changes (Railway)

### Files Modified:
- `bot/src/index.js` - Updated resolution workflow, added webhook endpoint
- `bot/src/api-client.js` - Added `proposeResolution()` method

### New Environment Variables (Optional):
```bash
ANNOUNCE_PROPOSALS=false  # Set to 'true' to tweet proposals before admin confirms
```

### Deployment Steps:
1. [ ] (Optional) Add `ANNOUNCE_PROPOSALS` to Railway environment
2. [ ] Deploy to Railway
3. [ ] Verify health endpoint: `GET /health`
4. [ ] Check logs for "AgentBets X Bot Running"
5. [ ] Test webhook endpoint: `POST /webhook/resolution-confirmed`

---

## Integration Testing

### 1. Create Test Market
```bash
curl -X POST $AGENTBETS_API_URL/markets \
  -H "Content-Type: application/json" \
  -d '{
    "question": "Test market - Will $SOL be above $50 in 1 minute?",
    "category": "test",
    "endDate": "'$(date -u -d '+2 minutes' '+%Y-%m-%dT%H:%M:%SZ')'",
    "resolutionSource": "pyth",
    "threshold": "50",
    "targetToken": "SOL",
    "creatorAgent": "@TestAgent"
  }'
```

- [ ] Market created successfully
- [ ] Market ID received: `_______________`

### 2. Wait for Market to End
- [ ] Wait 2 minutes for market to end
- [ ] Manually trigger bot: `curl -X POST $BOT_URL/resolve`
- [ ] Check bot logs for "Market has ended, checking resolution"

### 3. Verify Proposal
- [ ] Check pending resolutions: `curl $AGENTBETS_API_URL/markets/pending-resolutions`
- [ ] Verify market is in `pending_confirmation` status
- [ ] Review proposed outcome and evidence
- [ ] Confidence level looks reasonable (>70%)

### 4. Confirm Resolution
```bash
curl -X POST $AGENTBETS_API_URL/markets/:id/confirm-resolution \
  -H "Content-Type: application/json" \
  -d '{
    "finalOutcome": "YES",
    "adminWallet": "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG",
    "adminNotes": "Test confirmation"
  }'
```

- [ ] Confirmation successful
- [ ] Resolution finalized
- [ ] Settlement completed (if on-chain)
- [ ] Payouts calculated
- [ ] Royalties calculated

### 5. Verify Webhook
- [ ] Check bot logs for "Webhook received resolution confirmation"
- [ ] Check bot logs for "final resolution announced"
- [ ] Check Twitter for final announcement (if enabled)

### 6. Test Override
Create another test market, wait for proposal, then:

```bash
curl -X POST $AGENTBETS_API_URL/markets/:id/override-resolution \
  -H "Content-Type: application/json" \
  -d '{
    "overrideOutcome": "NO",
    "adminWallet": "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG",
    "reason": "Testing override functionality"
  }'
```

- [ ] Override successful
- [ ] Proposed resolution updated
- [ ] Can now confirm with new outcome

---

## Security Verification

- [ ] Admin wallet is hardcoded: `ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG`
- [ ] `requireAdmin` middleware is present on confirm/override endpoints
- [ ] Old `/resolve` endpoint returns 410 Gone
- [ ] No way to bypass confirmation phase
- [ ] Webhook endpoint exists and responds

---

## Monitoring

### API Server (Replit)
Monitor these log messages:
- `[Resolution] Market {id} proposed: {outcome}`
- `[Resolution] Market {id} CONFIRMED: {outcome} by admin`
- `[Resolution] Webhook sent to bot for market {id}`

### Bot Server (Railway)
Monitor these log messages:
- `[Resolver] Market {id} has ended, checking resolution...`
- `[Resolver] Resolution proposed for market {id}`
- `[Webhook] Received resolution confirmation for market {id}`
- `[Announce] Announcing FINAL resolution for market {id}`

---

## Rollback Plan

If issues occur:

1. **Revert API Changes:**
   - Revert `api/src/index.js` to previous version
   - Restore old `/resolve` endpoint
   - Redeploy to Replit

2. **Revert Bot Changes:**
   - Revert `bot/src/index.js` and `bot/src/api-client.js`
   - Redeploy to Railway

3. **Database/State:**
   - If markets stuck in `pending_confirmation`, manually update status to `resolved`
   - Use override endpoint to force resolution if needed

---

## Post-Deployment

- [ ] Monitor first 3 real market resolutions closely
- [ ] Check Twitter announcements are working
- [ ] Verify payouts are correct
- [ ] Verify royalties are calculated correctly
- [ ] Update documentation if needed
- [ ] Notify team that two-phase resolution is live

---

## Known Issues / Edge Cases

1. **Webhook Failures:** If webhook fails, bot won't announce. Admin can manually tweet or retry webhook.

2. **Multiple Admins:** Currently only one admin wallet. To add more, update `ADMIN_WALLET` constant and redeploy.

3. **High Volume:** If many markets need confirmation, consider batching or auto-confirm low-confidence markets.

4. **Oracle Failures:** If all oracles fail, bot won't propose. Market will need manual resolution via override endpoint.

---

## Success Criteria

Two-phase resolution is working correctly if:
- [x] Bot proposes resolutions after markets end
- [x] Proposals appear in pending resolutions endpoint
- [x] Only admin wallet can confirm
- [x] Confirmation triggers settlement
- [x] Webhook notifies bot
- [x] Bot announces final resolution
- [x] No funds distributed until admin confirms

---

## Contact

For issues or questions:
- GitHub Issues: [link to repo]
- Twitter: @AIButters
- Email: [your email]
