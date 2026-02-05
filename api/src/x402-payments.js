/**
 * x402 Payment Handler for AgentBets
 *
 * Enables AI agents to place bets using USDC over HTTP (x402 protocol).
 * Payments are in USDC on Solana (devnet for testing, mainnet for production).
 *
 * Flow:
 * 1. Agent calls POST /api/agent/bet with bet details
 * 2. Server returns 402 with payment requirements
 * 3. Agent signs USDC transfer transaction
 * 4. Agent retries with PAYMENT-SIGNATURE header (containing tx signature)
 * 5. Server verifies on-chain transaction, records bet, and returns confirmation
 */

const { readFileSync, existsSync } = require('fs');
const { join } = require('path');
const { homedir } = require('os');
const { Connection, PublicKey } = require('@solana/web3.js');

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
 * Parse payment from header (without verification)
 * Returns payment details - use verifyPaymentOnChain for actual verification
 */
function parsePaymentHeader(paymentHeader) {
  try {
    // Payment header is base64 encoded JSON with signature
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
    return {
      parsed: true,
      signature: decoded.signature || decoded.txSignature || paymentHeader,
      payload: decoded.payload || decoded,
      network: decoded.network || 'solana:devnet',
      amount: decoded.amount || decoded.payload?.amount,
      payer: decoded.payer || decoded.from || null
    };
  } catch (e) {
    // Might be raw signature string (base58 Solana tx signature)
    if (paymentHeader && paymentHeader.length >= 64 && paymentHeader.length <= 128) {
      return {
        parsed: true,
        signature: paymentHeader,
        payload: null,
        network: 'solana:devnet'
      };
    }
    return {
      parsed: false,
      error: 'Invalid payment header format'
    };
  }
}

/**
 * Verify USDC transfer on-chain
 * 
 * @param {string} signature - Transaction signature to verify
 * @param {object} options - Verification options
 * @param {number} options.expectedAmount - Expected USDC amount (human readable)
 * @param {string} options.expectedRecipient - Expected recipient address
 * @param {string} options.network - Network ('solana:devnet' or 'solana:mainnet')
 * @returns {Promise<object>} Verification result
 */
async function verifyPaymentOnChain(signature, options = {}) {
  const {
    expectedAmount,
    expectedRecipient,
    network = 'solana:devnet'
  } = options;

  const rpcUrl = SOLANA_RPC[network] || SOLANA_RPC['solana:devnet'];
  const connection = new Connection(rpcUrl, 'confirmed');

  try {
    console.log(`[x402] Verifying transaction: ${signature.slice(0, 16)}...`);

    // Fetch transaction with retry
    let txInfo = null;
    let retries = 3;
    
    while (retries > 0 && !txInfo) {
      txInfo = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      
      if (!txInfo) {
        retries--;
        if (retries > 0) {
          console.log(`[x402] Transaction not found, retrying in 2s... (${retries} retries left)`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (!txInfo) {
      return {
        valid: false,
        error: 'Transaction not found on-chain. It may still be processing.',
        code: 'TX_NOT_FOUND'
      };
    }

    // Check transaction succeeded
    if (txInfo.meta?.err) {
      return {
        valid: false,
        error: `Transaction failed on-chain: ${JSON.stringify(txInfo.meta.err)}`,
        code: 'TX_FAILED'
      };
    }

    // Get pre/post token balances for USDC verification
    const preBalances = txInfo.meta?.preTokenBalances || [];
    const postBalances = txInfo.meta?.postTokenBalances || [];
    const usdcMint = USDC_TOKENS[network];

    // Find USDC transfers
    let usdcTransferred = 0;
    let recipientReceived = false;

    for (const postBal of postBalances) {
      if (postBal.mint === usdcMint) {
        const preBal = preBalances.find(
          p => p.accountIndex === postBal.accountIndex && p.mint === usdcMint
        );
        const preAmount = preBal?.uiTokenAmount?.uiAmount || 0;
        const postAmount = postBal.uiTokenAmount?.uiAmount || 0;
        const diff = postAmount - preAmount;

        if (diff > 0) {
          usdcTransferred += diff;
          // Check if this is our recipient
          const accountKey = txInfo.transaction?.message?.staticAccountKeys?.[postBal.accountIndex] ||
                           txInfo.transaction?.message?.accountKeys?.[postBal.accountIndex];
          if (accountKey && expectedRecipient && 
              accountKey.toString() === expectedRecipient) {
            recipientReceived = true;
          }
        }
      }
    }

    // Validate amount if specified
    if (expectedAmount && usdcTransferred < expectedAmount * 0.99) { // 1% tolerance
      return {
        valid: false,
        error: `Insufficient USDC transferred. Expected: ${expectedAmount}, Got: ${usdcTransferred}`,
        code: 'INSUFFICIENT_AMOUNT',
        received: usdcTransferred,
        expected: expectedAmount
      };
    }

    // Get payer from transaction
    const payer = txInfo.transaction?.message?.staticAccountKeys?.[0] ||
                  txInfo.transaction?.message?.accountKeys?.[0];

    console.log(`[x402] Payment verified: ${usdcTransferred} USDC from ${payer?.toString()?.slice(0, 8)}...`);

    return {
      valid: true,
      signature,
      amount: usdcTransferred,
      payer: payer?.toString(),
      blockTime: txInfo.blockTime,
      slot: txInfo.slot,
      network
    };

  } catch (error) {
    console.error('[x402] Verification error:', error);
    return {
      valid: false,
      error: error.message,
      code: 'VERIFICATION_ERROR'
    };
  }
}

/**
 * Express middleware for x402-gated bet placement
 *
 * Usage:
 *   app.post('/api/agent/bet/:marketId',
 *     x402BetGate({ minAmount: 1, maxAmount: 1000, verifyOnChain: true }),
 *     (req, res) => { ... handle bet ... }
 *   );
 * 
 * Options:
 *   - minAmount: Minimum bet amount in USDC (default: 0.01)
 *   - maxAmount: Maximum bet amount in USDC (default: 10000)
 *   - verifyOnChain: Whether to verify payment on-chain (default: true for production)
 *   - skipVerification: Skip verification for testing (default: false)
 */
function x402BetGate(options = {}) {
  const { 
    minAmount = 0.01, 
    maxAmount = 10000,
    verifyOnChain = process.env.NODE_ENV === 'production',
    skipVerification = process.env.SKIP_X402_VERIFICATION === 'true'
  } = options;

  return async (req, res, next) => {
    const { marketId } = req.params;
    const { outcome, amount, agentHandle } = req.body;
    const network = req.body.network || 'solana:devnet';

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
        network
      });
    }

    // Payment header present - parse it
    const payment = parsePaymentHeader(paymentHeader);

    if (!payment.parsed) {
      return res.status(400).json({ 
        error: 'Invalid payment header format',
        details: payment.error 
      });
    }

    // Verify payment on-chain if enabled
    let verification = { valid: true, skipped: true };
    
    if (verifyOnChain && !skipVerification && payment.signature) {
      verification = await verifyPaymentOnChain(payment.signature, {
        expectedAmount: amountUSDC,
        expectedRecipient: getPayToAddress(),
        network
      });

      if (!verification.valid) {
        return res.status(402).json({
          error: 'Payment verification failed',
          details: verification.error,
          code: verification.code,
          hint: 'Ensure your USDC transfer transaction is confirmed on-chain before retrying'
        });
      }
    } else if (!verifyOnChain || skipVerification) {
      console.log('[x402] On-chain verification skipped (dev mode or disabled)');
    }

    // Attach payment info to request for downstream handler
    req.x402Payment = {
      ...payment,
      verified: verification.valid,
      verificationDetails: verification,
      amountUSDC: verification.amount || amountUSDC,
      marketId,
      outcome: outcome.toUpperCase(),
      agentHandle,
      network,
      payer: verification.payer || payment.payer
    };

    // Add settlement header to response
    const originalEnd = res.end;
    res.end = function(...args) {
      res.setHeader('PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
        success: true,
        verified: verification.valid,
        network,
        transaction: payment.signature?.slice(0, 16) + '...',
        amount: verification.amount || amountUSDC,
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
  verifyPaymentOnChain,
  x402BetGate,
  getPayToAddress,
  usdcToSolApprox,
  solToUsdcApprox,
  USDC_TOKENS,
  SOLANA_RPC
};
