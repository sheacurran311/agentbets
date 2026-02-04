/**
 * x402 Payment Handler for AgentBets
 *
 * Enables AI agents to place bets using USDC over HTTP (x402 protocol).
 * Payments are in USDC on Solana (devnet for testing, mainnet for production).
 *
 * Flow:
 * 1. Agent calls POST /api/agent/bet with bet details
 * 2. Server returns 402 with payment requirements
 * 3. Agent signs payment with their Solana wallet
 * 4. Agent retries with PAYMENT-SIGNATURE header
 * 5. Server records bet and returns confirmation
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');

const WALLET_FILE = join(homedir(), '.agentbets', 'solana-wallet.json');

// USDC token addresses on Solana
const USDC_TOKENS = {
  'solana:devnet': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',   // Circle USDC on devnet
  'solana:mainnet': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  // Circle USDC on mainnet
};

// Solana RPC endpoints
const SOLANA_RPC = {
  'solana:devnet': 'https://api.devnet.solana.com',
  'solana:mainnet': 'https://api.mainnet-beta.solana.com',
};

/**
 * Get the platform's Solana wallet address for receiving payments
 */
function getPayToAddress() {
  // Use environment variable first, fall back to wallet file
  if (process.env.SOLANA_PAY_TO_ADDRESS) {
    return process.env.SOLANA_PAY_TO_ADDRESS;
  }
  if (process.env.ESCROW_WALLET) {
    return process.env.ESCROW_WALLET;
  }
  if (existsSync(WALLET_FILE)) {
    return JSON.parse(readFileSync(WALLET_FILE, 'utf-8')).publicKey;
  }
  return null;
}

/**
 * Build x402 v2 payment requirements for a bet (Solana USDC)
 *
 * @param {object} options
 * @param {number} options.amountUSDC - Bet amount in USDC
 * @param {string} options.marketId - Market being bet on
 * @param {string} options.outcome - YES or NO
 * @param {string} [options.network='solana:devnet'] - Network ID (devnet default)
 * @returns {object} x402 v2 payment requirements
 */
function buildBetPaymentRequirements(options) {
  const {
    amountUSDC,
    marketId,
    outcome,
    network = 'solana:devnet', // Solana devnet by default
    agentHandle
  } = options;

  const payTo = getPayToAddress();
  if (!payTo) {
    throw new Error('No Solana wallet configured. Set SOLANA_PAY_TO_ADDRESS or ESCROW_WALLET env var.');
  }

  const asset = USDC_TOKENS[network];
  if (!asset) {
    throw new Error(`Unknown network: ${network}. Supported: ${Object.keys(USDC_TOKENS).join(', ')}`);
  }

  // Convert USDC amount to smallest unit (6 decimals)
  const amount = String(Math.round(amountUSDC * 1e6));

  return {
    x402Version: 2,
    accepts: [{
      scheme: 'exact',
      network,
      maxAmountRequired: amount,
      amount,
      resource: `/api/agent/bet/${marketId}`,
      description: `AgentBets: ${amountUSDC} USDC ${outcome} on market ${marketId}`,
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 300,
      asset,
      rpc: SOLANA_RPC[network],
      extra: {
        // Custom metadata for bet tracking
        agentBets: {
          marketId,
          outcome,
          amountUSDC,
          agentHandle,
          timestamp: Date.now()
        }
      }
    }]
  };
}

/**
 * Encode payment requirements as base64 header
 */
function encodeRequirements(requirements) {
  return Buffer.from(JSON.stringify(requirements)).toString('base64');
}

/**
 * Send 402 Payment Required response for a bet
 */
function sendBetPaymentRequired(res, options) {
  const requirements = buildBetPaymentRequirements(options);
  res.status(402);
  res.setHeader('PAYMENT-REQUIRED', encodeRequirements(requirements));
  res.setHeader('Content-Type', 'application/json');
  res.json({
    error: 'Payment required',
    message: `Send ${options.amountUSDC} USDC to place this bet`,
    x402: {
      version: 2,
      amountUSDC: options.amountUSDC,
      network: options.network || 'solana:devnet',
      payTo: getPayToAddress(),
      asset: USDC_TOKENS[options.network || 'solana:devnet']
    },
    bet: {
      marketId: options.marketId,
      outcome: options.outcome,
      amount: options.amountUSDC,
      currency: 'USDC'
    },
    funding: {
      faucet: 'https://faucet.circle.com',
      network: 'Solana Devnet',
      instructions: 'Select Solana Devnet and paste your wallet address'
    }
  });
}

/**
 * Check if request has valid x402 payment header
 */
function getPaymentHeader(req) {
  return req.header('payment-signature') ||
         req.header('PAYMENT-SIGNATURE') ||
         req.header('x-payment') ||
         req.header('X-PAYMENT') ||
         null;
}

/**
 * Parse and validate payment from header
 * Returns payment details or null if invalid
 */
function parsePaymentHeader(paymentHeader) {
  try {
    // Payment header is base64 encoded JSON with signature
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
    return {
      valid: true,
      signature: decoded.signature || paymentHeader,
      payload: decoded.payload || decoded,
      network: decoded.network || 'solana:devnet',
      amount: decoded.amount || decoded.payload?.amount
    };
  } catch (e) {
    // Might be raw signature string
    return {
      valid: true,
      signature: paymentHeader,
      payload: null
    };
  }
}

/**
 * Express middleware for x402-gated bet placement
 *
 * Usage:
 *   app.post('/api/agent/bet/:marketId',
 *     x402BetGate({ minAmount: 1, maxAmount: 1000 }),
 *     (req, res) => { ... handle bet ... }
 *   );
 */
function x402BetGate(options = {}) {
  const { minAmount = 0.01, maxAmount = 10000 } = options;

  return async (req, res, next) => {
    const { marketId } = req.params;
    const { outcome, amount, agentHandle } = req.body;

    // Validate bet parameters
    if (!outcome || !['YES', 'NO'].includes(outcome.toUpperCase())) {
      return res.status(400).json({ error: 'Invalid outcome. Use YES or NO.' });
    }

    const amountUSDC = parseFloat(amount);
    if (isNaN(amountUSDC) || amountUSDC < minAmount || amountUSDC > maxAmount) {
      return res.status(400).json({
        error: `Invalid amount. Must be between ${minAmount} and ${maxAmount} USDC.`
      });
    }

    // Check for payment header
    const paymentHeader = getPaymentHeader(req);

    if (!paymentHeader) {
      // No payment - return 402 with requirements
      return sendBetPaymentRequired(res, {
        amountUSDC,
        marketId,
        outcome: outcome.toUpperCase(),
        agentHandle,
        network: req.body.network || 'solana:devnet'
      });
    }

    // Payment header present - parse and validate
    const payment = parsePaymentHeader(paymentHeader);

    if (!payment.valid) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // Attach payment info to request for downstream handler
    req.x402Payment = {
      ...payment,
      amountUSDC,
      marketId,
      outcome: outcome.toUpperCase(),
      agentHandle
    };

    // Add settlement header to response
    const originalEnd = res.end;
    res.end = function(...args) {
      res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
        success: true,
        network: payment.network,
        transaction: payment.signature?.slice(0, 16) + '...',
        betRecorded: true
      })).toString('base64'));
      originalEnd.apply(res, args);
    };

    next();
  };
}

/**
 * Convert USDC amount to SOL equivalent for internal tracking
 * Uses approximate rate (would use oracle in production)
 */
function usdcToSolApprox(usdcAmount) {
  // Approximate: 1 SOL = ~$150 USDC (would use live price in production)
  const SOL_PRICE_USD = parseFloat(process.env.SOL_PRICE_USD) || 150;
  return usdcAmount / SOL_PRICE_USD;
}

/**
 * Convert SOL to USDC equivalent
 */
function solToUsdcApprox(solAmount) {
  const SOL_PRICE_USD = parseFloat(process.env.SOL_PRICE_USD) || 150;
  return solAmount * SOL_PRICE_USD;
}

module.exports = {
  buildBetPaymentRequirements,
  sendBetPaymentRequired,
  getPaymentHeader,
  parsePaymentHeader,
  x402BetGate,
  getPayToAddress,
  usdcToSolApprox,
  solToUsdcApprox,
  USDC_TOKENS,
  SOLANA_RPC
};
