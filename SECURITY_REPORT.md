# AgentBets Security Analysis Report

**Date**: February 3, 2026
**Auditor**: Claude Security Analysis
**Scope**: Full codebase security review

## Executive Summary

This security assessment covers the AgentBets prediction market platform, including the API backend, frontend, and Solana blockchain integrations. The analysis identifies **13 critical/high severity issues** and **8 medium severity issues** that should be addressed before production deployment.

**Risk Rating**: HIGH (not production-ready without remediation)

---

## Critical Vulnerabilities

### 1. [CRITICAL] No Authentication/Authorization on Admin Endpoints

**Location**: `api/src/index.js:160-214`, `api/src/index.js:727-774`, `api/src/index.js:968-1026`

**Description**: Admin-only endpoints for market resolution, escrow payouts, and on-chain resolution have no authentication.

**Affected Endpoints**:
- `PUT /api/markets/:id/resolve` - Anyone can resolve markets
- `POST /api/escrow/payout` - Anyone can trigger payouts
- `POST /api/onchain/resolve` - Anyone can resolve on-chain markets
- `POST /api/onchain/settle` - Anyone can trigger settlements

**Impact**: An attacker can:
- Resolve any market to their preferred outcome
- Trigger unauthorized fund transfers
- Manipulate market outcomes for financial gain

**Recommendation**:
```javascript
// Add JWT/API key authentication middleware
const authMiddleware = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.put('/api/markets/:id/resolve', authMiddleware, async (req, res) => {...});
```

---

### 2. [CRITICAL] Transaction Verification Bypassed

**Location**: `api/src/index.js:253-254`

**Description**: The bet placement endpoint has a comment stating "For MVP: trust the client" and does not verify the Solana transaction signature before recording the bet.

```javascript
// In production: verify txSignature on-chain
// For MVP: trust the client (or verify via RPC)
```

**Impact**: Attacker can:
- Submit fake transaction signatures
- Record bets without actually transferring funds
- Drain winnings pool with fraudulent bets

**Recommendation**: Always verify transactions on-chain:
```javascript
const verification = await escrow.verifyBetTransaction(txSignature, wallet, amountLamports);
if (!verification.verified) {
  return res.status(400).json({ error: verification.error });
}
```

---

### 3. [CRITICAL] Private Key Exposure Risk

**Location**: `api/src/escrow.js:22-34`, `api/src/pollfun.js:34-37`

**Description**: Private keys are loaded from environment variables and used directly. If logs contain errors with stack traces, keys could be exposed.

**Impact**: Full compromise of escrow wallet and all user funds.

**Recommendation**:
- Use Hardware Security Module (HSM) or cloud KMS
- Never log keypair-related errors
- Implement key rotation procedures

---

### 4. [CRITICAL] In-Memory Storage Data Loss

**Location**: `api/src/index.js:34-36`

**Description**: All market, bet, and position data is stored in JavaScript Maps that are lost on server restart.

```javascript
const markets = new Map();
const bets = new Map();
const positions = new Map();
```

**Impact**:
- Complete data loss on any server restart
- Bets recorded but not in database after restart
- Financial disputes with no audit trail

**Recommendation**: Implement persistent database (PostgreSQL as mentioned in comments).

---

## High Severity Vulnerabilities

### 5. [HIGH] Race Condition in Betting Pool Updates

**Location**: `api/src/index.js:270-287`

**Description**: Pool updates are not atomic. Multiple concurrent bets could cause incorrect odds calculation.

```javascript
if (outcome === 'YES') {
  market.yesPool += amountLamports;  // Not atomic
} else {
  market.noPool += amountLamports;   // Not atomic
}
```

**Impact**: Financial losses due to incorrect payout calculations.

**Recommendation**: Use database transactions with row-level locking.

---

### 6. [HIGH] Insufficient Input Validation

**Location**: Multiple endpoints

**Issues**:
- No wallet address format validation (accepts any string)
- No maximum bet amount limits
- Negative amounts not checked (only `> 0`)
- No rate limiting on market creation

**Examples**:
```javascript
// api/src/index.js:228
const { marketId, outcome, amount, wallet } = req.body;
// `wallet` is never validated as a valid Solana public key
```

**Recommendation**:
```javascript
const { PublicKey } = require('@solana/web3.js');
try {
  new PublicKey(wallet); // Validates format
} catch {
  return res.status(400).json({ error: 'Invalid wallet address' });
}
```

---

### 7. [HIGH] CORS Completely Open

**Location**: `api/src/index.js:23`

**Description**: CORS is enabled with no restrictions, allowing any origin to make requests.

```javascript
app.use(cors());
```

**Impact**: Enables CSRF attacks and malicious frontends to interact with the API.

**Recommendation**:
```javascript
app.use(cors({
  origin: ['https://agentbets.gg', 'http://localhost:5173'],
  credentials: true
}));
```

---

### 8. [HIGH] Escrow Balance Depletion Attack

**Location**: `api/src/escrow.js:147-197`

**Description**: `processWinnerPayout` doesn't track which payouts have been processed. Same winning bet could be claimed multiple times.

**Impact**: Drain entire escrow balance through repeated claims.

**Recommendation**: Track payout status in database, mark positions as "claimed".

---

### 9. [HIGH] Integer Overflow in Lamport Calculations

**Location**: `api/src/index.js:251`

**Description**: `Math.floor(amount * LAMPORTS_PER_SOL)` could overflow with very large amounts.

**Impact**: Incorrect bet amounts, potential for manipulation.

**Recommendation**:
```javascript
const BN = require('bn.js');
const amountLamports = new BN(amount).mul(new BN(LAMPORTS_PER_SOL));
```

---

## Medium Severity Vulnerabilities

### 10. [MEDIUM] Error Messages Leak Implementation Details

**Location**: Throughout API

**Description**: Raw error messages are returned to clients:
```javascript
res.status(500).json({ error: error.message });
```

**Impact**: Attackers gain information about system internals.

**Recommendation**: Log full errors server-side, return generic messages to clients.

---

### 11. [MEDIUM] No Request Body Size Limits

**Location**: `api/src/index.js:24`

**Description**: `express.json()` is used without size limits.

```javascript
app.use(express.json());
```

**Impact**: Denial of Service through large request payloads.

**Recommendation**:
```javascript
app.use(express.json({ limit: '100kb' }));
```

---

### 12. [MEDIUM] Market End Date Not Enforced for Resolution

**Location**: `api/src/index.js:160-214`

**Description**: Markets can be resolved before their end date - only checks if market is active.

**Impact**: Market creators could resolve early to manipulate outcomes.

**Recommendation**:
```javascript
if (new Date() < new Date(market.endDate)) {
  return res.status(400).json({ error: 'Market has not ended yet' });
}
```

---

### 13. [MEDIUM] Frontend Trusts Backend Data Without Validation

**Location**: `frontend/src/App.jsx:427-428`

**Description**: Transaction data from API is deserialized and sent without validation:
```javascript
const txBuffer = Buffer.from(wagerData.transaction.serialized, 'base64')
const transaction = Transaction.from(txBuffer)
```

**Impact**: Malicious backend could craft transactions that steal user funds.

**Recommendation**: Validate transaction instructions match expected program IDs.

---

### 14. [MEDIUM] No HTTPS Enforcement

**Location**: API server configuration

**Description**: No TLS/HTTPS configuration. Server runs on plain HTTP.

**Impact**: Man-in-the-middle attacks can intercept sensitive data.

**Recommendation**: Configure HTTPS with valid certificates.

---

### 15. [MEDIUM] Missing Security Headers

**Location**: API responses

**Missing Headers**:
- `Strict-Transport-Security`
- `X-Content-Type-Options`
- `X-Frame-Options`
- `Content-Security-Policy`

**Recommendation**: Use `helmet` middleware:
```javascript
const helmet = require('helmet');
app.use(helmet());
```

---

### 16. [MEDIUM] Hardcoded Escrow Wallet

**Location**: `api/src/index.js:31`, `frontend/src/App.jsx:7`

**Description**: Escrow wallet address is hardcoded in both backend and frontend.

**Impact**: Difficult to rotate keys if compromised; frontend can be modified to use attacker's address.

---

### 17. [MEDIUM] No Rate Limiting

**Location**: All API endpoints

**Description**: No rate limiting on any endpoint.

**Impact**: DoS attacks, brute force attempts.

**Recommendation**:
```javascript
const rateLimit = require('express-rate-limit');
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
}));
```

---

## Low Severity Issues

### 18. [LOW] Console Logging of Sensitive Operations

**Location**: Multiple files

**Description**: Wallet addresses and transaction details are logged to console.

### 19. [LOW] No Input Sanitization for Question Field

**Location**: `api/src/index.js:49`

**Description**: Market questions are stored without sanitization (XSS possible if rendered incorrectly).

### 20. [LOW] Predictable UUID Generation

**Location**: `api/src/index.js:62`

**Description**: UUIDs are generated with `uuid v4` which is secure, but market IDs could use checksums for integrity.

### 21. [LOW] Missing API Versioning

**Description**: No API version in paths (`/api/v1/`), making future changes difficult.

---

## Blockchain-Specific Security Notes

### Poll.fun Integration

- **Using `isCreatorResolver=true`**: Good security choice - prevents voting manipulation
- **Program deployed only on mainnet**: Testing must use real USDC
- **Creator key management**: Single point of failure for market resolution

### Solana Transaction Security

- Transaction verification exists but is bypassed for MVP
- No simulation before sending transactions
- No confirmation timeout handling

---

## Recommended Security Improvements

### Immediate (Before Launch)

1. Add authentication to admin endpoints
2. Enable transaction verification
3. Implement persistent database
4. Add input validation for all fields
5. Configure CORS restrictions

### Short-term (Within 2 Weeks)

1. Add rate limiting
2. Implement security headers
3. Add request size limits
4. Enable HTTPS
5. Add error logging without exposing details

### Long-term (Production Hardening)

1. Implement multi-sig for escrow operations
2. Add fraud detection for unusual betting patterns
3. Implement circuit breakers for abnormal activity
4. Regular security audits
5. Bug bounty program

---

## Conclusion

AgentBets demonstrates solid Solana integration concepts but has significant security gaps typical of hackathon MVPs. The most critical issues are:

1. **No authentication** on privileged endpoints
2. **Transaction verification bypassed**
3. **In-memory data storage**

These must be addressed before handling real user funds. The Poll.fun integration's use of `isCreatorResolver=true` is a good security decision that avoids the voting manipulation vulnerability.

**Recommendation**: Do not deploy to mainnet without addressing Critical and High severity issues.

---

*This report is provided for informational purposes. A professional third-party audit is recommended before production deployment.*
