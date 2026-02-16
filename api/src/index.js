/**
 * AgentBets API Server
 * Prediction Markets for AI Agent Outcomes on Solana
 * Built by Butters (@AIButters) for Colosseum Agent Hackathon
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// Database
const db = require('./db');
const dbCompat = require('./db/compat');
const { Market, Bet, Agent, Royalty, Points, Referral, Resolution, OddsHistory, Position, PlatformKey } = require('./db/models');

// Use compatibility layer for storage (works with both DB and in-memory)
const { markets, bets, positions, oddsHistory, setDbConnected, isDbConnected } = dbCompat;

// Escrow module for on-chain operations
const escrow = require('./escrow');
// Oracle module for market resolution
const oracle = require('./oracle');
// Poll.fun SDK for on-chain prediction markets
const { pollFunService, PollFunService, calculateWagerFee, buildPlatformFeeInstruction } = require('./pollfun');
// Creator Earnings (per-market fees)
const royalties = require('./royalties');
// Solana Actions (Blinks) for X/Twitter integration
const { router: actionsRouter, generateBlinkUrl, generateMarketsBlinkUrl, ACTION_CORS_HEADERS } = require('./actions');
// Proof-of-Agent Verification System
const agentVerification = require('./agentVerification');
// x402 Payments for programmatic agent betting
const x402 = require('./x402-payments');
// Gasless relay for USDC-only transactions (no SOL needed)
const { gaslessService } = require('./gasless');
// Dynamic OG image generation for social previews
const { router: ogRouter } = require('./og');

const app = express();
const PORT = process.env.PORT || 3002;

// Trust proxy for rate limiting behind reverse proxy (Replit, Railway, etc.)
app.set('trust proxy', 1);

// Input Sanitization Utilities - Prevent XSS and injection attacks
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input
    // Normalize newlines and excessive whitespace (Twitter wraps long tweets)
    .replace(/\r?\n/g, ' ')
    .replace(/\s{2,}/g, ' ')
    // Remove any HTML tags
    .replace(/<[^>]*>/g, '')
    // Escape HTML entities
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    // Remove potential javascript: protocol
    .replace(/javascript:/gi, '')
    // Remove potential data: protocol
    .replace(/data:/gi, '')
    // Remove event handlers like onclick, onerror, etc.
    .replace(/on\w+\s*=/gi, '')
    // Remove script-related content
    .replace(/\beval\s*\(/gi, '')
    .replace(/\bFunction\s*\(/gi, '')
    // Trim whitespace
    .trim();
};

const sanitizeDate = (dateString) => {
  if (!dateString || typeof dateString !== 'string') return null;
  // Validate ISO date format
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
};

const VALID_CATEGORIES = ['competition', 'performance', 'token', 'milestone', 'head-to-head', 'app', 'general'];
const sanitizeCategory = (category) => {
  if (typeof category === 'string' && VALID_CATEGORIES.includes(category)) return category;
  return 'general';
};

const sanitizeWalletAddress = (wallet) => {
  if (!wallet || typeof wallet !== 'string') return null;
  // Solana wallet addresses are base58 encoded, 32-44 characters
  const walletRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  return walletRegex.test(wallet) ? wallet : null;
};

/**
 * Auto-detect tags from market question and metadata
 * Used for platform integration filtering (e.g., Moltbook, Pump.fun, etc.)
 */
/**
 * Auto-detect the resolution source from question text
 * Mirrors bot/src/parser.js detectResolutionSource()
 * Used for all markets to auto-detect the correct resolution source
 * (coingecko, x-api, moltbook, etc.) from the question text
 */
function detectResolutionSource(question) {
  if (!question) return 'manual';
  const lower = question.toLowerCase();

  if (/\$[A-Z]+|mcap|market cap|price/i.test(question)) return 'dexscreener';
  if (/followers|following|likes|retweets|impressions/i.test(lower)) return 'x-api';
  if (/karma|moltbook|molt/i.test(lower)) return 'moltbook';
  if (/commit|release|deploy|ship|github/i.test(lower)) return 'github';
  if (/balance|wallet|sol|transaction/i.test(lower)) return 'solana';

  return 'manual';
}

/**
 * Auto-detect resolution timing from question + resolution source
 * on_target: monotonic metrics (Moltbook platform agent count) - resolve when threshold met
 * at_close: variable metrics (X followers, token price) - resolve only at end date
 */
function detectResolutionTiming(question, resolutionSource, targetHandle) {
  if (!question) return 'at_close';
  const lower = question.toLowerCase();

  // @moltbook is the platform itself, not an individual agent handle
  const isMoltbookPlatformHandle = !targetHandle || /^moltbook$/i.test(targetHandle);

  // Moltbook platform agent count -> on_target (monotonic metric)
  // Simple check: question mentions both a number and "agents"
  if (resolutionSource === 'moltbook' && isMoltbookPlatformHandle) {
    const hasNumber = /\d+(?:\.\d+)?\s*[mk]?/i.test(lower);
    const hasAgents = /agents?/i.test(lower);
    if (hasNumber && hasAgents) {
      return 'on_target';
    }
  }

  return 'at_close';
}

function autoDetectTags(question, category, resolutionSource) {
  const tags = [];
  const lower = (question || '').toLowerCase();

  // Platform keyword detection
  if (/moltbook|molt\.book/i.test(lower)) tags.push('moltbook');
  if (/pump\.fun|pumpfun|bonding curve/i.test(lower)) tags.push('pumpfun');
  if (/openclaw/i.test(lower)) tags.push('openclaw');
  if (/clawd/i.test(lower)) tags.push('clawd');

  // Market type tags
  if (/\$[A-Z]+/i.test(question) || /token|price|mcap|market cap/i.test(lower)) tags.push('token-market');
  if (/bond|graduate|migration/i.test(lower)) tags.push('bonding');
  if (/agent|ai agent|bot/i.test(lower)) tags.push('agent-market');

  // Category as tag for cross-filtering
  if (category && category !== 'general') tags.push(`category:${category}`);

  // Resolution source as tag
  if (resolutionSource && resolutionSource !== 'manual') tags.push(`source:${resolutionSource}`);

  return [...new Set(tags)];
}

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: [
        "'self'",
        "https://api.devnet.solana.com",
        "https://api.mainnet.solana.com",
        "https://api.mainnet-beta.solana.com",
        "wss://api.mainnet.solana.com",
        "wss://api.mainnet-beta.solana.com",
        // Dedicated RPC providers
        "https://*.helius-rpc.com",
        "https://*.helius.dev",
        "wss://*.helius-rpc.com",
        "https://*.quiknode.pro",
        "wss://*.quiknode.pro",
        "https://*.alchemy.com",
        "wss://*.alchemy.com",
        "https://*.triton.one",
        "wss://*.triton.one",
        "https://*.rpcpool.com",
        "wss://*.rpcpool.com",
        // Dynamically include configured RPC URL
        ...(process.env.SOLANA_RPC_URL ? [process.env.SOLANA_RPC_URL, process.env.SOLANA_RPC_URL.replace('https://', 'wss://')] : []),
        // Wallet adapters
        "https://*.solflare.com",
        "https://*.phantom.app",
        "https://*.coinbase.com",
      ],
      frameSrc: [
        "'self'",
        "https://connect.solflare.com",
        "https://*.solflare.com",
        "https://*.phantom.app",
        "https://*.coinbase.com",
        "https://dial.to",
      ],
      childSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow embedding for Solana Actions
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Allow wallet popups
}));

// CORS configuration - restrict origins in production
const corsOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : '*';

app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key']
}));
app.use(express.json({ limit: '1mb' })); // Limit request body size

// Rate limiting - General API
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting - Stricter for admin endpoints
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requests per window
  message: { error: 'Too many admin requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting - Market creation
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 market creations per hour
  message: { error: 'Too many markets created, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting - Bet placement
const betLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 bets per minute
  message: { error: 'Too many bets placed, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply general rate limit to all API routes
app.use('/api/', generalLimiter);

// ==========================================
// API KEY AUTHENTICATION
// ==========================================

// Secret API key for bot/agent access (protects from spam)
const AGENTBETS_API_KEY = process.env.AGENTBETS_API_KEY;

/**
 * Middleware to require API key for protected endpoints
 * Used for bot-to-API communication and agent endpoints
 */
function requireApiKey(req, res, next) {
  // Skip API key check if not configured (development mode)
  if (!AGENTBETS_API_KEY) {
    console.warn('[Security] No AGENTBETS_API_KEY configured - agent endpoints unprotected');
    return next();
  }

  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  
  if (!providedKey) {
    return res.status(401).json({ 
      error: 'API key required',
      message: 'Please provide X-API-Key header or apiKey query parameter'
    });
  }

  if (providedKey !== AGENTBETS_API_KEY) {
    console.warn(`[Security] Invalid API key attempt from ${req.ip}`);
    return res.status(403).json({ 
      error: 'Invalid API key',
      message: 'The provided API key is not valid'
    });
  }

  next();
}

/**
 * Rate limiting specifically for agent/bot endpoints
 * More restrictive than general API
 */
const agentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute per IP
  message: { error: 'Too many agent requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==========================================
// PLATFORM KEY AUTHENTICATION
// ==========================================

// In-memory cache for platform keys to avoid DB lookup on every request
const platformKeyCache = new Map(); // apiKey -> { data, cachedAt }
const PLATFORM_KEY_CACHE_TTL = 5 * 60 * 1000; // 5 minute cache

// Per-key rate limiting tracking
const platformKeyRateLimits = new Map(); // apiKey -> { count, windowStart }

/**
 * Middleware to authenticate platform API keys
 * Sets req.authLevel to 'admin', 'platform', or 'public'
 * Platform keys get higher rate limits but cannot create/resolve markets
 */
async function authenticateRequest(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;

  if (!key) {
    req.authLevel = 'public';
    return next();
  }

  // Check admin key first
  if (AGENTBETS_API_KEY && key === AGENTBETS_API_KEY) {
    req.authLevel = 'admin';
    return next();
  }

  // Check platform keys (with cache)
  try {
    let platformKey = null;
    const cached = platformKeyCache.get(key);
    if (cached && (Date.now() - cached.cachedAt) < PLATFORM_KEY_CACHE_TTL) {
      platformKey = cached.data;
    } else {
      platformKey = await PlatformKey.findByKey(key);
      platformKeyCache.set(key, { data: platformKey, cachedAt: Date.now() });
    }

    if (!platformKey || !platformKey.isActive) {
      return res.status(403).json({ error: 'Invalid or inactive API key' });
    }

    // Per-key rate limiting
    const rateLimit = platformKey.rateLimitPerMinute || 60;
    const now = Date.now();
    const rateLimitEntry = platformKeyRateLimits.get(key) || { count: 0, windowStart: now };

    // Reset window if expired
    if (now - rateLimitEntry.windowStart > 60 * 1000) {
      rateLimitEntry.count = 0;
      rateLimitEntry.windowStart = now;
    }

    rateLimitEntry.count++;
    platformKeyRateLimits.set(key, rateLimitEntry);

    if (rateLimitEntry.count > rateLimit) {
      return res.status(429).json({
        error: 'Platform rate limit exceeded',
        limit: rateLimit,
        retryAfter: Math.ceil((rateLimitEntry.windowStart + 60000 - now) / 1000)
      });
    }

    req.authLevel = 'platform';
    req.platform = platformKey;

    // Update usage stats asynchronously (don't block the request)
    PlatformKey.updateUsage(platformKey.id).catch(err =>
      console.error('[Platform] Usage update error:', err.message)
    );

    next();
  } catch (error) {
    console.error('[Platform] Auth error:', error.message);
    // On DB error, fall through as public
    req.authLevel = 'public';
    next();
  }
}

/**
 * Middleware to require a specific permission level
 * Use after authenticateRequest
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.authLevel === 'admin') return next(); // Admin has all permissions

    if (req.authLevel !== 'platform') {
      return res.status(401).json({
        error: 'API key required',
        message: 'This endpoint requires a platform API key. Contact the AgentBets team to get one.'
      });
    }

    const permissions = req.platform?.permissions || [];
    if (!permissions.includes(permission)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: `Your API key does not have the '${permission}' permission`,
        currentPermissions: permissions
      });
    }

    next();
  };
}

// Serve static files for actions.json
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

// Mount Solana Actions router
app.use('/api/actions', actionsRouter);

// Solana connection
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Platform escrow wallet (in production, this would be a PDA)
const ESCROW_WALLET = process.env.ESCROW_WALLET || '48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM';

// In-memory cache for frequently accessed data (backed by PostgreSQL)
const priceHistoryCache = new Map(); // tokenId -> { data, fetchedAt }

// Database flag - set to true once connected
let dbConnected = false;

// CoinGecko API configuration (from environment)
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const COINGECKO_API_BASE = 'https://api.coingecko.com/api/v3';

// Token symbol to CoinGecko ID mapping
const TOKEN_ID_MAP = {
  'btc': 'bitcoin',
  'bitcoin': 'bitcoin',
  'eth': 'ethereum',
  'ethereum': 'ethereum',
  'sol': 'solana',
  'solana': 'solana',
  'usdc': 'usd-coin',
  'bonk': 'bonk',
  'jup': 'jupiter-exchange-solana',
  'jupiter': 'jupiter-exchange-solana',
  'wif': 'dogwifcoin',
  'dogwifhat': 'dogwifcoin',
  'jto': 'jito-governance-token',
  'jito': 'jito-governance-token',
  'pyth': 'pyth-network',
  'render': 'render-token',
  'rndr': 'render-token',
  'ray': 'raydium',
  'raydium': 'raydium',
  'orca': 'orca',
  'marinade': 'marinade-staked-sol',
  'msol': 'marinade-staked-sol',
  'fida': 'bonfida',
  'bonfida': 'bonfida',
  'step': 'step-finance',
  'atlas': 'star-atlas',
  'polis': 'star-atlas-dao',
  'samo': 'samoyedcoin',
  'grape': 'grape-2',
  'mango': 'mango-markets',
  'srm': 'serum',
  'serum': 'serum',
  'aixbt': 'aixbt',
  'virtual': 'virtual-protocol',
  'ai16z': 'ai16z',
  'luna': 'luna-virtuals',
  'zerebro': 'zerebro'
};

// Helper to extract token from market question
function extractTokenFromQuestion(question) {
  // Match $TOKEN patterns
  const match = question.match(/\$([A-Za-z0-9]+)/i);
  if (match) {
    return match[1].toLowerCase();
  }
  return null;
}

// Helper to get CoinGecko ID from token symbol
function getCoinGeckoId(token) {
  if (!token) return null;
  const lowerToken = token.toLowerCase();
  return TOKEN_ID_MAP[lowerToken] || lowerToken;
}

// Helper function to record odds history for a market
async function recordOddsHistory(marketId, market) {
  try {
    await oddsHistory.record(marketId, {
      yesOdds: market.yesOdds,
      noOdds: market.noOdds,
      yesPool: market.yesPool,
      noPool: market.noPool,
      totalVolume: market.totalVolume
    });
  } catch (error) {
    console.error(`Failed to record odds history for market ${marketId}:`, error.message);
  }
}

/**
 * Sync a market's local data from on-chain PDA.
 * Reads wagers, pools, and odds directly from the Solana program
 * and updates the local database to match.
 */
async function syncMarketFromChain(marketId) {
  try {
    const market = await markets.get(marketId);
    if (!market || !market.betPda) return { success: false, error: 'Market not found or not on-chain' };

    const onChain = await pollFunService.getMarketData(market.betPda);
    if (!onChain.success) return { success: false, error: onChain.error };

    // On-chain values are in USDC (already divided by 1e6 in getMarketData),
    // but local storage uses micro USDC, so multiply back
    const yesPoolMicro = Math.round(onChain.yesPool * 1e6);
    const noPoolMicro = Math.round(onChain.noPool * 1e6);
    const totalVolumeMicro = yesPoolMicro + noPoolMicro;

    let changed = (
      market.yesPool !== yesPoolMicro ||
      market.noPool !== noPoolMicro ||
      market.totalBets !== (onChain.wagers?.length || 0)
    );

    // Detect resolved-on-chain but stuck-in-DB: update status to match on-chain
    const isResolvedOnChain = onChain.status === 'Resolved' &&
      onChain.resolvedOutcome &&
      onChain.resolvedOutcome !== 'NotResolvedYet';
    const isStuckInDb = market.status === 'pending_confirmation' || market.status === 'active';

    if (isResolvedOnChain && isStuckInDb) {
      const resolution = onChain.resolvedOutcome === 'For' ? 'YES' : 'NO';
      market.status = 'resolved';
      market.resolution = resolution;
      market.resolvedAt = market.resolvedAt || new Date().toISOString();
      market.onChainResolutionTx = market.onChainResolutionTx || 'synced-from-chain';
      market.settlementStatus = 'settled';
      market.settledAt = market.settledAt || new Date().toISOString();
      delete market.onChainError;
      delete market.settlementError;
      changed = true;
      console.log(`[Sync] Fixed stuck market ${marketId}: on-chain resolved as ${resolution}, DB updated`);

      // Clean up pending_resolutions row since market is now resolved
      if (isDbConnected()) {
        try {
          const deleted = await Resolution.delete(marketId);
          if (deleted) console.log(`[Sync] Removed market ${marketId} from pending_resolutions`);
        } catch (err) {
          console.warn(`[Sync] Failed to clean up pending_resolutions for ${marketId}:`, err.message);
        }
      }
    }

    // Also clean up pending_resolutions for any market already marked resolved
    if (market.status === 'resolved' && isDbConnected()) {
      try {
        const deleted = await Resolution.delete(marketId);
        if (deleted) console.log(`[Sync] Cleaned up stale pending_resolutions row for resolved market ${marketId}`);
      } catch (err) {
        // Ignore — row may not exist
      }
    }

    if (changed) {
      market.yesPool = yesPoolMicro;
      market.noPool = noPoolMicro;
      market.totalVolume = totalVolumeMicro;
      market.totalBets = onChain.wagers?.length || 0;
      market.yesOdds = onChain.yesOdds;
      market.noOdds = onChain.noOdds;

      await markets.set(marketId, market);
      await recordOddsHistory(marketId, market);

      console.log(`[Sync] Market ${marketId} synced from chain: ${onChain.totalPool.toFixed(2)} USDC pool, ${market.totalBets} bets`);
    }

    return { success: true, changed, market };
  } catch (error) {
    console.warn(`[Sync] Failed to sync market ${marketId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Sync all on-chain markets from their PDAs.
 * Called on server startup to backfill any wagers placed outside the API.
 */
async function syncAllMarketsFromChain() {
  try {
    const allMarkets = await markets.findAll({ limit: 200 });
    const onChainMarkets = allMarkets.filter(m => m.betPda);

    if (onChainMarkets.length === 0) {
      console.log('[Sync] No on-chain markets to sync');
      return;
    }

    console.log(`[Sync] Syncing ${onChainMarkets.length} on-chain markets from Solana...`);

    let synced = 0;
    let changed = 0;

    for (const m of onChainMarkets) {
      const result = await syncMarketFromChain(m.id);
      if (result.success) {
        synced++;
        if (result.changed) changed++;
      }
      // Small delay to avoid RPC rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`[Sync] Complete: ${synced}/${onChainMarkets.length} synced, ${changed} updated`);

    // After syncing, clean up stale pending_resolutions for any resolved markets
    await cleanupStalePendingResolutions();
  } catch (error) {
    console.error('[Sync] Failed to sync markets from chain:', error.message);
  }
}

/**
 * Remove pending_resolutions rows for markets that are already resolved.
 * Called after chain sync to clean up stale entries that the bot never cleared
 * (e.g., when a market was resolved directly on-chain without the bot flow).
 */
async function cleanupStalePendingResolutions() {
  if (!isDbConnected()) return;
  try {
    // Find all pending_resolutions entries
    const pendingRows = await db.query('SELECT market_id FROM pending_resolutions');
    if (!pendingRows.rows || pendingRows.rows.length === 0) return;

    let cleaned = 0;
    for (const row of pendingRows.rows) {
      const market = await markets.get(row.market_id);
      // Remove if market is resolved, closed, or doesn't exist anymore
      if (!market || market.status === 'resolved' || market.status === 'closed' || market.status === 'cancelled') {
        try {
          await Resolution.delete(row.market_id);
          cleaned++;
          console.log(`[Cleanup] Removed stale pending_resolutions row for ${market ? market.status : 'missing'} market ${row.market_id}`);
        } catch (err) {
          // ignore individual failures
        }
      }
    }
    if (cleaned > 0) {
      console.log(`[Cleanup] Removed ${cleaned} stale pending_resolutions entries`);
    }
  } catch (error) {
    console.warn('[Cleanup] Failed to clean up pending_resolutions:', error.message);
  }
}

/**
 * Persist settlement transaction signatures to escrow_transactions for tracking.
 * NOTE: Fees (1% per wager) are now collected at wager time, not at settlement.
 * This function now primarily records settlement tx signatures for audit trail.
 * Creator royalty and platform fee amounts passed here are typically 0 for new markets.
 * Does not block resolution on failure.
 */
async function persistResolutionFees(market, totalCreatorRoyalty, totalPlatformFee, settlementTxSignatures = []) {
  if (!isDbConnected()) return;
  try {
    // Persist creator royalty to royalty_transactions and agent_royalties
    if (totalCreatorRoyalty > 0 && market.creatorAgent) {
      const handle = market.creatorAgent.toLowerCase().replace('@', '');
      await Royalty.getOrCreate(handle);
      await Royalty.addEarnings(handle, totalCreatorRoyalty, market.id);
      console.log(`[Resolution] Persisted creator royalty: ${totalCreatorRoyalty} for @${handle}`);
    }
    // Record settlement batch tx signatures in escrow_transactions
    for (const txSig of settlementTxSignatures) {
      if (txSig) {
        await db.query(
          `INSERT INTO escrow_transactions (tx_signature, type, amount, market_id, status)
           VALUES ($1, 'payout', 0, $2, 'confirmed')
           ON CONFLICT (tx_signature) DO NOTHING`,
          [txSig, market.id]
        );
      }
    }
    // Record platform fee as accounting entry (no on-chain tx - fee is tracked off-chain)
    if (totalPlatformFee > 0) {
      const platformFeeTxId = `platform-fee-${market.id}-${Date.now()}`;
      await db.query(
        `INSERT INTO escrow_transactions (tx_signature, type, from_wallet, to_wallet, amount, market_id, status)
         VALUES ($1, 'payout', NULL, $2, $3, $4, 'confirmed')`,
        [platformFeeTxId, process.env.ADMIN_WALLET || 'platform', totalPlatformFee, market.id]
      );
      console.log(`[Resolution] Persisted platform fee: ${totalPlatformFee} to escrow_transactions`);
    }
  } catch (err) {
    console.error('[Resolution] Failed to persist fees (non-blocking):', err.message);
  }
}

// Expose database models and compatibility layer to routers via app.locals
app.locals.db = db;
app.locals.dbCompat = dbCompat;
app.locals.models = { Market, Bet, Agent, Royalty, Points, OddsHistory, Position };
// Expose storage interfaces (these are async-compatible)
app.locals.markets = markets;
app.locals.bets = bets;
app.locals.positions = positions;
app.locals.oddsHistory = oddsHistory;

/**
 * Generate proper verification URL based on resolution source
 * 
 * TOKEN PRICE VERIFICATION STRATEGY:
 * - CoinGecko provides official TOKEN prices (single source of truth)
 * - DexScreener should only be used for SPECIFIC POOL prices
 *   (multiple pools can have different prices for the same token)
 * 
 * If no specific pool URL is provided for DexScreener, we use CoinGecko instead
 */
function generateVerificationUrl(question, resolutionSource, providedUrl) {
  // If a specific DexScreener pool URL is provided (with pool address), keep it
  // This is for bets on specific pool prices, not token prices
  if (providedUrl && providedUrl.includes('dexscreener.com') && 
      (providedUrl.match(/dexscreener\.com\/[a-z]+\/[A-Za-z0-9]+/) || 
       providedUrl.includes('pair'))) {
    console.log(`[VerificationURL] Using specific pool URL: ${providedUrl}`);
    return providedUrl;
  }

  // For token-related resolution sources, generate CoinGecko URL
  // CoinGecko is the single source of truth for TOKEN prices
  if (resolutionSource === 'coingecko' || resolutionSource === 'dexscreener') {
    const token = extractTokenFromQuestion(question);
    if (token) {
      const coinId = getCoinGeckoId(token);
      if (coinId) {
        return `https://www.coingecko.com/en/coins/${coinId}`;
      }
    }
  }

  // For X-related markets
  if (resolutionSource === 'x-api') {
    const handleMatch = question.match(/@([A-Za-z0-9_]+)/);
    if (handleMatch) {
      return `https://x.com/${handleMatch[1]}`;
    }
  }

  // For Moltbook markets
  if (resolutionSource === 'moltbook') {
    const handleMatch = question.match(/@([A-Za-z0-9_]+)/);
    if (handleMatch) {
      return `https://www.moltbook.com/u/${handleMatch[1]}`;
    }
    return 'https://www.moltbook.com/';
  }

  // For GitHub markets
  if (resolutionSource === 'github') {
    const repoMatch = question.match(/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)/i);
    if (repoMatch) {
      return `https://github.com/${repoMatch[1]}`;
    }
  }

  return providedUrl || null;
}

/**
 * Generate verification method description
 */
function generateVerificationMethod(question, resolutionSource, providedMethod, providedUrl) {
  if (providedMethod) {
    return providedMethod;
  }

  // For token prices, use CoinGecko as single source of truth
  // DexScreener only for specific pool prices with URL
  if (resolutionSource === 'coingecko' || resolutionSource === 'dexscreener') {
    const isMcap = /mcap|market cap/i.test(question);
    const isSpecificPool = providedUrl && providedUrl.includes('dexscreener.com');
    
    if (isSpecificPool) {
      return isMcap 
        ? 'Check specific pool market cap on DexScreener at resolution time'
        : 'Check specific pool price on DexScreener at resolution time';
    }
    
    return isMcap 
      ? 'Check official market cap on CoinGecko at resolution time (single source of truth)'
      : 'Check official token price on CoinGecko at resolution time (single source of truth)';
  }

  if (resolutionSource === 'x-api') {
    if (/followers/i.test(question)) {
      return 'Check X follower count via X API at resolution time';
    }
    if (/tweet|post/i.test(question)) {
      return 'Check tweet count via X API at resolution time';
    }
    return 'Verify via X API at resolution time';
  }

  if (resolutionSource === 'moltbook') {
    return 'Check Moltbook stats at resolution time';
  }

  return null;
}

// ==========================================
// MARKET ENDPOINTS
// ==========================================

/**
 * Create a new prediction market
 * POST /api/markets
 */
app.post('/api/markets', async (req, res) => {
  try {
    const {
      question,
      description,
      category,
      resolutionSource,
      endDate,
      creatorWallet,
      creatorAgent,
      resolutionTiming
    } = req.body;

    if (!question || !endDate) {
      return res.status(400).json({ error: 'Question and endDate are required' });
    }

    // Validate end date is in the future (at least 10 minutes)
    const endDateTime = new Date(endDate);
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    if (isNaN(endDateTime.getTime())) {
      return res.status(400).json({ error: 'Invalid endDate format. Use ISO 8601 format (YYYY-MM-DDTHH:MM)' });
    }
    
    if (endDateTime <= now) {
      return res.status(400).json({ error: 'End date must be in the future' });
    }
    
    if (endDateTime < tenMinutesFromNow) {
      return res.status(400).json({ error: 'End date must be at least 10 minutes in the future' });
    }

    const marketId = uuidv4();
    const createdAt = new Date().toISOString();

    // Generate proper verification URL and method
    const finalResolutionSource = resolutionSource || 'manual';
    const verificationUrl = generateVerificationUrl(question, finalResolutionSource, req.body.verificationUrl);
    const verificationMethod = generateVerificationMethod(question, finalResolutionSource, req.body.verificationMethod, req.body.verificationUrl);

    // Extract token ID for token markets (used for price history)
    const tokenSymbol = extractTokenFromQuestion(question);
    const tokenId = tokenSymbol ? getCoinGeckoId(tokenSymbol) : null;

    // Auto-detect tags from question content and merge with user-provided tags
    const userTags = Array.isArray(req.body.tags) ? req.body.tags.map(t => String(t).trim()).filter(Boolean) : [];
    const detectedTags = autoDetectTags(question, category || 'general', finalResolutionSource);
    const mergedTags = [...new Set([...userTags, ...detectedTags])].slice(0, 10);

    const market = {
      id: marketId,
      question,
      description: description || '',
      category: category || 'general', // performance, competition, token, milestone, head-to-head, app
      outcomes: ['YES', 'NO'],
      resolutionSource: finalResolutionSource,
      endDate,
      createdAt: createdAt,
      creatorWallet: creatorWallet || null,
      creatorAgent: creatorAgent || null,
      status: 'active', // active, resolved, cancelled
      resolution: null, // YES, NO, or null
      resolvedAt: null,

      // Enhanced verification info
      verificationUrl, // Auto-generated or provided URL to verify outcome
      verificationMethod, // Auto-generated or provided method description
      threshold: req.body.threshold || null, // Target value for resolution
      tokenId, // CoinGecko token ID for price history (if token market)
      tokenSymbol: tokenSymbol ? tokenSymbol.toUpperCase() : null, // Token symbol
      tags: mergedTags, // Auto-detected + user-provided tags for platform filtering
      resolutionTiming: (resolutionTiming === 'on_target' || resolutionTiming === 'at_close') ? resolutionTiming : 'at_close',

      // Pool tracking
      yesPool: 0, // Total SOL bet on YES (in lamports)
      noPool: 0,  // Total SOL bet on NO (in lamports)
      totalVolume: 0,
      totalBets: 0,

      // Calculated odds (updated on each bet)
      yesOdds: 0.5,
      noOdds: 0.5
    };

    markets.set(marketId, market);

    // Record initial odds history
    await recordOddsHistory(marketId, market);

    // Record market creation for royalty tracking
    if (creatorAgent) {
      royalties.recordMarketCreation(creatorAgent, marketId);
      // Award points for market creation
      await agentFunding.awardMarketCreationPoints(creatorAgent, marketId);
    }

    // Notify bot to track this market for auto-resolution
    if (process.env.BOT_WEBHOOK_URL && finalResolutionSource !== 'manual') {
      const handleMatch = question.match(/@(\w+)\s+(?:reach|hit|get|followers)/i) ||
                          question.match(/will\s+@(\w+)/i);
      const detectedTargetHandle = handleMatch ? handleMatch[1] : null;
      const detectedTargetToken = tokenSymbol || null;
      const detectedTiming = detectResolutionTiming(question, finalResolutionSource, detectedTargetHandle);

      try {
        await axios.post(`${process.env.BOT_WEBHOOK_URL}/webhook/market-created`, {
          marketId,
          question,
          endDate,
          resolutionSource: finalResolutionSource,
          threshold: req.body.threshold || null,
          targetHandle: detectedTargetHandle,
          targetToken: detectedTargetToken,
          resolutionTiming: detectedTiming,
          creatorAgent: creatorAgent || null,
          verificationUrl,
          platform: 'api'
        }, {
          headers: { 'x-api-key': process.env.AGENTBETS_API_KEY || '' },
          timeout: 5000
        });
        console.log(`[Bot Webhook] Notified bot of new off-chain market ${marketId}`);
      } catch (webhookErr) {
        console.warn(`[Bot Webhook] Failed to notify bot of market ${marketId}: ${webhookErr.message}`);
      }
    }

    // Estimate potential royalties
    const royaltyEstimate = royalties.estimateRoyalties(10); // Estimate for 10 SOL volume
    const points = creatorAgent ? agentFunding.getAgentPoints(creatorAgent) : null;

    res.status(201).json({
      success: true,
      market,
      royaltyInfo: creatorAgent ? {
        creator: creatorAgent,
        message: `${creatorAgent.startsWith('@') ? '' : '@'}${creatorAgent} will earn 0.3% of winning payouts from THIS market`,
        note: 'Royalties are per-market only - you earn from the market you created',
        estimatedFor10SOL: royaltyEstimate.estimatedCreatorRoyalty
      } : null,
      pointsAwarded: creatorAgent ? {
        points: 100,
        totalPoints: points?.totalPoints || 100,
        message: '+100 points for market creation!'
      } : null,
      message: `Market created! Bet on: "${question}"`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get all markets
 * GET /api/markets
 */
app.get('/api/markets', async (req, res) => {
  try {
    const { status, category, tags, creatorAgent, limit = 50 } = req.query;

    const filters = { status, category, limit: parseInt(limit) };

    // Support tag filtering (comma-separated, e.g., ?tags=moltbook,token-market)
    if (tags) {
      filters.tags = tags.split(',').map(t => t.trim()).filter(Boolean);
    }

    // Support creatorAgent filtering
    if (creatorAgent) {
      filters.creatorAgent = creatorAgent;
    }

    let results = await markets.findAll(filters);

    // Sort by volume (most active first)
    results.sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));

    res.json({
      markets: results,
      total: results.length
    });
  } catch (error) {
    console.error('[API] Error fetching markets:', error);
    res.status(500).json({ error: 'Failed to fetch markets' });
  }
});

/**
 * Market Feed for Platform Integration
 * GET /api/markets/feed
 * Efficient polling endpoint for platforms to discover new markets
 * Supports cursor-based pagination and tag/category filtering
 * NOTE: This route MUST be defined before /api/markets/:id to avoid route matching issues
 */
app.get('/api/markets/feed', authenticateRequest, async (req, res) => {
  try {
    const { since, tags, category, status = 'active', limit = 20 } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);

    const filters = { status, limit: parsedLimit };

    if (category) {
      filters.category = category;
    }

    if (tags) {
      filters.tags = tags.split(',').map(t => t.trim()).filter(Boolean);
    }

    if (since) {
      const sinceDate = new Date(since);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: 'Invalid since parameter. Use ISO 8601 format (e.g., 2026-02-11T00:00:00Z)' });
      }
      filters.since = sinceDate.toISOString();
    }

    // Get markets matching filters
    const results = await markets.findAll(filters);

    // Get total count of matching markets (for pagination awareness)
    const totalNew = await markets.count(filters);

    // Cursor is the created_at of the last result (for next poll)
    const cursor = results.length > 0 ? results[results.length - 1].createdAt : (since || null);

    res.json({
      markets: results,
      total_new: totalNew,
      returned: results.length,
      cursor,
      filters: {
        since: since || null,
        tags: filters.tags || null,
        category: category || null,
        status
      },
      next_poll_hint: `Use ?since=${cursor || new Date().toISOString()} to get only newer markets`
    });
  } catch (error) {
    console.error('[API] Error fetching market feed:', error);
    res.status(500).json({ error: 'Failed to fetch market feed' });
  }
});

/**
 * Get pending resolutions (admin only)
 * GET /api/markets/pending-resolutions
 * NOTE: This route MUST be defined before /api/markets/:id to avoid route matching issues
 */
app.get('/api/markets/pending-resolutions', async (req, res) => {
  try {
    const allMarkets = await markets.values();
    const pendingMarkets = allMarkets
      .filter(m => m.status === 'pending_confirmation')
      .map(m => ({
        id: m.id,
        question: m.question,
        category: m.category,
        proposedResolution: m.proposedResolution,
        resolutionSource: m.resolutionSource,
        totalVolume: (m.totalVolume || 0) / 1000000, // USDC decimals
        totalBets: m.totalBets || 0,
        yesPool: (m.yesPool || 0) / 1000000,
        noPool: (m.noPool || 0) / 1000000,
        endDate: m.endDate,
        betPda: m.betPda,
        onChain: m.onChain,
        verificationUrl: m.verificationUrl,
        verificationMethod: m.verificationMethod
      }))
      .sort((a, b) => {
        const aDate = a.proposedResolution?.proposedAt || 0;
        const bDate = b.proposedResolution?.proposedAt || 0;
        return new Date(aDate) - new Date(bDate);
      });

    res.json({
      pendingCount: pendingMarkets.length,
      markets: pendingMarkets
    });
  } catch (error) {
    console.error('Error fetching pending resolutions:', error);
    res.status(500).json({ error: 'Failed to fetch pending resolutions' });
  }
});

/**
 * Get market by ID
 * GET /api/markets/:id
 */
app.get('/api/markets/:id', async (req, res) => {
  try {
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    // Get bets for this market
    const marketBets = await bets.findByMarketId(market.id);

    res.json({
      ...market,
      bets: marketBets,
      betCount: marketBets.length
    });
  } catch (error) {
    console.error('[API] Error fetching market:', error);
    res.status(500).json({ error: 'Failed to fetch market' });
  }
});

/**
 * Delete a market (admin only)
 * DELETE /api/markets/:id
 */
app.delete('/api/markets/:id', async (req, res) => {
  try {
    const { adminWallet } = req.body || {};
    
    // Only admin can delete markets
    if (adminWallet !== ADMIN_WALLET) {
      return res.status(403).json({ error: 'Unauthorized. Only admin can delete markets.' });
    }

    const market = await markets.get(req.params.id);
    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    await markets.delete(req.params.id);
    console.log(`[Admin] Market ${req.params.id} deleted by admin: "${market.question}"`);

    res.json({ success: true, deleted: req.params.id, question: market.question });
  } catch (error) {
    console.error('[API] Error deleting market:', error);
    res.status(500).json({ error: 'Failed to delete market' });
  }
});

/**
 * Get market odds history
 * GET /api/markets/:id/history
 */
app.get('/api/markets/:id/history', async (req, res) => {
  try {
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const history = await oddsHistory.getByMarketId(req.params.id) || [];
  
    // Optional: limit the number of data points returned
    const { limit = 50 } = req.query;
    const limitedHistory = history.slice(-parseInt(limit));

    res.json({
      marketId: req.params.id,
      question: market.question,
      currentOdds: {
        yesOdds: market.yesOdds,
        noOdds: market.noOdds,
        yesPool: market.yesPool,
        noPool: market.noPool
      },
      history: limitedHistory,
      totalDataPoints: history.length
    });
  } catch (error) {
    console.error('[API] Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

/**
 * Get token price history for a market
 * GET /api/markets/:id/price-history
 * 
 * Fetches historical price data from CoinGecko for token-related markets.
 * Results are cached for 5 minutes to avoid rate limits.
 */
app.get('/api/markets/:id/price-history', async (req, res) => {
  try {
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    // Check if this is a token-related market
    const token = extractTokenFromQuestion(market.question);
    if (!token) {
      return res.status(400).json({ 
        error: 'Not a token market',
        message: 'This market does not appear to be about a specific token'
      });
    }

    const coinId = getCoinGeckoId(token);
    if (!coinId) {
      return res.status(400).json({ 
        error: 'Unknown token',
        message: `Token ${token} is not recognized`
      });
    }

    // Check cache (5 minute TTL)
    const cacheKey = `${coinId}-${req.params.id}`;
    const cached = priceHistoryCache.get(cacheKey);
    const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
      return res.json({
        marketId: req.params.id,
        token: token.toUpperCase(),
        coinId,
        cached: true,
        ...cached.data
      });
    }

    // Calculate days since market creation (max 90 days for free tier)
    const createdAt = new Date(market.createdAt);
    const now = new Date();
    const daysSinceCreation = Math.min(
      Math.ceil((now - createdAt) / (1000 * 60 * 60 * 24)),
      90
    );
    const days = Math.max(daysSinceCreation, 7); // At least 7 days

    // Fetch from CoinGecko
    const response = await axios.get(
      `${COINGECKO_API_BASE}/coins/${coinId}/market_chart`,
      {
        params: {
          vs_currency: 'usd',
          days: days,
          x_cg_demo_api_key: COINGECKO_API_KEY
        },
        timeout: 10000
      }
    );

    const priceData = {
      prices: response.data.prices.map(([timestamp, price]) => ({
        timestamp: new Date(timestamp).toISOString(),
        price
      })),
      marketCaps: response.data.market_caps.map(([timestamp, mcap]) => ({
        timestamp: new Date(timestamp).toISOString(),
        marketCap: mcap
      })),
      currentPrice: response.data.prices[response.data.prices.length - 1]?.[1],
      currentMarketCap: response.data.market_caps[response.data.market_caps.length - 1]?.[1],
      dataPoints: response.data.prices.length,
      days
    };

    // Cache the result
    priceHistoryCache.set(cacheKey, {
      data: priceData,
      fetchedAt: Date.now()
    });

    res.json({
      marketId: req.params.id,
      token: token.toUpperCase(),
      coinId,
      cached: false,
      ...priceData
    });

  } catch (error) {
    console.error('[PriceHistory] Error:', error.message);
    
    if (error.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limited',
        message: 'CoinGecko API rate limit reached. Please try again in a minute.'
      });
    }

    if (error.response?.status === 404) {
      return res.status(404).json({ 
        error: 'Token not found',
        message: 'This token was not found on CoinGecko'
      });
    }

    res.status(500).json({ error: error.message });
  }
});

/**
 * Get live verification status for a market
 * GET /api/markets/:marketId/verification
 * 
 * Returns current verified value, threshold comparison, and verification source.
 * This is the trustworthy endpoint for checking market status in real-time.
 */
app.get('/api/markets/:marketId/verification', async (req, res) => {
  try {
    const market = await markets.get(req.params.marketId);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    const result = {
      marketId: req.params.marketId,
      question: market.question,
      status: market.status,
      resolutionSource: market.resolutionSource,
      threshold: market.threshold,
      verificationUrl: market.verificationUrl,
      endDate: market.endDate,
      isEnded: new Date(market.endDate) < new Date(),
      timestamp: new Date().toISOString()
    };

    // For token markets, fetch current value from CoinGecko
    if (market.resolutionSource === 'coingecko' || market.resolutionSource === 'dexscreener') {
      const token = market.tokenSymbol || extractTokenFromQuestion(market.question);
      
      if (token) {
        const coinId = market.tokenId || getCoinGeckoId(token);
        
        if (coinId) {
          try {
            const response = await axios.get(
              `${COINGECKO_API_BASE}/simple/price`,
              {
                params: {
                  ids: coinId,
                  vs_currencies: 'usd',
                  include_market_cap: true,
                  include_24hr_change: true,
                  x_cg_demo_api_key: COINGECKO_API_KEY
                },
                timeout: 10000
              }
            );

            const data = response.data?.[coinId];
            if (data) {
              const isMcapQuestion = /mcap|market cap/i.test(market.question);
              const currentValue = isMcapQuestion ? data.usd_market_cap : data.usd;
              
              // Parse threshold for comparison
              const thresholdNum = parseThreshold(market.threshold);
              
              result.verification = {
                token: token.toUpperCase(),
                coinId,
                currentPrice: data.usd,
                currentMarketCap: data.usd_market_cap,
                change24h: data.usd_24h_change,
                relevantValue: currentValue,
                relevantValueFormatted: isMcapQuestion 
                  ? `$${formatLargeNumber(data.usd_market_cap)} mcap`
                  : `$${data.usd.toFixed(data.usd < 1 ? 6 : 2)}`,
                thresholdValue: thresholdNum,
                thresholdMet: thresholdNum ? currentValue >= thresholdNum : null,
                source: 'CoinGecko',
                sourceUrl: `https://www.coingecko.com/en/coins/${coinId}`,
                fetchedAt: new Date().toISOString()
              };
            }
          } catch (apiError) {
            result.verification = {
              error: 'Failed to fetch current value',
              message: apiError.message
            };
          }
        }
      }
    }

    // For X API markets
    if (market.resolutionSource === 'x-api') {
      const handleMatch = market.question.match(/@([A-Za-z0-9_]+)/);
      if (handleMatch) {
        result.verification = {
          handle: handleMatch[1],
          source: 'X API',
          sourceUrl: `https://x.com/${handleMatch[1]}`,
          note: 'Live follower count requires X API access'
        };
      }
    }

    // For Moltbook markets
    if (market.resolutionSource === 'moltbook') {
      result.verification = {
        source: 'Moltbook',
        sourceUrl: market.verificationUrl || 'https://www.moltbook.com/',
        note: 'Check Moltbook for current stats'
      };
    }

    // Add resolution result if market is resolved
    if (market.status === 'resolved') {
      result.resolution = {
        outcome: market.resolution,
        resolvedAt: market.resolvedAt,
        resolutionEvidence: market.resolutionEvidence
      };
    }

    res.json(result);

  } catch (error) {
    console.error('[Verify] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to parse threshold values
function parseThreshold(threshold) {
  if (!threshold) return null;
  
  // Remove common formatting
  const cleaned = threshold.replace(/[,$]/g, '').toLowerCase();
  
  // Handle different formats: "100K", "1M", "1B", "100000"
  const match = cleaned.match(/([\d.]+)\s*(k|m|b|billion|million|thousand)?/i);
  if (!match) return null;
  
  let value = parseFloat(match[1]);
  const suffix = match[2]?.toLowerCase();
  
  if (suffix === 'k' || suffix === 'thousand') value *= 1000;
  else if (suffix === 'm' || suffix === 'million') value *= 1000000;
  else if (suffix === 'b' || suffix === 'billion') value *= 1000000000;
  
  return value;
}

// Helper function to format large numbers
function formatLargeNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  return num.toFixed(2);
}

// Admin wallet - ONLY this wallet can confirm resolutions
const ADMIN_WALLET = process.env.ADMIN_WALLET || 'ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG';

/**
 * Generate admin challenge message for signing
 * GET /api/admin/challenge
 */
app.get('/api/admin/challenge', (req, res) => {
  const { action, marketId } = req.query;
  if (!action || !marketId) {
    return res.status(400).json({ error: 'action and marketId query params required' });
  }
  const message = generateAdminChallenge(action, marketId);
  res.json({ message, expiresIn: '5 minutes' });
});

// Verify wallet signature for secure authentication
function verifyWalletSignature(walletAddress, message, signature) {
  try {
    const publicKey = bs58.decode(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signature);
    
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKey);
  } catch (error) {
    console.error('Signature verification failed:', error.message);
    return false;
  }
}

// Generate a challenge message for admin authentication
function generateAdminChallenge(action, marketId) {
  const timestamp = Date.now();
  const nonce = Math.random().toString(36).substring(2, 15);
  return `AgentBets Admin Action: ${action} on market ${marketId} at ${timestamp} nonce:${nonce}`;
}

// Lightweight admin check — verifies connected wallet is the admin
// Used for actions where the server signs on-chain transactions (not the admin's wallet)
function requireAdminWallet(req, res, next) {
  const { adminWallet } = req.body;

  if (!adminWallet) {
    return res.status(401).json({
      error: 'Admin wallet required',
      message: 'You must provide adminWallet in request body'
    });
  }

  if (adminWallet !== ADMIN_WALLET) {
    return res.status(403).json({
      error: 'Unauthorized',
      message: 'Only the platform admin can perform this action'
    });
  }

  next();
}

// Full admin check with signature verification
// Used for sensitive actions like creating/managing API keys
function requireAdmin(req, res, next) {
  const { adminWallet, signature, message } = req.body;

  if (!adminWallet) {
    return res.status(401).json({
      error: 'Admin wallet required',
      message: 'You must provide adminWallet in request body'
    });
  }

  if (adminWallet !== ADMIN_WALLET) {
    return res.status(403).json({
      error: 'Unauthorized',
      message: 'Only the platform admin can perform this action'
    });
  }

  // Verify signature proves ownership of admin wallet
  if (!signature || !message) {
    return res.status(401).json({
      error: 'Signature required',
      message: 'Admin actions require a signed message to prove wallet ownership'
    });
  }

  // Verify the message is recent (within 5 minutes)
  const messageMatch = message.match(/at (\d+)/);
  if (messageMatch) {
    const messageTime = parseInt(messageMatch[1]);
    const now = Date.now();
    if (now - messageTime > 5 * 60 * 1000) {
      return res.status(401).json({
        error: 'Signature expired',
        message: 'Please sign a new message - signatures expire after 5 minutes'
      });
    }
  }

  if (!verifyWalletSignature(adminWallet, message, signature)) {
    return res.status(401).json({
      error: 'Invalid signature',
      message: 'Could not verify wallet ownership'
    });
  }

  next();
}

// ==========================================
// PARTNER APPLICATION ENDPOINTS
// ==========================================

/**
 * Get challenge message for partner wallet signature
 * GET /api/partner/challenge
 */
app.get('/api/partner/challenge', (req, res) => {
  const { wallet } = req.query;
  if (!wallet) {
    return res.status(400).json({ error: 'wallet query parameter required' });
  }

  const walletClean = sanitizeWalletAddress(wallet);
  if (!walletClean) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const timestamp = Date.now();
  const nonce = Math.random().toString(36).substring(2, 15);
  const message = `AgentBets Partner Application by ${walletClean} at ${timestamp} nonce:${nonce}`;
  res.json({ message, expiresIn: '5 minutes' });
});

/**
 * Submit a partner application
 * POST /api/partner/apply
 * Requires wallet signature to prove ownership
 */
app.post('/api/partner/apply', generalLimiter, async (req, res) => {
  try {
    const { wallet, signature, message, platformName, contactEmail, platformDescription, tagsFilter, categoriesFilter } = req.body;

    // Validate required fields
    if (!wallet || !signature || !message || !platformName) {
      return res.status(400).json({ error: 'wallet, signature, message, and platformName are required' });
    }

    const walletClean = sanitizeWalletAddress(wallet);
    if (!walletClean) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    // Verify the message is recent (within 5 minutes)
    const messageMatch = message.match(/at (\d+)/);
    if (messageMatch) {
      const messageTime = parseInt(messageMatch[1]);
      const now = Date.now();
      if (now - messageTime > 5 * 60 * 1000) {
        return res.status(401).json({ error: 'Signature expired. Please sign a new message.' });
      }
    }

    // Verify wallet signature
    if (!verifyWalletSignature(walletClean, message, signature)) {
      return res.status(401).json({ error: 'Invalid signature. Could not verify wallet ownership.' });
    }

    // Check for existing application (1 key per wallet)
    const existing = await PlatformKey.findByWallet(walletClean);
    if (existing) {
      const statusMessages = {
        pending: 'You already have a pending application. Please wait for admin review.',
        approved: 'You already have an approved API key. Visit the Partner page to view it.',
        active: 'You already have an active API key.',
        rejected: 'Your previous application was rejected. Contact the AgentBets team for more information.'
      };
      return res.status(409).json({
        error: statusMessages[existing.status] || 'An application already exists for this wallet.',
        status: existing.status
      });
    }

    // Create pending application (key generated but NOT active until approved)
    const application = await PlatformKey.create({
      platformName: sanitizeInput(platformName).substring(0, 100),
      contactEmail: contactEmail ? sanitizeInput(contactEmail).substring(0, 255) : null,
      platformDescription: platformDescription ? sanitizeInput(platformDescription).substring(0, 1000) : null,
      walletAddress: walletClean,
      status: 'pending',
      isActive: false,
      permissions: ['read', 'bet'],
      rateLimitPerMinute: 60,
      tagsFilter: Array.isArray(tagsFilter) ? tagsFilter.map(t => sanitizeInput(String(t))).slice(0, 10) : null,
      categoriesFilter: Array.isArray(categoriesFilter) ? categoriesFilter.map(c => sanitizeInput(String(c))).slice(0, 7) : null
    });

    console.log(`[Partner] New application from ${walletClean} for "${platformName}"`);

    res.status(201).json({
      success: true,
      status: 'pending',
      message: 'Application submitted successfully! The AgentBets team will review your application and you will be able to see your status on the Partner page.',
      application: {
        id: application.id,
        platformName: application.platformName,
        status: application.status,
        createdAt: application.createdAt
      }
    });
  } catch (error) {
    console.error('[Partner] Application error:', error);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

/**
 * Check partner application status
 * GET /api/partner/status
 */
app.get('/api/partner/status', async (req, res) => {
  try {
    const { wallet } = req.query;
    if (!wallet) {
      return res.status(400).json({ error: 'wallet query parameter required' });
    }

    const walletClean = sanitizeWalletAddress(wallet);
    if (!walletClean) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const application = await PlatformKey.findByWallet(walletClean);
    if (!application) {
      return res.json({ found: false, status: null });
    }

    // Base response (always returned)
    const response = {
      found: true,
      id: application.id,
      status: application.status,
      platformName: application.platformName,
      contactEmail: application.contactEmail,
      platformDescription: application.platformDescription,
      tagsFilter: application.tagsFilter,
      categoriesFilter: application.categoriesFilter,
      createdAt: application.createdAt,
      reviewedAt: application.reviewedAt
    };

    // Only include API key if approved (partner can copy it)
    if (application.status === 'approved' || application.status === 'active') {
      response.apiKey = application.apiKey;
      response.permissions = application.permissions;
      response.rateLimitPerMinute = application.rateLimitPerMinute;
      response.usage = {
        header: 'X-API-Key: <your-api-key>',
        feedEndpoint: 'GET /api/markets/feed?tags=...',
        marketsEndpoint: 'GET /api/markets?tags=...',
        docsUrl: '/integrate.md'
      };
    }

    // Include rejection reason if rejected
    if (application.status === 'rejected') {
      response.rejectionReason = application.rejectionReason;
    }

    res.json(response);
  } catch (error) {
    console.error('[Partner] Status check error:', error);
    res.status(500).json({ error: 'Failed to check application status' });
  }
});

// ==========================================
// PLATFORM KEY MANAGEMENT (Admin Only)
// ==========================================

/**
 * Generate admin challenge for platform key operations
 * GET /api/admin/platform-keys/challenge
 */
app.get('/api/admin/platform-keys/challenge', (req, res) => {
  const { action } = req.query;
  if (!action) {
    return res.status(400).json({ error: 'action query param required (e.g., create, list, update, delete)' });
  }
  const message = generateAdminChallenge(action, 'platform-keys');
  res.json({ message, expiresIn: '5 minutes' });
});

/**
 * Create a new platform API key
 * POST /api/admin/platform-keys
 */
app.post('/api/admin/platform-keys', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { platformName, contactEmail, permissions, rateLimitPerMinute, tagsFilter, categoriesFilter } = req.body;

    if (!platformName) {
      return res.status(400).json({ error: 'platformName is required' });
    }

    // Validate permissions (only read and bet allowed for platform keys)
    const validPermissions = ['read', 'bet'];
    const requestedPermissions = permissions || ['read', 'bet'];
    const invalidPerms = requestedPermissions.filter(p => !validPermissions.includes(p));
    if (invalidPerms.length > 0) {
      return res.status(400).json({
        error: `Invalid permissions: ${invalidPerms.join(', ')}. Allowed: ${validPermissions.join(', ')}`
      });
    }

    const platformKey = await PlatformKey.create({
      platformName: sanitizeInput(platformName),
      contactEmail: contactEmail ? sanitizeInput(contactEmail) : null,
      permissions: requestedPermissions,
      rateLimitPerMinute: Math.min(Math.max(parseInt(rateLimitPerMinute) || 60, 1), 1000),
      tagsFilter: Array.isArray(tagsFilter) ? tagsFilter.map(t => sanitizeInput(String(t))) : null,
      categoriesFilter: Array.isArray(categoriesFilter) ? categoriesFilter.map(c => sanitizeInput(String(c))) : null
    });

    console.log(`[Admin] Created platform key for ${platformName}: ${platformKey.id}`);

    res.status(201).json({
      success: true,
      platformKey,
      message: `API key created for ${platformName}. Store the apiKey securely - it cannot be retrieved again.`,
      usage: {
        header: 'X-API-Key: <your-api-key>',
        feedEndpoint: 'GET /api/markets/feed?tags=...',
        marketsEndpoint: 'GET /api/markets?tags=...',
        docsUrl: '/integrate.md'
      }
    });
  } catch (error) {
    console.error('[Admin] Error creating platform key:', error);
    res.status(500).json({ error: 'Failed to create platform key' });
  }
});

/**
 * List all platform API keys
 * GET /api/admin/platform-keys
 */
app.get('/api/admin/platform-keys', async (req, res) => {
  try {
    // Simple admin check via API key (no signature needed for read-only)
    const providedKey = req.headers['x-api-key'] || req.query.apiKey;
    if (!AGENTBETS_API_KEY || providedKey !== AGENTBETS_API_KEY) {
      return res.status(403).json({ error: 'Admin API key required' });
    }

    const filters = {};
    if (req.query.activeOnly === 'true') filters.activeOnly = true;
    if (req.query.status) filters.status = req.query.status;

    const keys = await PlatformKey.listAll(filters);

    // Mask API keys for security (show only first 8 and last 4 chars)
    const maskedKeys = keys.map(k => ({
      ...k,
      apiKey: k.apiKey ? `${k.apiKey.substring(0, 8)}...${k.apiKey.substring(k.apiKey.length - 4)}` : null
    }));

    res.json({
      total: maskedKeys.length,
      platformKeys: maskedKeys
    });
  } catch (error) {
    console.error('[Admin] Error listing platform keys:', error);
    res.status(500).json({ error: 'Failed to list platform keys' });
  }
});

/**
 * Update a platform API key
 * PUT /api/admin/platform-keys/:id
 */
app.put('/api/admin/platform-keys/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { platformName, contactEmail, permissions, rateLimitPerMinute, tagsFilter, categoriesFilter, isActive } = req.body;

    const existing = await PlatformKey.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Platform key not found' });
    }

    // Validate permissions if provided
    if (permissions) {
      const validPermissions = ['read', 'bet'];
      const invalidPerms = permissions.filter(p => !validPermissions.includes(p));
      if (invalidPerms.length > 0) {
        return res.status(400).json({
          error: `Invalid permissions: ${invalidPerms.join(', ')}. Allowed: ${validPermissions.join(', ')}`
        });
      }
    }

    const updateData = {};
    if (platformName !== undefined) updateData.platformName = sanitizeInput(platformName);
    if (contactEmail !== undefined) updateData.contactEmail = sanitizeInput(contactEmail);
    if (permissions !== undefined) updateData.permissions = permissions;
    if (rateLimitPerMinute !== undefined) updateData.rateLimitPerMinute = Math.min(Math.max(parseInt(rateLimitPerMinute) || 60, 1), 1000);
    if (tagsFilter !== undefined) updateData.tagsFilter = Array.isArray(tagsFilter) ? tagsFilter.map(t => sanitizeInput(String(t))) : null;
    if (categoriesFilter !== undefined) updateData.categoriesFilter = Array.isArray(categoriesFilter) ? categoriesFilter.map(c => sanitizeInput(String(c))) : null;
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);

    const updated = await PlatformKey.update(id, updateData);

    // Invalidate cache for this key
    platformKeyCache.delete(existing.apiKey);

    console.log(`[Admin] Updated platform key ${id} (${existing.platformName})`);

    res.json({
      success: true,
      platformKey: {
        ...updated,
        apiKey: `${updated.apiKey.substring(0, 8)}...${updated.apiKey.substring(updated.apiKey.length - 4)}`
      }
    });
  } catch (error) {
    console.error('[Admin] Error updating platform key:', error);
    res.status(500).json({ error: 'Failed to update platform key' });
  }
});

/**
 * Deactivate a platform API key
 * DELETE /api/admin/platform-keys/:id
 */
app.delete('/api/admin/platform-keys/:id', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await PlatformKey.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Platform key not found' });
    }

    const deactivated = await PlatformKey.deactivate(id);

    // Invalidate cache
    platformKeyCache.delete(existing.apiKey);

    console.log(`[Admin] Deactivated platform key ${id} (${existing.platformName})`);

    res.json({
      success: true,
      message: `Platform key for ${existing.platformName} has been deactivated`,
      platformKey: {
        ...deactivated,
        apiKey: `${deactivated.apiKey.substring(0, 8)}...${deactivated.apiKey.substring(deactivated.apiKey.length - 4)}`
      }
    });
  } catch (error) {
    console.error('[Admin] Error deactivating platform key:', error);
    res.status(500).json({ error: 'Failed to deactivate platform key' });
  }
});

/**
 * Approve a partner application
 * POST /api/admin/platform-keys/:id/approve
 */
app.post('/api/admin/platform-keys/:id/approve', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await PlatformKey.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (existing.status !== 'pending') {
      return res.status(400).json({
        error: `Cannot approve: application is already ${existing.status}`,
        currentStatus: existing.status
      });
    }

    const approved = await PlatformKey.approve(id);

    // Invalidate cache if exists
    platformKeyCache.delete(existing.apiKey);

    console.log(`[Admin] Approved partner application ${id} (${existing.platformName}) for wallet ${existing.walletAddress}`);

    res.json({
      success: true,
      message: `Partner application for "${existing.platformName}" has been approved. The partner can now view their API key on the Partner page.`,
      platformKey: {
        ...approved,
        apiKey: `${approved.apiKey.substring(0, 8)}...${approved.apiKey.substring(approved.apiKey.length - 4)}`
      }
    });
  } catch (error) {
    console.error('[Admin] Error approving partner:', error);
    res.status(500).json({ error: 'Failed to approve application' });
  }
});

/**
 * Reject a partner application
 * POST /api/admin/platform-keys/:id/reject
 */
app.post('/api/admin/platform-keys/:id/reject', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const existing = await PlatformKey.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'Application not found' });
    }

    if (existing.status !== 'pending') {
      return res.status(400).json({
        error: `Cannot reject: application is already ${existing.status}`,
        currentStatus: existing.status
      });
    }

    const rejected = await PlatformKey.reject(id, reason ? sanitizeInput(reason).substring(0, 500) : null);

    console.log(`[Admin] Rejected partner application ${id} (${existing.platformName}): ${reason || 'No reason given'}`);

    res.json({
      success: true,
      message: `Partner application for "${existing.platformName}" has been rejected.`,
      platformKey: {
        id: rejected.id,
        platformName: rejected.platformName,
        status: rejected.status,
        rejectionReason: rejected.rejectionReason
      }
    });
  } catch (error) {
    console.error('[Admin] Error rejecting partner:', error);
    res.status(500).json({ error: 'Failed to reject application' });
  }
});

// Verify a bet transaction on-chain
async function verifyBetTransaction(txSignature, expectedWallet, expectedAmount) {
  try {
    // Get transaction details from Solana
    const tx = await connection.getTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      return { success: false, error: 'Transaction not found on chain' };
    }

    if (tx.meta?.err) {
      return { success: false, error: 'Transaction failed on chain' };
    }

    // Verify the transaction was signed by the expected wallet
    const signers = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
    const signerAddresses = signers.slice(0, tx.transaction.signatures.length).map(k => k.toBase58());
    
    if (!signerAddresses.includes(expectedWallet)) {
      return { success: false, error: 'Transaction was not signed by the provided wallet' };
    }

    // Verify transaction is recent (within 10 minutes)
    const txTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
    if (txTime < tenMinutesAgo) {
      return { success: false, error: 'Transaction is too old' };
    }

    // Optionally verify amount (check SOL transfer or token transfer)
    // This is a simplified check - in production, verify specific program instructions
    const expectedLamports = Math.floor(expectedAmount * LAMPORTS_PER_SOL);
    const preBalance = tx.meta.preBalances[0] || 0;
    const postBalance = tx.meta.postBalances[0] || 0;
    const transferredAmount = preBalance - postBalance;
    
    // Allow for some variance due to transaction fees
    const minExpected = expectedLamports * 0.95;
    const maxExpected = expectedLamports * 1.1; // Allow for fees
    
    if (transferredAmount < minExpected) {
      console.warn(`Transaction amount mismatch: expected ~${expectedLamports}, got ${transferredAmount}`);
      // Log warning but allow slight variance for fees
    }

    return { success: true, txTime, transferredAmount };
  } catch (error) {
    console.error('Transaction verification error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Propose a resolution (bot or manual)
 * PUT /api/markets/:id/propose-resolution
 *
 * This does NOT settle the market - it only proposes an outcome
 * Admin must confirm via /confirm-resolution before funds are distributed
 */
app.put('/api/markets/:id/propose-resolution', async (req, res) => {
  try {
    const { proposedOutcome, confidence, evidence, proposedBy } = req.body;
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (market.status !== 'active') {
      return res.status(400).json({ error: 'Market already resolved or cancelled' });
    }

    // Manual markets can transition to pending_confirmation without a proposed outcome
    // The admin will decide the outcome. Auto-resolved markets must have YES/NO.
    const isManualTransition = !proposedOutcome && (proposedBy === 'bot-manual-expiry' || market.resolutionSource === 'manual');

    if (!isManualTransition && !['YES', 'NO'].includes(proposedOutcome)) {
      return res.status(400).json({ error: 'Proposed outcome must be YES or NO' });
    }

    // Build the proposed resolution object
    const proposedResolution = isManualTransition
      ? {
          outcome: null,
          confidence: 0,
          evidence: evidence || { reason: 'Market ended - manual resolution required' },
          proposedAt: new Date().toISOString(),
          proposedBy: proposedBy || 'manual'
        }
      : {
          outcome: proposedOutcome,
          confidence: confidence || 0,
          evidence: evidence || {},
          proposedAt: new Date().toISOString(),
          proposedBy: proposedBy || 'manual'
        };

    // Move to pending confirmation state
    await markets.update(market.id, {
      status: 'pending_confirmation',
      proposedResolution
    });

    const outcomeMsg = isManualTransition ? 'PENDING ADMIN DECISION' : proposedOutcome;
    console.log(`[Resolution] Market ${market.id} proposed: ${outcomeMsg} (by ${proposedBy})`);

    res.json({
      success: true,
      market,
      message: `Resolution proposed: ${outcomeMsg}. Awaiting admin confirmation.`,
      nextStep: 'Admin must call POST /api/markets/:id/confirm-resolution to finalize'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Confirm and finalize resolution (ADMIN ONLY)
 * POST /api/markets/:id/confirm-resolution
 *
 * Body: {
 *   finalOutcome: "YES"|"NO",
 *   adminWallet: "ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG",
 *   adminNotes: "optional notes"
 * }
 *
 * This FINALIZES the market and triggers settlement
 */
app.post('/api/markets/:id/confirm-resolution', adminLimiter, requireAdminWallet, async (req, res) => {
  try {
    const { finalOutcome, adminNotes, adminWallet } = req.body;
    console.log(`[Resolution] Admin confirming market ${req.params.id} as ${finalOutcome} (wallet: ${adminWallet})`);
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (market.status !== 'pending_confirmation') {
      return res.status(400).json({
        error: `Market must be in pending_confirmation status. Current status: ${market.status}`
      });
    }

    if (!['YES', 'NO'].includes(finalOutcome)) {
      return res.status(400).json({ error: 'Final outcome must be YES or NO' });
    }

    // FINALIZE THE MARKET
    market.status = 'resolved';
    market.resolution = finalOutcome;
    market.resolvedAt = new Date().toISOString();
    market.resolverWallet = adminWallet;
    market.adminNotes = adminNotes || null;
    market.confirmedBy = 'admin';

    // If this is an on-chain market, resolve it on-chain
    if (market.betPda) {
      console.log(`[Resolution] Resolving on-chain market: ${market.betPda}`);

      try {
        // First check if the market is ALREADY resolved on-chain (idempotency)
        // This handles cases where a previous attempt submitted the tx but timed out
        let alreadyResolved = false;
        try {
          const onChainData = await pollFunService.getMarketData(market.betPda);
          // IMPORTANT: resolvedOutcome can be "NotResolvedYet" which is truthy but means NOT resolved
          // Only skip if status is "Resolved" AND resolvedOutcome is an actual outcome (For/Against)
          const actuallyResolved = onChainData.success && 
            onChainData.status === 'Resolved' && 
            onChainData.resolvedOutcome && 
            onChainData.resolvedOutcome !== 'NotResolvedYet';
          
          if (actuallyResolved) {
            console.log(`[Resolution] Market already resolved on-chain: ${onChainData.resolvedOutcome}`);
            alreadyResolved = true;
            market.onChainResolutionTx = 'already-resolved-on-chain';
          } else {
            console.log(`[Resolution] On-chain status: ${onChainData.status}, resolvedOutcome: ${onChainData.resolvedOutcome} - proceeding with resolution`);
          }
        } catch (checkErr) {
          console.log(`[Resolution] Could not check on-chain status: ${checkErr.message}, proceeding with resolution`);
        }

        if (!alreadyResolved) {
          const onChainResult = await pollFunService.resolveMarket({
            betPda: market.betPda,
            winningOutcome: finalOutcome
          });

          if (!onChainResult.success) {
            console.error(`[Resolution] On-chain resolution failed:`, onChainResult.error);
            // Don't block the off-chain resolution - mark it and continue
            market.onChainError = onChainResult.error;
            console.log(`[Resolution] Continuing with off-chain resolution despite on-chain failure`);
          } else {
            market.onChainResolutionTx = onChainResult.txSignature || onChainResult.resolveTx;
            console.log(`[Resolution] On-chain resolution tx: ${market.onChainResolutionTx}`);
          }
        }
      } catch (onChainError) {
        console.error(`[Resolution] On-chain resolution exception:`, onChainError.message);
        market.onChainError = onChainError.message;
        console.log(`[Resolution] Continuing with off-chain resolution despite on-chain exception`);
      }

      // Persist resolved state early so DB reflects reality even if settlement fails
      market.settlementStatus = market.onChainResolutionTx && !market.onChainError ? 'resolving' : market.settlementStatus;
      await markets.set(market.id, market);

      // Auto-settle all batches for on-chain market (only if on-chain resolution succeeded)
      market._settlementTxSignatures = [];
      if (market.onChainResolutionTx && !market.onChainError) {
        try {
          console.log(`[Resolution] Auto-settling on-chain market: ${market.betPda}`);

          const marketData = await pollFunService.getMarketData(market.betPda);
          if (marketData.success) {
            const totalUsers = marketData.currentUserCount || 0;
            const totalBatches = Math.ceil(totalUsers / 10);

            for (let batchNumber = 0; batchNumber < totalBatches; batchNumber++) {
              try {
                const settleResult = await pollFunService.settleBatch({
                  betPda: market.betPda,
                  batchNumber,
                  usersPerBatch: 10
                });
                if (settleResult.success && settleResult.txSignature) {
                  market._settlementTxSignatures.push(settleResult.txSignature);
                }
                console.log(`[Resolution] Settled batch ${batchNumber}/${totalBatches}`);
              } catch (err) {
                console.error(`[Resolution] Error settling batch ${batchNumber}:`, err.message);
              }
            }

            market.settlementStatus = 'settled';
            market.settledAt = new Date().toISOString();

            // Attempt to close bet to reclaim rent (requires Poll.fun protocol authority)
            const closeResult = await pollFunService.closeBet({ betPda: market.betPda });
            if (closeResult.success) {
              market.settlementStatus = 'closed';
              console.log(`[Resolution] Bet closed, reclaimed ${closeResult.reclaimedSOL?.toFixed(6)} SOL`);
            } else if (closeResult.protocolLimited) {
              console.log(`[Resolution] Rent reclaim not available (Poll.fun protocol authority required)`);
            }
          }
        } catch (settleError) {
          console.error(`[Resolution] Settlement error:`, settleError.message);
          market.settlementError = settleError.message;
        }
      }
    }

    await markets.set(market.id, market);

    // Calculate payouts (fees were already taken at wager time — pool is net of 1% fee)
    const allBets = await bets.values();
    const marketBets = allBets.filter(b => b.marketId === market.id);
    const winningBets = marketBets.filter(b => b.outcome === finalOutcome);
    const losingPool = finalOutcome === 'YES' ? market.noPool : market.yesPool;
    const winningPool = finalOutcome === 'YES' ? market.yesPool : market.noPool;

    const payouts = winningBets.map(bet => {
      const share = winningPool > 0 ? bet.amount / winningPool : 0;
      const grossWinnings = bet.amount + (share * losingPool);
      return {
        betId: bet.id,
        wallet: bet.wallet,
        originalBet: bet.amount,
        grossWinnings: Math.floor(grossWinnings),
        netWinnings: Math.floor(grossWinnings), // No settlement fee — taken at wager time
        feeDeducted: 0,
        share: share
      };
    });

    const royaltySummary = {
      creatorAgent: market.creatorAgent,
      feeBreakdown: '1% fee deducted at wager time (0.3% creator, 0.7% platform). No additional fee at settlement.',
      note: 'Fees already collected when wagers were placed.'
    };

    // Record settlement tx signatures in escrow_transactions for tracking
    const settlementTxSignatures = market._settlementTxSignatures || [];
    if (settlementTxSignatures.length > 0) {
      await persistResolutionFees(market, 0, 0, settlementTxSignatures);
    }
    delete market._settlementTxSignatures;

    // Clean up pending_resolutions row now that market is confirmed
    if (isDbConnected()) {
      try {
        const deleted = await Resolution.delete(market.id);
        if (deleted) console.log(`[Resolution] Removed market ${market.id} from pending_resolutions`);
      } catch (err) {
        console.warn(`[Resolution] Failed to clean up pending_resolutions:`, err.message);
      }
    }

    console.log(`[Resolution] Market ${market.id} CONFIRMED: ${finalOutcome} by admin`);

    // Notify bot via webhook to announce final resolution
    if (process.env.BOT_WEBHOOK_URL) {
      try {
        await axios.post(`${process.env.BOT_WEBHOOK_URL}/webhook/resolution-confirmed`, {
          marketId: market.id,
          outcome: finalOutcome,
          actualValue: market.proposedResolution?.evidence?.actualValue || finalOutcome,
          source: market.proposedResolution?.evidence?.source || 'manual',
          data: market
        }, {
          headers: {
            'X-API-Key': process.env.AGENTBETS_API_KEY || '',
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });
        console.log(`[Resolution] Webhook sent to bot for market ${market.id}`);
      } catch (webhookError) {
        console.error(`[Resolution] Failed to notify bot webhook:`, webhookError.message);
        // Don't fail the resolution if webhook fails
      }
    }

    res.json({
      success: true,
      market,
      resolution: finalOutcome,
      payouts,
      royalties: royaltySummary,
      onChainSettlement: market.betPda ? {
        resolved: true,
        settled: market.settlementStatus === 'settled',
        txSignature: market.onChainResolutionTx
      } : null,
      message: `Market resolved and confirmed: ${finalOutcome}! ${winningBets.length} winners. ${
        market.betPda ? 'On-chain settlement completed.' : 'Off-chain payouts calculated.'
      }`
    });
  } catch (error) {
    console.error('[Resolution] Confirmation error:', error);
    res.status(500).json({ 
      error: error.message,
      stack: process.env.NODE_ENV !== 'production' ? error.stack : undefined,
      details: `Failed at confirm-resolution for market ${req.params.id}`
    });
  }
});

/**
 * Override proposed resolution (ADMIN ONLY)
 * POST /api/markets/:id/override-resolution
 *
 * Use this if you disagree with the bot's proposed resolution
 */
app.post('/api/markets/:id/override-resolution', adminLimiter, requireAdminWallet, async (req, res) => {
  try {
    const { overrideOutcome, reason, adminWallet } = req.body;
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (market.status !== 'pending_confirmation') {
      return res.status(400).json({
        error: `Market must be in pending_confirmation status. Current status: ${market.status}`
      });
    }

    if (!['YES', 'NO'].includes(overrideOutcome)) {
      return res.status(400).json({ error: 'Override outcome must be YES or NO' });
    }

    // Update proposed resolution with override
    const originalProposal = market.proposedResolution;
    market.proposedResolution = {
      outcome: overrideOutcome,
      confidence: 100, // Admin override = 100% confidence
      evidence: {
        type: 'admin_override',
        originalProposal: originalProposal,
        reason: reason || 'Admin manual override'
      },
      proposedAt: new Date().toISOString(),
      proposedBy: 'admin_override'
    };

    await markets.set(market.id, market);

    console.log(`[Resolution] Market ${market.id} OVERRIDDEN: ${originalProposal.outcome} → ${overrideOutcome}`);

    res.json({
      success: true,
      market,
      message: `Resolution overridden to ${overrideOutcome}. Original proposal was ${originalProposal.outcome}.`,
      nextStep: 'Call POST /api/markets/:id/confirm-resolution to finalize with the new outcome'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Retry on-chain resolution for stuck markets (ADMIN ONLY)
 * POST /api/markets/:id/retry-onchain-resolution
 * 
 * Use this when DB shows resolved but on-chain is stuck (e.g., in "Resolving" state)
 * This completes the on-chain resolution, settlement, and sends webhook to bot
 */
app.post('/api/markets/:id/retry-onchain-resolution', adminLimiter, requireAdminWallet, async (req, res) => {
  try {
    const { adminWallet } = req.body;
    console.log(`[Resolution] Retry request from admin ${adminWallet} for market ${req.params.id}`);
    
    const market = await markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (!market.betPda) {
      return res.status(400).json({ error: 'Market is not on-chain' });
    }

    if (!market.resolution || !['YES', 'NO'].includes(market.resolution)) {
      return res.status(400).json({ 
        error: 'Market must have a resolution (YES/NO) set. Current resolution: ' + market.resolution 
      });
    }

    // Check if bot keypair is configured
    if (!pollFunService.creatorKeypair) {
      return res.status(500).json({ 
        error: 'Bot keypair not configured',
        details: 'SOLANA_PRIVATE_KEY environment variable is not set on the API server'
      });
    }

    const botWallet = pollFunService.creatorKeypair.publicKey.toBase58();
    console.log(`[Resolution] Bot wallet (resolver): ${botWallet}`);
    console.log(`[Resolution] Market creator: ${market.creatorWallet}`);
    
    // Verify bot is the creator (required for isCreatorResolver markets)
    if (market.creatorWallet && market.creatorWallet !== botWallet) {
      return res.status(400).json({
        error: 'Bot wallet mismatch',
        details: `Market was created by ${market.creatorWallet} but bot wallet is ${botWallet}. Only the creator can resolve.`
      });
    }

    console.log(`[Resolution] Admin retrying on-chain resolution for market ${req.params.id}`);

    // Check current on-chain state
    let onChainData;
    try {
      onChainData = await pollFunService.getMarketData(market.betPda);
    } catch (fetchErr) {
      return res.status(500).json({
        error: 'Failed to fetch on-chain market data',
        details: fetchErr.message
      });
    }
    console.log(`[Resolution] On-chain status: ${onChainData.status}, resolvedOutcome: ${onChainData.resolvedOutcome}`);

    // If already fully resolved on-chain, just proceed to settlement
    const alreadyResolved = onChainData.success && 
      onChainData.status === 'Resolved' && 
      onChainData.resolvedOutcome && 
      onChainData.resolvedOutcome !== 'NotResolvedYet';

    if (!alreadyResolved) {
      // Complete the on-chain resolution
      console.log(`[Resolution] Completing on-chain resolution: ${market.resolution}`);
      const onChainResult = await pollFunService.resolveMarket({
        betPda: market.betPda,
        winningOutcome: market.resolution
      });

      if (!onChainResult.success) {
        return res.status(500).json({ 
          error: 'On-chain resolution failed', 
          details: onChainResult.error,
          onChainStatus: onChainData.status
        });
      }

      market.onChainResolutionTx = onChainResult.txSignature || onChainResult.resolveTx;
      console.log(`[Resolution] On-chain resolution tx: ${market.onChainResolutionTx}`);
    } else {
      console.log(`[Resolution] Market already resolved on-chain, proceeding to settlement`);
      market.onChainResolutionTx = market.onChainResolutionTx || 'already-resolved-on-chain';
    }

    // Auto-settle all batches
    const settlementTxSignatures = [];
    try {
      console.log(`[Resolution] Auto-settling on-chain market: ${market.betPda}`);
      const freshData = await pollFunService.getMarketData(market.betPda);
      
      if (freshData.success) {
        const totalUsers = freshData.currentUserCount || 0;
        const totalBatches = Math.ceil(totalUsers / 10);

        for (let batchNumber = 0; batchNumber < totalBatches; batchNumber++) {
          try {
            const settleResult = await pollFunService.settleBatch({
              betPda: market.betPda,
              batchNumber,
              usersPerBatch: 10
            });
            if (settleResult.success && settleResult.txSignature) {
              settlementTxSignatures.push(settleResult.txSignature);
            }
            console.log(`[Resolution] Settled batch ${batchNumber + 1}/${totalBatches}`);
          } catch (err) {
            console.error(`[Resolution] Error settling batch ${batchNumber}:`, err.message);
          }
        }

        market.settlementStatus = 'settled';
        market.settledAt = new Date().toISOString();
      }
    } catch (settleError) {
      console.error(`[Resolution] Settlement error:`, settleError.message);
      market.settlementError = settleError.message;
    }

    // Save updated market
    await markets.set(market.id, market);

    // Persist settlement tx signatures for tracking (fees were already collected at wager time)
    if (settlementTxSignatures.length > 0) {
      await persistResolutionFees(market, 0, 0, settlementTxSignatures);
    }

    // Notify bot via webhook
    if (process.env.BOT_WEBHOOK_URL) {
      try {
        await axios.post(`${process.env.BOT_WEBHOOK_URL}/webhook/resolution-confirmed`, {
          marketId: market.id,
          outcome: market.resolution,
          actualValue: market.proposedResolution?.evidence?.actualValue || market.resolution,
          source: market.proposedResolution?.evidence?.source || 'manual',
          data: market
        }, {
          headers: {
            'X-API-Key': process.env.AGENTBETS_API_KEY || '',
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });
        console.log(`[Resolution] Webhook sent to bot for market ${market.id}`);
      } catch (webhookError) {
        console.error(`[Resolution] Failed to notify bot webhook:`, webhookError.message);
      }
    }

    res.json({
      success: true,
      market,
      onChainResolutionTx: market.onChainResolutionTx,
      settlementStatus: market.settlementStatus,
      message: `On-chain resolution completed for ${market.resolution}. Settlement status: ${market.settlementStatus || 'pending'}`
    });
  } catch (error) {
    console.error('[Resolution] Retry on-chain error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Force-sync market status from on-chain (ADMIN ONLY)
 * POST /api/markets/:id/force-sync-resolution
 *
 * Use when on-chain settlement succeeded but DB is still pending_confirmation.
 * Reads on-chain state and updates DB to match. Also persists royalty/escrow records.
 */
app.post('/api/markets/:id/force-sync-resolution', adminLimiter, requireAdminWallet, async (req, res) => {
  try {
    const market = await markets.get(req.params.id);
    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }
    if (!market.betPda) {
      return res.status(400).json({ error: 'Market is not on-chain' });
    }

    const onChainData = await pollFunService.getMarketData(market.betPda);
    if (!onChainData.success) {
      return res.status(500).json({ error: 'Failed to fetch on-chain data', details: onChainData.error });
    }

    const isResolved = onChainData.status === 'Resolved' &&
      onChainData.resolvedOutcome &&
      onChainData.resolvedOutcome !== 'NotResolvedYet';

    if (!isResolved) {
      return res.status(400).json({
        error: 'Market is not resolved on-chain',
        onChainStatus: onChainData.status,
        resolvedOutcome: onChainData.resolvedOutcome
      });
    }

    // Map Poll.fun outcome to YES/NO
    const resolution = onChainData.resolvedOutcome === 'For' ? 'YES' : 'NO';

    // Update market to match on-chain state
    market.status = 'resolved';
    market.resolution = resolution;
    market.resolvedAt = market.resolvedAt || new Date().toISOString();
    market.onChainResolutionTx = market.onChainResolutionTx || 'synced-from-chain';
    market.settlementStatus = 'settled';
    market.settledAt = market.settledAt || new Date().toISOString();
    delete market.onChainError;
    delete market.settlementError;

    await markets.set(market.id, market);

    // Clean up pending_resolutions row since market is now resolved
    if (isDbConnected()) {
      try {
        const deleted = await Resolution.delete(market.id);
        if (deleted) console.log(`[Resolution] Removed market ${market.id} from pending_resolutions`);
      } catch (err) {
        console.warn(`[Resolution] Failed to clean up pending_resolutions:`, err.message);
      }
    }

    // Fees are collected at wager time — no settlement-time royalties to compute
    console.log(`[Resolution] Force-synced market ${market.id} from chain: ${resolution}`);

    res.json({
      success: true,
      market,
      syncedFromChain: true,
      resolution,
      feeNote: 'Fees were collected at wager time (1% per wager). No additional settlement fees.',
      message: `Market synced from on-chain state. Status: resolved, Resolution: ${resolution}`
    });
  } catch (error) {
    console.error('[Resolution] Force-sync error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DEPRECATED: Old resolve endpoint (kept for backwards compatibility)
 * Use propose-resolution + confirm-resolution instead
 */
app.put('/api/markets/:id/resolve', async (req, res) => {
  res.status(410).json({
    error: 'This endpoint is deprecated',
    message: 'Use two-phase resolution: POST /api/markets/:id/propose-resolution, then POST /api/markets/:id/confirm-resolution',
    migration: {
      step1: 'Bot calls PUT /api/markets/:id/propose-resolution with proposed outcome',
      step2: 'Admin reviews at GET /api/markets/pending-resolutions',
      step3: 'Admin confirms via POST /api/markets/:id/confirm-resolution with adminWallet'
    }
  });
});

// ==========================================
// BETTING ENDPOINTS
// ==========================================

/**
 * Place a bet
 * POST /api/bets
 */
app.post('/api/bets', betLimiter, async (req, res) => {
  try {
    const { marketId, outcome, amount, wallet, txSignature, agentHandle, source } = req.body;

    if (!marketId || !outcome || !amount || !wallet) {
      return res.status(400).json({
        error: 'marketId, outcome, amount, and wallet are required'
      });
    }

    const market = await markets.get(marketId);
    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (market.status !== 'active') {
      return res.status(400).json({ error: 'Market is not active' });
    }

    if (new Date(market.endDate) < new Date()) {
      return res.status(400).json({ error: 'Market has ended' });
    }

    if (!['YES', 'NO'].includes(outcome)) {
      return res.status(400).json({ error: 'Outcome must be YES or NO' });
    }

    // Enforce $1 minimum bet (50-wager cap per market makes sub-dollar bets uneconomical)
    const betAmountParsed = parseFloat(amount);
    if (isNaN(betAmountParsed) || betAmountParsed < 1) {
      return res.status(400).json({ error: 'Minimum bet amount is 1 USDC' });
    }

    // Verify transaction on-chain if signature provided
    if (txSignature) {
      // Verify real transactions on-chain
      const isTestSignature = process.env.NODE_ENV === 'development' &&
        (txSignature.startsWith('test_') || txSignature.startsWith('demo_'));
      
      if (!isTestSignature) {
        try {
          const txVerified = await verifyBetTransaction(txSignature, wallet, amount);
          if (!txVerified.success) {
            return res.status(400).json({
              error: 'Transaction verification failed',
              message: txVerified.error || 'Could not verify transaction on Solana'
            });
          }
        } catch (verifyError) {
          console.error('Transaction verification error:', verifyError.message);
          return res.status(400).json({
            error: 'Transaction verification failed',
            message: 'Could not verify transaction. Please try again.'
          });
        }
      } else if (isTestSignature) {
        console.log(`[Test] Skipping verification for test signature: ${txSignature.substring(0, 20)}...`);
      }
    } else if (process.env.REQUIRE_TX_SIGNATURE === 'true') {
      return res.status(400).json({
        error: 'Transaction signature required',
        message: 'Please provide the txSignature from your on-chain transaction'
      });
    }

    // USDC uses 6 decimals
    const USDC_DECIMALS = 6;
    const amountMicroUsdc = Math.floor(amount * Math.pow(10, USDC_DECIMALS));

    const betId = uuidv4();
    const bet = {
      id: betId,
      marketId,
      outcome,
      amount: amountMicroUsdc,
      amountUSDC: amount,
      wallet,
      agentHandle: agentHandle || null,
      txSignature: txSignature || null,
      betPda: market.betPda || null,
      onChain: market.onChain || false,
      placedAt: new Date().toISOString(),
      status: 'active', // active, won, lost, claimed
      currency: 'USDC',
      source: source || (market.onChain ? 'api-onchain' : 'api')
    };

    await bets.set(betId, bet);

    // Update market pools (in micro USDC)
    if (outcome === 'YES') {
      market.yesPool = (market.yesPool || 0) + amountMicroUsdc;
    } else {
      market.noPool = (market.noPool || 0) + amountMicroUsdc;
    }
    market.totalVolume = (market.totalVolume || 0) + amountMicroUsdc;
    market.totalBets = (market.totalBets || 0) + 1;

    // Recalculate odds
    const totalPool = market.yesPool + market.noPool;
    if (totalPool > 0) {
      market.yesOdds = market.yesPool / totalPool; // Probability of YES
      market.noOdds = market.noPool / totalPool; // Probability of NO
    }

    await markets.set(marketId, market);

    // Record odds history after bet
    await recordOddsHistory(marketId, market);

    // Update user positions
    await positions.upsert(wallet, marketId, outcome, amountMicroUsdc);

    // Persist platform fee (1% taken at wager time) to royalty & escrow tables
    if (market.betPda && isDbConnected()) {
      try {
        const wagerFee = calculateWagerFee(amount);
        if (wagerFee.feeAmountMicro > 0) {
          // Track creator royalty (0.3% of wager)
          if (market.creatorAgent && wagerFee.creatorShareMicro > 0) {
            const handle = market.creatorAgent.toLowerCase().replace('@', '');
            await Royalty.getOrCreate(handle);
            await Royalty.addEarnings(handle, wagerFee.creatorShareMicro, market.id);
            console.log(`[Fees] Creator @${handle} earned ${wagerFee.creatorShareMicro / 1e6} USDC from wager on market ${market.id}`);
          }
          // Track platform fee (0.7% of wager) in escrow_transactions
          if (wagerFee.platformShareMicro > 0) {
            const feeTxId = `wager-fee-${betId}`;
            await db.query(
              `INSERT INTO escrow_transactions (tx_signature, type, from_wallet, to_wallet, amount, market_id, bet_id, status)
               VALUES ($1, 'deposit', $2, $3, $4, $5, $6, 'confirmed')
               ON CONFLICT (tx_signature) DO NOTHING`,
              [feeTxId, wallet, process.env.PLATFORM_FEE_WALLET || process.env.ESCROW_WALLET || 'platform', wagerFee.platformShareMicro, market.id, betId]
            );
          }
          // Also track in-memory royalty system
          royalties.calculateRoyalties(market.creatorAgent, amountMicroUsdc);
        }
      } catch (feeErr) {
        console.error('[Fees] Failed to persist wager fee (non-blocking):', feeErr.message);
      }
    }

    // Award wager points if agent handle is provided (1 point per $1 wagered)
    let pointsAwarded = null;
    if (agentHandle) {
      try {
        pointsAwarded = await agentFunding.awardWagerPoints(agentHandle, amount);
      } catch (pointsError) {
        console.error('[Points] Error awarding wager points:', pointsError.message);
      }
    }

    res.status(201).json({
      success: true,
      bet,
      market: {
        id: market.id,
        yesPool: market.yesPool / Math.pow(10, USDC_DECIMALS),
        noPool: market.noPool / Math.pow(10, USDC_DECIMALS),
        yesOdds: market.yesOdds,
        noOdds: market.noOdds
      },
      pointsAwarded: pointsAwarded ? pointsAwarded.totalPoints : null,
      message: `Bet placed! ${amount} USDC on ${outcome}`
    });

    // Notify bot of bet placement (non-blocking)
    if (process.env.BOT_WEBHOOK_URL) {
      axios.post(`${process.env.BOT_WEBHOOK_URL}/webhook/bet-placed`, {
        marketId: market.id,
        bettor: agentHandle || wallet?.slice(0, 8),
        outcome,
        amount,
        currency: 'USDC',
        question: market.question,
        creatorAgent: market.creatorAgent
      }, {
        headers: {
          'X-API-Key': process.env.AGENTBETS_API_KEY || '',
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }).catch(err => {
        console.warn('[Webhook] Failed to notify bot of bet placement:', err.message);
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user's bets
 * GET /api/bets/user/:wallet
 */
app.get('/api/bets/user/:wallet', async (req, res) => {
  try {
    const userBetsList = await bets.findByWallet(req.params.wallet);
    
    // Enrich with market data
    const enrichedBets = await Promise.all(userBetsList.map(async (bet) => {
      const market = await markets.get(bet.marketId);
      return {
        ...bet,
        market: market ? {
          question: market.question,
          status: market.status,
          resolution: market.resolution
        } : null
      };
    }));

    res.json({
      wallet: req.params.wallet,
      bets: enrichedBets,
      totalBets: enrichedBets.length
    });
  } catch (error) {
    console.error('Error fetching user bets:', error);
    res.status(500).json({ error: 'Failed to fetch user bets' });
  }
});

/**
 * Get bets for a market
 * GET /api/bets/market/:id
 */
app.get('/api/bets/market/:id', async (req, res) => {
  try {
    const marketBets = await bets.findByMarketId(req.params.id);

    const yesBets = marketBets.filter(b => b.outcome === 'YES');
    const noBets = marketBets.filter(b => b.outcome === 'NO');

    res.json({
      marketId: req.params.id,
      bets: marketBets,
      summary: {
        totalBets: marketBets.length,
        yesBets: yesBets.length,
        noBets: noBets.length,
        yesVolume: yesBets.reduce((sum, b) => sum + (b.amountSOL || 0), 0),
        noVolume: noBets.reduce((sum, b) => sum + (b.amountSOL || 0), 0)
      }
    });
  } catch (error) {
    console.error('Error fetching market bets:', error);
    res.status(500).json({ error: 'Failed to fetch market bets' });
  }
});

// ==========================================
// POSITION & CLAIM ENDPOINTS
// ==========================================

/**
 * Get user's positions
 * GET /api/positions/:wallet
 */
app.get('/api/positions/:wallet', async (req, res) => {
  try {
    const userPositionsList = await positions.findByWallet(req.params.wallet);
    
    const enrichedPositions = await Promise.all(userPositionsList.map(async (pos) => {
      const market = await markets.get(pos.marketId);
      let status = 'active';
      let potentialWinnings = 0;
      const totalBet = pos.totalAmount || pos.totalBet || 0;

      if (market && market.status === 'resolved') {
        status = pos.outcome === market.resolution ? 'won' : 'lost';
        if (status === 'won') {
          const winningPool = market.resolution === 'YES' ? market.yesPool : market.noPool;
          const losingPool = market.resolution === 'YES' ? market.noPool : market.yesPool;
          const share = totalBet / winningPool;
          potentialWinnings = totalBet + (share * losingPool * 0.99);
        }
      } else if (market) {
        // Calculate potential winnings if they win
        const pool = pos.outcome === 'YES' ? market.yesPool : market.noPool;
        const oppositePool = pos.outcome === 'YES' ? market.noPool : market.yesPool;
        if (pool > 0) {
          const share = totalBet / pool;
          potentialWinnings = totalBet + (share * oppositePool * 0.99);
        }
      }

      return {
        ...pos,
        totalBet,
        totalBetSOL: totalBet / LAMPORTS_PER_SOL,
        potentialWinningsSOL: potentialWinnings / LAMPORTS_PER_SOL,
        status,
        market: market ? {
          question: market.question,
          status: market.status,
          resolution: market.resolution,
          yesOdds: market.yesOdds,
          noOdds: market.noOdds
        } : null
      };
    }));

    res.json({
      wallet: req.params.wallet,
      positions: enrichedPositions,
      totalPositions: enrichedPositions.length
    });
  } catch (error) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

/**
 * Claim winnings
 * POST /api/positions/claim
 */
app.post('/api/positions/claim', async (req, res) => {
  try {
    const { wallet, marketId } = req.body;

    // Find winning position
    const positionKey = Array.from(positions.keys()).find(key => {
      const pos = positions.get(key);
      return pos.wallet === wallet && pos.marketId === marketId;
    });

    if (!positionKey) {
      return res.status(404).json({ error: 'Position not found' });
    }

    const position = positions.get(positionKey);
    const market = await markets.get(marketId);

    if (!market || market.status !== 'resolved') {
      return res.status(400).json({ error: 'Market not resolved yet' });
    }

    if (position.outcome !== market.resolution) {
      return res.status(400).json({ error: 'This position did not win' });
    }

    // Calculate winnings
    const winningPool = market.resolution === 'YES' ? market.yesPool : market.noPool;
    const losingPool = market.resolution === 'YES' ? market.noPool : market.yesPool;
    const share = position.totalBet / winningPool;
    const winnings = Math.floor(position.totalBet + (share * losingPool * 0.99));

    // In production: execute Solana transfer from escrow to wallet
    // For MVP: return the claim info (manual payout or trusted)

    res.json({
      success: true,
      claim: {
        wallet,
        marketId,
        originalBet: position.totalBet / LAMPORTS_PER_SOL,
        winnings: winnings / LAMPORTS_PER_SOL,
        profit: (winnings - position.totalBet) / LAMPORTS_PER_SOL
      },
      message: `Claim processed! ${winnings / LAMPORTS_PER_SOL} SOL 🎉`,
      // In production: include txSignature
      instructions: 'Winnings will be sent to your wallet within 24 hours.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ORACLE ENDPOINTS
// ==========================================

function getOracleDescription(source) {
  const info = oracle.getOracleInfo(source);
  return info.description;
}

/**
 * List all oracle types (must come before parameterized routes)
 * GET /api/oracle/types
 */
app.get('/api/oracle/types', (req, res) => {
  res.json(oracle.ORACLE_TYPES);
});

/**
 * Get DexScreener token data
 * GET /api/oracle/dexscreener/:tokenAddress
 */
app.get('/api/oracle/dexscreener/:tokenAddress', async (req, res) => {
  try {
    const data = await oracle.getDexScreenerData(req.params.tokenAddress);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Solana account data
 * GET /api/oracle/solana/:address
 */
app.get('/api/oracle/solana/:address', async (req, res) => {
  try {
    const data = await oracle.getSolanaAccountData(req.params.address);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Moltbook user data
 * GET /api/oracle/moltbook/user/:username
 */
app.get('/api/oracle/moltbook/user/:username', async (req, res) => {
  try {
    const data = await oracle.getMoltbookUserData(req.params.username);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Moltbook platform stats
 * GET /api/oracle/moltbook/stats
 */
app.get('/api/oracle/moltbook/stats', async (req, res) => {
  try {
    const data = await oracle.getMoltbookStats();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Evaluate market for auto-resolution
 * GET /api/oracle/:marketId/evaluate
 */
app.get('/api/oracle/:marketId/evaluate', async (req, res) => {
  const market = await markets.get(req.params.marketId);

  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }

  try {
    const evaluation = await oracle.evaluateMarketCondition(market);
    evaluation.isExpired = oracle.isMarketExpired(market);

    res.json(evaluation);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get oracle data for a market (parameterized route - must come last)
 * GET /api/oracle/:marketId
 */
app.get('/api/oracle/:marketId', async (req, res) => {
  const market = await markets.get(req.params.marketId);

  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }

  // Return resolution source info
  res.json({
    marketId: market.id,
    question: market.question,
    resolutionSource: market.resolutionSource,
    status: market.status,
    resolution: market.resolution,
    endDate: market.endDate,
    oracleInfo: {
      type: market.resolutionSource,
      description: getOracleDescription(market.resolutionSource)
    }
  });
});

// ==========================================
// LEADERBOARD
// ==========================================

/**
 * Get leaderboard of top predictors
 * GET /api/leaderboard
 */
app.get('/api/leaderboard', async (req, res) => {
  try {
    // Calculate win/loss record for each wallet
    const walletStats = new Map();
    
    // Get all bets and markets using async methods
    const allBets = await bets.values();
    const allMarkets = await markets.values();
    const marketsMap = new Map(allMarkets.map(m => [m.id, m]));

    for (const bet of allBets) {
      const market = marketsMap.get(bet.marketId);
      if (!market || market.status !== 'resolved') continue;

      const stats = walletStats.get(bet.wallet) || {
        wallet: bet.wallet,
        totalBets: 0,
        wins: 0,
        losses: 0,
        totalWagered: 0,
        totalWon: 0,
        profit: 0
      };

      stats.totalBets += 1;
      stats.totalWagered += bet.amountSOL || 0;

      if (bet.outcome === market.resolution) {
        stats.wins += 1;
        // Calculate winnings
        const winningPool = market.resolution === 'YES' ? market.yesPool : market.noPool;
        const losingPool = market.resolution === 'YES' ? market.noPool : market.yesPool;
        if (winningPool > 0) {
          const share = bet.amount / winningPool;
          const winnings = (bet.amount + (share * losingPool * 0.99)) / LAMPORTS_PER_SOL;
          stats.totalWon += winnings;
          stats.profit += (winnings - (bet.amountSOL || 0));
        }
      } else {
        stats.losses += 1;
        stats.profit -= bet.amountSOL || 0;
      }

      walletStats.set(bet.wallet, stats);
    }

    // Sort by profit
    const leaderboard = Array.from(walletStats.values())
      .map(s => ({
        ...s,
        winRate: s.totalBets > 0 ? (s.wins / s.totalBets * 100).toFixed(1) + '%' : '0%',
        profit: s.profit.toFixed(4)
      }))
      .sort((a, b) => parseFloat(b.profit) - parseFloat(a.profit))
      .slice(0, 50);

    res.json({
      leaderboard,
      totalPredictors: walletStats.size
    });
  } catch (error) {
    console.error('Error fetching leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

/**
 * Get recent activity feed
 * GET /api/activity
 */
app.get('/api/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    
    // Get recent bets
    const allBets = await bets.values();
    const allMarkets = await markets.values();
    const marketsMap = new Map(allMarkets.map(m => [m.id, m]));
    
    // Build activity list from bets
    const activities = allBets
      .filter(bet => bet.createdAt || bet.timestamp)
      .map(bet => {
        const market = marketsMap.get(bet.marketId);
        return {
          type: 'bet',
          user: bet.wallet ? `${bet.wallet.slice(0, 4)}...${bet.wallet.slice(-3)}` : 'Unknown',
          market: market?.question || 'Unknown market',
          side: bet.outcome,
          amount: bet.amountSOL || (bet.amount / LAMPORTS_PER_SOL),
          time: new Date(bet.createdAt || bet.timestamp).getTime()
        };
      })
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);
    
    res.json({ activities });
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity', activities: [] });
  }
});

// ==========================================
// ESCROW ENDPOINTS
// ==========================================

/**
 * Get escrow wallet balance
 * GET /api/escrow/balance
 */
app.get('/api/escrow/balance', async (req, res) => {
  try {
    const balance = await escrow.getEscrowBalance();
    res.json(balance);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a bet deposit transaction for user to sign
 * POST /api/escrow/deposit
 */
app.post('/api/escrow/deposit', async (req, res) => {
  try {
    const { wallet, amount } = req.body;

    if (!wallet || !amount) {
      return res.status(400).json({ error: 'wallet and amount are required' });
    }

    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const instruction = await escrow.createBetDepositInstruction(wallet, amountLamports);

    res.json({
      success: true,
      ...instruction,
      instructions: 'Sign and submit this transaction to deposit your bet'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Verify a bet deposit transaction
 * POST /api/escrow/verify
 */
app.post('/api/escrow/verify', async (req, res) => {
  try {
    const { txSignature, wallet, amount } = req.body;

    if (!txSignature || !wallet || !amount) {
      return res.status(400).json({ error: 'txSignature, wallet, and amount are required' });
    }

    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);
    const result = await escrow.verifyBetTransaction(txSignature, wallet, amountLamports);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Process payouts for a resolved market
 * POST /api/escrow/payout
 * (Admin endpoint - would need auth in production)
 */
app.post('/api/escrow/payout', async (req, res) => {
  try {
    const { marketId } = req.body;

    const market = await markets.get(marketId);
    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (market.status !== 'resolved') {
      return res.status(400).json({ error: 'Market not resolved yet' });
    }

    // Get all winning bets
    const marketBets = Array.from(bets.values()).filter(b => b.marketId === marketId);
    const winningBets = marketBets.filter(b => b.outcome === market.resolution);

    if (winningBets.length === 0) {
      return res.json({ success: true, message: 'No winning bets to pay out' });
    }

    // Calculate payouts
    const losingPool = market.resolution === 'YES' ? market.noPool : market.yesPool;
    const winningPool = market.resolution === 'YES' ? market.yesPool : market.noPool;

    const payouts = winningBets.map(bet => {
      const share = bet.amount / winningPool;
      const winnings = Math.floor(bet.amount + (share * losingPool * 0.99)); // 1% platform fee
      return {
        wallet: bet.wallet,
        amount: winnings
      };
    });

    // Process payouts
    const result = await escrow.batchProcessPayouts(payouts);

    res.json({
      success: result.success,
      marketId,
      resolution: market.resolution,
      winnersCount: winningBets.length,
      totalPaidSOL: result.totalPaidSOL,
      results: result.results
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// POLL.FUN ON-CHAIN ENDPOINTS
// ==========================================

/**
 * Initialize a user's Poll.fun account (required before placing wagers)
 * POST /api/onchain/user/init
 *
 * For the bot's own wallet: automatically creates the account server-side
 * For other wallets: returns instructions for client-side signing
 */
app.post('/api/onchain/user/init', async (req, res) => {
  try {
    const { wallet } = req.body;

    if (!wallet) {
      return res.status(400).json({ error: 'wallet is required' });
    }

    // Check if user already exists
    const existingUser = await pollFunService.getUserData(wallet);
    if (existingUser.success) {
      return res.json({
        success: true,
        exists: true,
        userAddress: existingUser.userAddress,
        message: 'User account already exists',
        data: existingUser
      });
    }

    // If this is the bot's own wallet, auto-create the account
    const botWallet = pollFunService.creatorKeypair?.publicKey?.toBase58();
    if (botWallet && wallet === botWallet) {
      console.log('[API] Auto-creating bot creator user account...');
      const result = await pollFunService.ensureCreatorUserExists();
      if (result.success) {
        return res.json({
          success: true,
          exists: true,
          created: true,
          userAddress: result.userAddress,
          message: 'Bot creator account initialized on-chain',
          txSignature: result.txSignature || null
        });
      } else {
        return res.status(500).json({
          success: false,
          error: result.error,
          message: 'Failed to initialize bot creator account'
        });
      }
    }

    // For other wallets, return information about how to initialize
    // The actual initialization requires the user to sign
    res.json({
      success: true,
      exists: false,
      wallet,
      instructions: {
        step1: 'User must have SOL for gas fees',
        step2: 'User must have USDC for placing wagers',
        step3: 'Call the Poll.fun SDK initializeUser method with user keypair',
        note: 'User account creation is required before placing wagers'
      },
      sdkMethod: 'sdk.initializeUser({ signers: [userKeypair] })',
      message: 'User account does not exist. User must initialize their account before placing wagers.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check if user has a Poll.fun account
 * GET /api/onchain/user/:wallet/exists
 */
app.get('/api/onchain/user/:wallet/exists', async (req, res) => {
  try {
    const result = await pollFunService.getUserData(req.params.wallet);

    res.json({
      exists: result.success,
      wallet: req.params.wallet,
      userAddress: result.success ? result.userAddress : null,
      message: result.success
        ? 'User account exists and is ready to place wagers'
        : 'User account does not exist. Must initialize before placing wagers.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create an on-chain market via Poll.fun
 * POST /api/onchain/markets
 */
app.post('/api/onchain/markets', createLimiter, async (req, res) => {
  try {
    const {
      question,
      description,
      category,
      endDate,
      expectedUserCount = 50,
      verificationUrl,
      verificationMethod,
      threshold,
      tags,
      creatorAgent, // NEW: track who proposed it
      proposerWallet, // NEW: proposer's wallet (for UI display, NOT for resolution)
      resolutionTiming // on_target (early) or at_close (default)
    } = req.body;

    // SECURITY: Sanitize all inputs to prevent XSS and injection attacks
    const sanitizedQuestion = sanitizeInput(question);
    const sanitizedDescription = sanitizeInput(description || '');
    const sanitizedCategory = sanitizeCategory(category);
    const sanitizedEndDate = sanitizeDate(endDate);
    const sanitizedVerificationUrl = verificationUrl ? sanitizeInput(verificationUrl) : null;
    const sanitizedVerificationMethod = verificationMethod ? sanitizeInput(verificationMethod) : null;
    const sanitizedThreshold = threshold ? sanitizeInput(String(threshold)) : null;
    const sanitizedCreatorAgent = creatorAgent ? sanitizeInput(creatorAgent) : null;
    const sanitizedProposerWallet = sanitizeWalletAddress(proposerWallet);
    const sanitizedResolutionTiming = (resolutionTiming === 'on_target' || resolutionTiming === 'at_close')
      ? resolutionTiming : 'at_close';
    const userTags = Array.isArray(tags) ? tags.map(t => sanitizeInput(String(t))).filter(Boolean) : [];
    const detectedOnchainTags = autoDetectTags(sanitizedQuestion, sanitizedCategory, detectResolutionSource(sanitizedQuestion));
    const sanitizedTags = [...new Set([...userTags, ...detectedOnchainTags])].slice(0, 10);

    if (!sanitizedQuestion || !sanitizedEndDate) {
      return res.status(400).json({ error: 'Question and endDate are required' });
    }

    // SECURITY: Require proposer wallet for frontend-created markets
    // Bot-created markets (via X or Moltbook) pass creatorAgent instead
    if (!sanitizedProposerWallet && !sanitizedCreatorAgent) {
      return res.status(400).json({ error: 'Wallet connection required. Please connect your wallet to create a market.' });
    }

    if (sanitizedQuestion.length > 256) {
      return res.status(400).json({ error: 'Question must be 256 characters or less' });
    }

    // RATE LIMIT: Max 2 market creations per account per day
    const MAX_MARKETS_PER_DAY = 2;
    const creatorIdentifier = sanitizedCreatorAgent || sanitizedProposerWallet;
    if (creatorIdentifier) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const allMarketsForCount = await markets.values();
      const allMarketsListForCount = Array.isArray(allMarketsForCount) ? allMarketsForCount : [...allMarketsForCount];
      const recentByCreator = allMarketsListForCount.filter(m => {
        const matchesAgent = m.creatorAgent && m.creatorAgent.toLowerCase() === creatorIdentifier.toLowerCase();
        const matchesWallet = m.creatorWallet && m.creatorWallet === creatorIdentifier;
        const matchesProposer = m.proposerWallet && m.proposerWallet === creatorIdentifier;
        return (matchesAgent || matchesWallet || matchesProposer) && m.createdAt > oneDayAgo;
      });
      if (recentByCreator.length >= MAX_MARKETS_PER_DAY) {
        const oldestRecent = recentByCreator.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0];
        const resetTime = new Date(new Date(oldestRecent.createdAt).getTime() + 24 * 60 * 60 * 1000);
        console.warn(`[API] RATE LIMITED: ${creatorIdentifier} has created ${recentByCreator.length} markets in 24h (max ${MAX_MARKETS_PER_DAY})`);
        return res.status(429).json({
          error: `Rate limit: You can create a maximum of ${MAX_MARKETS_PER_DAY} markets per day. You've created ${recentByCreator.length} in the last 24 hours.`,
          limit: MAX_MARKETS_PER_DAY,
          used: recentByCreator.length,
          resetsAt: resetTime.toISOString()
        });
      }
    }

    // Validate end date is in the future (at least 10 minutes)
    const endDateTime = new Date(sanitizedEndDate);
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    if (isNaN(endDateTime.getTime())) {
      return res.status(400).json({ error: 'Invalid endDate format' });
    }
    
    if (endDateTime <= now) {
      return res.status(400).json({ error: 'End date must be in the future' });
    }
    
    if (endDateTime < tenMinutesFromNow) {
      return res.status(400).json({ error: 'End date must be at least 10 minutes in the future' });
    }

    // Validate URL format if provided
    if (sanitizedVerificationUrl && !sanitizedVerificationUrl.match(/^https?:\/\//i)) {
      return res.status(400).json({ error: 'Invalid verification URL format' });
    }

    // DEDUPLICATION: Check if a market with the same question already exists locally
    // This catches duplicates even if the PollFun-level dedup is bypassed (e.g., after restart)
    const allExisting = await markets.values();
    const existingList = Array.isArray(allExisting) ? allExisting : [...allExisting];
    const normalizedNewQ = sanitizedQuestion.replace(/\s+/g, ' ').trim().toLowerCase();
    const duplicateMarket = existingList.find(m => {
      if (m.status !== 'active') return false;
      const normalizedExisting = (m.question || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return normalizedExisting === normalizedNewQ;
    });
    if (duplicateMarket) {
      console.warn(`[API] DUPLICATE BLOCKED: Market "${sanitizedQuestion.slice(0, 60)}" already exists as ${duplicateMarket.id}`);
      return res.status(409).json({
        error: 'A market with this question already exists',
        existingMarket: {
          id: duplicateMarket.id,
          betPda: duplicateMarket.betPda,
          question: duplicateMarket.question,
          endDate: duplicateMarket.endDate,
          status: duplicateMarket.status
        }
      });
    }

    // SECURITY: Bot ALWAYS creates markets with its keypair
    // User is just a "proposer" - they cannot resolve their own markets
    const result = await pollFunService.createMarket({
      question: sanitizedQuestion,
      expectedUserCount: Math.min(expectedUserCount, 50), // Max 50 users per Poll.fun
      minimumVoteCount: 1, // Not used since isCreatorResolver=true
      proposerAgent: sanitizedCreatorAgent // Track who proposed it (for royalties)
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Also store in local database for tracking
    const marketId = uuidv4();
    const createdAt = new Date().toISOString();

    // Auto-detect resolution source from question text
    // Every market resolves via a real data source (coingecko, x-api, moltbook, etc.)
    // pollfun is NOT a resolution source - it's the on-chain SDK for the market itself
    const detectedResolutionSource = detectResolutionSource(sanitizedQuestion);

    // Extract target handle and token from question for resolution
    const handleMatch = sanitizedQuestion.match(/@(\w+)\s+(?:reach|hit|get|followers)/i) ||
                        sanitizedQuestion.match(/will\s+@(\w+)/i);
    const detectedTargetHandle = handleMatch ? handleMatch[1] : null;
    const tokenMatch = sanitizedQuestion.match(/\$([A-Z]+)/);
    const detectedTargetToken = tokenMatch ? tokenMatch[1] : null;

    // Auto-detect resolution timing (on_target vs at_close)
    const detectedResolutionTiming = sanitizedResolutionTiming !== 'at_close'
      ? sanitizedResolutionTiming
      : detectResolutionTiming(sanitizedQuestion, detectedResolutionSource, detectedTargetHandle);

    const market = {
      id: marketId,
      betPda: result.betPda, // On-chain PDA
      question: sanitizedQuestion,
      description: sanitizedDescription,
      category: sanitizedCategory,
      outcomes: ['YES', 'NO'],
      resolutionSource: detectedResolutionSource, // Auto-detected from question text
      endDate: sanitizedEndDate,
      createdAt: createdAt,
      creatorWallet: result.creator, // Bot's wallet (on-chain creator)
      proposerWallet: sanitizedProposerWallet, // Who proposed it (UI only)
      creatorAgent: sanitizedCreatorAgent, // Agent who proposed it (for royalties)
      status: 'active',
      resolution: null,
      resolvedAt: null,
      verificationUrl: sanitizedVerificationUrl,
      verificationMethod: sanitizedVerificationMethod,
      threshold: sanitizedThreshold,
      tags: sanitizedTags,
      // Pool tracking (synced from on-chain)
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5,
      // On-chain metadata
      onChain: true,
      txSignature: result.txSignature,
      currency: 'USDC',
      resolutionTiming: detectedResolutionTiming,
      // SECURITY NOTE: Bot is on-chain creator, can resolve
      securityNote: 'Bot-created market. Only bot can resolve (isCreatorResolver).'
    };

    markets.set(marketId, market);

    // Track market creation for royalties (proposer gets credit, not bot)
    if (sanitizedCreatorAgent) {
      royalties.recordMarketCreation(sanitizedCreatorAgent, marketId);
      await agentFunding.awardMarketCreationPoints(sanitizedCreatorAgent, marketId);
    }

    // Notify bot to track this market for auto-resolution
    // Without this, frontend-created markets would never enter the bot's resolution pipeline
    if (process.env.BOT_WEBHOOK_URL) {
      try {
        await axios.post(`${process.env.BOT_WEBHOOK_URL}/webhook/market-created`, {
          marketId,
          question: sanitizedQuestion,
          endDate: sanitizedEndDate,
          resolutionSource: detectedResolutionSource,
          threshold: sanitizedThreshold,
          targetHandle: detectedTargetHandle,
          targetToken: detectedTargetToken,
          resolutionTiming: detectedResolutionTiming,
          creatorAgent: sanitizedCreatorAgent,
          proposerWallet: sanitizedProposerWallet,
          verificationUrl: sanitizedVerificationUrl,
          platform: 'frontend'
        }, {
          headers: { 'x-api-key': process.env.AGENTBETS_API_KEY || '' },
          timeout: 5000
        });
        console.log(`[Bot Webhook] Notified bot of new market ${marketId}`);
      } catch (webhookErr) {
        // Non-blocking: market is still created even if bot notification fails
        // The bot's startup sync will catch it on next restart
        console.warn(`[Bot Webhook] Failed to notify bot of market ${marketId}: ${webhookErr.message}`);
      }
    }

    res.status(201).json({
      success: true,
      market,
      onChainData: {
        betPda: result.betPda,
        txSignature: result.txSignature,
        network: pollFunService.network,
        creator: result.creator, // Bot's address
        proposer: sanitizedCreatorAgent || sanitizedProposerWallet || 'anonymous'
      },
      royaltyInfo: sanitizedCreatorAgent ? {
        proposer: sanitizedCreatorAgent,
        message: `${sanitizedCreatorAgent} will earn 0.3% royalties from this market`,
        note: 'Bot is the on-chain creator for security, but royalties go to proposer'
      } : null,
      message: `On-chain market created! Bet with USDC on: "${sanitizedQuestion}"`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a wager transaction for user to sign
 * POST /api/onchain/wager
 * 
 * Supports gasless mode: set { gasless: true } in body to get a pre-signed
 * transaction where the API pays SOL gas and user pays a small USDC fee.
 */
app.post('/api/onchain/wager', async (req, res) => {
  try {
    const { marketId, betPda, outcome, amount, wallet, gasless } = req.body;

    if ((!marketId && !betPda) || !outcome || !amount || !wallet) {
      return res.status(400).json({
        error: 'marketId or betPda, outcome, amount, and wallet are required'
      });
    }

    // Get betPda from market if not provided directly
    let pdaAddress = betPda;
    let market = null;

    if (marketId) {
      market = await markets.get(marketId);
      if (!market) {
        return res.status(404).json({ error: 'Market not found' });
      }
      if (!market.betPda) {
        return res.status(400).json({ error: 'Market is not on-chain' });
      }
      pdaAddress = market.betPda;
    }

    if (!['YES', 'NO'].includes(outcome)) {
      return res.status(400).json({ error: 'Outcome must be YES or NO' });
    }

    // Enforce $1 minimum bet (50-wager cap per market makes sub-dollar bets uneconomical)
    const betAmountParsed = parseFloat(amount);
    if (isNaN(betAmountParsed) || betAmountParsed < 1) {
      return res.status(400).json({ error: 'Minimum bet amount is 1 USDC' });
    }

    // Check 50-wager limit (Poll.fun on-chain max)
    try {
      const onChainData = await pollFunService.getMarketData(pdaAddress);
      if (onChainData.success && onChainData.currentUserCount >= 50) {
        return res.status(400).json({
          error: 'Market has reached the maximum of 50 wagers (on-chain limit). No more bets can be placed.',
          currentWagers: onChainData.currentUserCount,
          maxWagers: 50
        });
      }
    } catch (limitErr) {
      console.warn('[API] Could not check wager limit:', limitErr.message);
      // Continue anyway - the on-chain program will reject if actually full
    }

    // Determine if gasless mode is requested and available
    const useGasless = gasless && gaslessService.enabled && gaslessService.feePayerKeypair;
    const userPubkey = new PublicKey(wallet);

    // In gasless mode, API wallet pays SOL rent (feePayerOverride),
    // but the USER is always the owner/identity (payerOverride).
    const feePayerOverride = useGasless
      ? gaslessService.feePayerKeypair.publicKey
      : undefined;

    // AUTO: Check if user has a Poll.fun account, include init instruction if not
    let userInitIx = null;
    let userInitInstructionSerialized = null;

    try {
      const userData = await pollFunService.getUserData(wallet);
      if (!userData.success) {
        console.log(`[API] User ${wallet.slice(0, 8)}... needs Poll.fun account, including init instruction`);
        userInitIx = await pollFunService.sdk.instructions.initializeUserIx({
          payerOverride: userPubkey,          // owner = the real user
          feePayerOverride: feePayerOverride  // SOL payer = API wallet in gasless mode
        });
        userInitInstructionSerialized = {
          programId: userInitIx.programId?.toBase58(),
          keys: userInitIx.keys?.map(k => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable
          })),
          data: userInitIx.data?.toString('base64')
        };
      }
    } catch (err) {
      console.log(`[API] User account check failed, including init instruction: ${err.message}`);
      try {
        userInitIx = await pollFunService.sdk.instructions.initializeUserIx({
          payerOverride: userPubkey,          // owner = the real user
          feePayerOverride: feePayerOverride  // SOL payer = API wallet in gasless mode
        });
        userInitInstructionSerialized = {
          programId: userInitIx.programId?.toBase58(),
          keys: userInitIx.keys?.map(k => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable
          })),
          data: userInitIx.data?.toString('base64')
        };
      } catch (initErr) {
        console.warn(`[API] Could not build user init instruction: ${initErr.message}`);
      }
    }

    // Calculate platform fee (1%: 0.3% creator + 0.7% platform)
    const wagerFee = calculateWagerFee(amount);
    console.log(`[API] Wager fee: ${wagerFee.feeUsdc} USDC (${wagerFee.feeAmountMicro} micro), net wager: ${wagerFee.netWagerUsdc} USDC`);

    // Build wager instruction with REDUCED amount (fee already deducted)
    const result = await pollFunService.buildWagerInstruction({
      betPda: pdaAddress,
      side: outcome,
      amount: wagerFee.netWagerUsdc,
      userPubkey: wallet,
      feePayerPubkey: useGasless ? gaslessService.feePayerKeypair.publicKey.toBase58() : undefined
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Build platform fee instruction (user -> platform fee wallet)
    const platformFeeResult = await buildPlatformFeeInstruction(userPubkey, wagerFee.feeAmountMicro);

    if (useGasless) {
      // GASLESS MODE: Build full transaction, wrap with USDC fee, pre-sign
      console.log(`[API] Building gasless wager for ${wallet.slice(0, 8)}... (fee: ${wagerFee.feeUsdc} USDC, net: ${wagerFee.netWagerUsdc} USDC)`);

      const transaction = new Transaction();
      if (userInitIx) {
        transaction.add(userInitIx);
      }
      transaction.add(platformFeeResult.instruction); // Platform fee first
      transaction.add(result.instruction);             // Then the wager

      const wrapped = await gaslessService.wrapWithGasless(transaction, userPubkey);

      res.json({
        success: true,
        gasless: true,
        transaction: wrapped.transaction,
        blockhash: wrapped.blockhash,
        lastValidBlockHeight: wrapped.lastValidBlockHeight,
        feePayer: wrapped.feePayer,
        gasFee: wrapped.feeUsdc,
        platformFee: {
          feeUsdc: wagerFee.feeUsdc,
          creatorShareUsdc: wagerFee.creatorShareMicro / 1e6,
          platformShareUsdc: wagerFee.platformShareMicro / 1e6,
          feeWallet: platformFeeResult.feeWallet
        },
        wagerDetails: {
          betPda: pdaAddress,
          marketId: marketId || null,
          side: outcome,
          amount,
          netWagerAmount: wagerFee.netWagerUsdc,
          currency: 'USDC'
        },
        message: `Bet ${amount} USDC on ${outcome} (gasless — ${wrapped.feeUsdc} USDC gas fee + ${wagerFee.feeUsdc} USDC platform fee)`,
        instructions: 'Transaction is pre-signed by the relay. Sign with your wallet and broadcast directly, or POST to /api/relay.'
      });
    } else {
      // TRADITIONAL MODE: Return individual instructions (platform fee + wager)
      const serializeIx = (ix) => ix ? {
        programId: ix.programId?.toBase58(),
        keys: ix.keys?.map(k => ({
          pubkey: k.pubkey.toBase58(),
          isSigner: k.isSigner,
          isWritable: k.isWritable
        })),
        data: ix.data?.toString('base64')
      } : null;

      res.json({
        success: true,
        gasless: false,
        userInitInstruction: userInitInstructionSerialized || null,
        platformFeeInstruction: serializeIx(platformFeeResult.instruction),
        instruction: serializeIx(result.instruction),
        platformFee: {
          feeUsdc: wagerFee.feeUsdc,
          creatorShareUsdc: wagerFee.creatorShareMicro / 1e6,
          platformShareUsdc: wagerFee.platformShareMicro / 1e6,
          feeWallet: platformFeeResult.feeWallet
        },
        wagerDetails: {
          betPda: pdaAddress,
          marketId: marketId || null,
          side: outcome,
          amount,
          netWagerAmount: wagerFee.netWagerUsdc,
          currency: 'USDC'
        },
        message: `Bet ${amount} USDC on ${outcome} (includes ${wagerFee.feeUsdc} USDC platform fee)`,
        instructions: 'Build a transaction with: 1) userInitInstruction (if needed), 2) platformFeeInstruction, 3) wager instruction. Sign with your wallet.'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GASLESS RELAY ENDPOINTS (Octane-Style USDC Fee Payer)
// ═══════════════════════════════════════════════════════════

/**
 * Get gasless relay configuration
 * GET /api/gasless/config
 * 
 * Returns fee payer pubkey, USDC fee amount, and USDC mint for clients
 * to build gasless transactions locally.
 */
app.get('/api/gasless/config', (req, res) => {
  try {
    const config = gaslessService.getConfig();
    res.json({
      success: true,
      ...config,
      note: config.enabled
        ? `Gasless relay active. Include a ${config.feeUsdc} USDC fee transfer as the first instruction to have the API pay SOL gas fees.`
        : 'Gasless relay is currently disabled. Transactions require SOL for gas fees.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Relay a user-signed gasless transaction
 * POST /api/relay
 * 
 * Accepts a user-signed transaction where the API wallet is feePayer.
 * Validates security checks, co-signs as feePayer, and broadcasts.
 * 
 * Body: { transaction: "<base64 serialized transaction>" }
 * Returns: { success, signature, explorer }
 */
app.post('/api/relay', async (req, res) => {
  try {
    const { transaction } = req.body;

    if (!transaction) {
      return res.status(400).json({ error: 'Missing transaction in request body' });
    }

    if (!gaslessService.enabled) {
      return res.status(503).json({ error: 'Gasless relay is not enabled' });
    }

    const result = await gaslessService.validateAndRelay(transaction);
    res.json(result);
  } catch (error) {
    console.error('[Relay] Error:', error.message);

    // Provide specific error codes for common issues
    if (error.message.includes('feePayer')) {
      return res.status(400).json({ error: error.message, code: 'INVALID_FEE_PAYER' });
    }
    if (error.message.includes('fee')) {
      return res.status(400).json({ error: error.message, code: 'INSUFFICIENT_FEE' });
    }
    if (error.message.includes('Security')) {
      return res.status(403).json({ error: error.message, code: 'SECURITY_VIOLATION' });
    }
    if (error.message.includes('Rate limit')) {
      return res.status(429).json({ error: error.message, code: 'RATE_LIMITED' });
    }
    if (error.message.includes('Duplicate')) {
      return res.status(409).json({ error: error.message, code: 'DUPLICATE_TX' });
    }
    if (error.message.includes('Simulation')) {
      return res.status(400).json({ error: error.message, code: 'SIMULATION_FAILED' });
    }

    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ON-CHAIN DATA ENDPOINTS
// ═══════════════════════════════════════════════════════════

/**
 * Sync a market's local data from on-chain PDA
 * POST /api/onchain/sync/:marketId
 */
app.post('/api/onchain/sync/:marketId', async (req, res) => {
  try {
    const result = await syncMarketFromChain(req.params.marketId);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ success: true, changed: result.changed, market: result.market });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Recover an orphaned on-chain market that exists on Solana but not in local storage.
 * This happens when a market creation transaction succeeds but confirmation times out.
 * READ-ONLY Solana operation — no transactions, no cost.
 *
 * POST /api/onchain/recover
 * Body: { txSignature, endDate, category, description, creatorAgent, threshold, resolutionSource }
 */
app.post('/api/onchain/recover', requireApiKey, async (req, res) => {
  try {
    const {
      txSignature,
      endDate,
      category,
      description,
      creatorAgent,
      threshold,
      resolutionSource,
      verificationUrl,
      verificationMethod,
      tags
    } = req.body;

    if (!txSignature) {
      return res.status(400).json({ error: 'txSignature is required' });
    }

    // Check if this transaction is already registered
    const allMarkets = await markets.values();
    const existing = (Array.isArray(allMarkets) ? allMarkets : [...allMarkets])
      .find(m => m.txSignature === txSignature);
    if (existing) {
      return res.status(409).json({
        error: 'Market from this transaction is already registered',
        market: existing
      });
    }

    // Read the transaction from Solana (READ-ONLY, no cost)
    console.log(`[Recovery] Checking transaction: ${txSignature}`);
    const creatorAddress = pollFunService.creatorKeypair?.publicKey?.toBase58();
    const recovered = await pollFunService.recoverMarketFromTx(txSignature, creatorAddress, creatorAgent);

    if (!recovered.success) {
      return res.status(404).json({
        error: 'Could not recover market from transaction',
        detail: recovered.error
      });
    }

    // Register the market locally
    const marketId = uuidv4();
    const createdAt = new Date().toISOString();
    const sanitizedQuestion = sanitizeInput(recovered.question || '');
    const sanitizedEndDate = endDate ? sanitizeDate(endDate) : null;

    const market = {
      id: marketId,
      betPda: recovered.betPda,
      question: sanitizedQuestion,
      description: sanitizeInput(description || `Recovered from tx ${txSignature.slice(0, 16)}...`),
      category: sanitizeCategory(category || 'general'),
      outcomes: ['YES', 'NO'],
      resolutionSource: resolutionSource || detectResolutionSource(sanitizedQuestion) || 'manual',
      endDate: sanitizedEndDate,
      createdAt,
      creatorWallet: recovered.creator,
      proposerWallet: null,
      creatorAgent: creatorAgent ? sanitizeInput(creatorAgent) : null,
      status: 'active',
      resolution: null,
      resolvedAt: null,
      verificationUrl: verificationUrl ? sanitizeInput(verificationUrl) : null,
      verificationMethod: verificationMethod ? sanitizeInput(verificationMethod) : null,
      threshold: threshold ? sanitizeInput(String(threshold)) : null,
      tags: Array.isArray(tags) ? tags.map(t => sanitizeInput(String(t))).slice(0, 10) : ['recovered'],
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5,
      onChain: true,
      txSignature,
      currency: 'USDC',
      recovered: true,
      recoveredAt: createdAt,
      securityNote: 'Recovered market. Bot is on-chain creator (isCreatorResolver).'
    };

    await markets.set(marketId, market);

    // Track royalties if creator agent specified
    if (creatorAgent) {
      royalties.recordMarketCreation(sanitizeInput(creatorAgent), marketId);
      try {
        await agentFunding.awardMarketCreationPoints(sanitizeInput(creatorAgent), marketId);
      } catch {
        // agentFunding may not be loaded yet; non-critical
      }
    }

    console.log(`[Recovery] Market registered: ${marketId} (PDA: ${recovered.betPda})`);

    res.status(201).json({
      success: true,
      recovered: true,
      market,
      onChainData: {
        betPda: recovered.betPda,
        txSignature,
        network: pollFunService.network,
        creator: recovered.creator
      },
      message: `Orphaned market recovered and registered. ID: ${marketId}`
    });
  } catch (error) {
    console.error('[Recovery] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get on-chain market data
 * GET /api/onchain/markets/:betPda
 */
app.get('/api/onchain/markets/:betPda', async (req, res) => {
  try {
    const result = await pollFunService.getMarketData(req.params.betPda);

    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }

    // Result already includes yesOdds/noOdds from getMarketData
    res.json({
      ...result,
      currency: 'USDC',
      network: pollFunService.network
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Resolve an on-chain market (admin/oracle only)
 * POST /api/onchain/resolve
 */
app.post('/api/onchain/resolve', async (req, res) => {
  try {
    const { marketId, betPda, winningOption } = req.body;

    if ((!marketId && !betPda) || !winningOption) {
      return res.status(400).json({
        error: 'marketId or betPda and winningOption are required'
      });
    }

    if (!['YES', 'NO'].includes(winningOption)) {
      return res.status(400).json({ error: 'winningOption must be YES or NO' });
    }

    // Get betPda from market if not provided
    let pdaAddress = betPda;
    let market = null;

    if (marketId) {
      market = await markets.get(marketId);
      if (!market) {
        return res.status(404).json({ error: 'Market not found' });
      }
      if (!market.betPda) {
        return res.status(400).json({ error: 'Market is not on-chain' });
      }
      pdaAddress = market.betPda;
    }

    // Resolve on-chain (creator resolution since isCreatorResolver=true)
    const result = await pollFunService.resolveMarket({
      betPda: pdaAddress,
      winningOutcome: winningOption // 'YES' or 'NO'
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Update local market record
    if (market) {
      market.status = 'resolved';
      market.resolution = winningOption;
      market.resolvedAt = new Date().toISOString();
      markets.set(marketId, market);
    }

    res.json({
      success: true,
      betPda: pdaAddress,
      marketId: marketId || null,
      winningOption,
      txSignature: result.txSignature,
      message: `Market resolved on-chain: ${winningOption} wins!`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Settle an on-chain market and distribute winnings (batch-based)
 * POST /api/onchain/settle
 */
app.post('/api/onchain/settle', async (req, res) => {
  try {
    const { marketId, betPda, batchNumber = 0, usersPerBatch = 10 } = req.body;

    if (!marketId && !betPda) {
      return res.status(400).json({
        error: 'marketId or betPda is required'
      });
    }

    // Get betPda from market if not provided
    let pdaAddress = betPda;

    if (marketId) {
      const market = await markets.get(marketId);
      if (!market) {
        return res.status(404).json({ error: 'Market not found' });
      }
      if (!market.betPda) {
        return res.status(400).json({ error: 'Market is not on-chain' });
      }
      pdaAddress = market.betPda;
    }

    // Settle batch on-chain
    const result = await pollFunService.settleBatch({
      betPda: pdaAddress,
      batchNumber,
      usersPerBatch
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
      betPda: pdaAddress,
      marketId: marketId || null,
      batchNumber,
      txSignature: result.txSignature,
      message: `Settled batch ${batchNumber}!`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Settle ALL batches for an on-chain market (processes until complete)
 * POST /api/onchain/settle-all
 *
 * This endpoint loops through all batches until the market is fully settled.
 * Per Poll.fun docs: process in batches of 10-20 users
 */
app.post('/api/onchain/settle-all', async (req, res) => {
  try {
    const { marketId, betPda, usersPerBatch = 10 } = req.body;

    if (!marketId && !betPda) {
      return res.status(400).json({
        error: 'marketId or betPda is required'
      });
    }

    // Get betPda from market if not provided
    let pdaAddress = betPda;
    let market = null;

    if (marketId) {
      market = await markets.get(marketId);
      if (!market) {
        return res.status(404).json({ error: 'Market not found' });
      }
      if (!market.betPda) {
        return res.status(400).json({ error: 'Market is not on-chain' });
      }
      pdaAddress = market.betPda;
    }

    // Get market data to know how many users
    const marketData = await pollFunService.getMarketData(pdaAddress);
    if (!marketData.success) {
      return res.status(400).json({ error: marketData.error });
    }

    // Check if market is resolved
    if (marketData.status !== 'Resolved') {
      return res.status(400).json({
        error: `Market must be resolved before settlement. Current status: ${marketData.status}`
      });
    }

    const totalUsers = marketData.currentUserCount || 0;
    const totalBatches = Math.ceil(totalUsers / usersPerBatch);

    if (totalUsers === 0) {
      return res.json({
        success: true,
        message: 'No users to settle',
        totalUsers: 0,
        batchesProcessed: 0
      });
    }

    // Process all batches
    const settlements = [];
    let successCount = 0;
    let errorCount = 0;

    for (let batchNumber = 0; batchNumber < totalBatches; batchNumber++) {
      try {
        const result = await pollFunService.settleBatch({
          betPda: pdaAddress,
          batchNumber,
          usersPerBatch
        });

        if (result.success) {
          successCount++;
          settlements.push({
            batchNumber,
            success: true,
            txSignature: result.txSignature
          });
        } else {
          // Some errors are expected (e.g., already settled)
          if (result.error?.includes('already settled') || result.error?.includes('no users')) {
            settlements.push({
              batchNumber,
              success: true,
              skipped: true,
              message: result.error
            });
          } else {
            errorCount++;
            settlements.push({
              batchNumber,
              success: false,
              error: result.error
            });
          }
        }
      } catch (err) {
        errorCount++;
        settlements.push({
          batchNumber,
          success: false,
          error: err.message
        });
      }
    }

    // Update market status in local db
    if (market) {
      market.settlementStatus = 'settled';
      market.settledAt = new Date().toISOString();
      markets.set(marketId, market);
    }

    // Attempt to close bet to reclaim rent (requires Poll.fun protocol authority)
    let closeResult = null;
    if (errorCount === 0) {
      closeResult = await pollFunService.closeBet({ betPda: pdaAddress });
      if (closeResult.success) {
        console.log(`[Settle] Bet closed, reclaimed ${closeResult.reclaimedSOL?.toFixed(6)} SOL`);
        if (market) {
          market.settlementStatus = 'closed';
          markets.set(marketId, market);
        }
      } else if (closeResult.protocolLimited) {
        console.log(`[Settle] Rent reclaim not available (Poll.fun protocol authority required)`);
      }
    }

    res.json({
      success: errorCount === 0,
      betPda: pdaAddress,
      marketId: marketId || null,
      totalUsers,
      totalBatches,
      batchesProcessed: settlements.length,
      successfulBatches: successCount,
      failedBatches: errorCount,
      settlements,
      rentReclaimed: closeResult?.success ? {
        reclaimedSOL: closeResult.reclaimedSOL,
        txSignature: closeResult.txSignature
      } : null,
      message: errorCount === 0
        ? `Successfully settled all ${totalBatches} batches for ${totalUsers} users! Rent reclaimed: ${closeResult?.reclaimedSOL?.toFixed(6) || 'pending'} SOL`
        : `Settled ${successCount}/${totalBatches} batches with ${errorCount} errors`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Close a settled bet to reclaim rent SOL
 * POST /api/onchain/close
 * 
 * Call after settle-all completes. Returns ~0.039 SOL to bot wallet.
 */
app.post('/api/onchain/close', async (req, res) => {
  try {
    const { betPda, marketId } = req.body;

    if (!betPda) {
      return res.status(400).json({ error: 'betPda is required' });
    }

    const result = await pollFunService.closeBet({ betPda });

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    // Update local market status if we have the marketId
    if (marketId) {
      const market = await markets.get(marketId);
      if (market) {
        market.settlementStatus = 'closed';
        await markets.set(marketId, market);
      }
    }

    res.json({
      success: true,
      betPda,
      reclaimedSOL: result.reclaimedSOL,
      txSignature: result.txSignature,
      message: `Bet closed. Reclaimed ${result.reclaimedSOL?.toFixed(6)} SOL back to bot wallet.`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get settlement status for a market
 * GET /api/onchain/settle-status/:betPda
 */
app.get('/api/onchain/settle-status/:betPda', async (req, res) => {
  try {
    const marketData = await pollFunService.getMarketData(req.params.betPda);

    if (!marketData.success) {
      return res.status(404).json({ error: marketData.error });
    }

    // Check status of all wagers to determine settlement status
    const wagers = marketData.wagers || [];
    const totalUsers = wagers.length;

    // Get resolution status
    const isResolved = marketData.status === 'Resolved';
    const winningOutcome = marketData.resolvedOutcome;

    res.json({
      success: true,
      betPda: req.params.betPda,
      status: marketData.status,
      isResolved,
      winningOutcome,
      totalUsers,
      totalPool: marketData.totalPool,
      yesPool: marketData.yesPool,
      noPool: marketData.noPool,
      currency: 'USDC',
      message: isResolved
        ? `Market resolved: ${winningOutcome} wins. ${totalUsers} users in pool.`
        : `Market not yet resolved. Current status: ${marketData.status}`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Calculate potential payout for a wager
 * POST /api/onchain/payout-preview
 */
app.post('/api/onchain/payout-preview', async (req, res) => {
  try {
    const { betPda, option, amount } = req.body;

    if (!betPda || !option || !amount) {
      return res.status(400).json({
        error: 'betPda, option, and amount are required'
      });
    }

    // Get market data
    const marketData = await pollFunService.getMarketData(betPda);
    if (!marketData.success) {
      return res.status(404).json({ error: marketData.error });
    }

    // Calculate potential payout
    const payout = pollFunService.calculatePotentialPayout(marketData, option, amount);

    res.json({
      success: true,
      ...payout,
      currency: 'USDC',
      marketStatus: marketData.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user's Poll.fun account data
 * GET /api/onchain/user/:wallet
 */
app.get('/api/onchain/user/:wallet', async (req, res) => {
  try {
    const result = await pollFunService.getUserData(req.params.wallet);

    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }

    res.json({
      ...result,
      currency: 'USDC'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// CREATOR EARNINGS (Per-Market Fees)
// ==========================================

/**
 * Register wallet for royalty withdrawals
 * POST /api/royalties/register
 */
app.post('/api/royalties/register', (req, res) => {
  const { agentHandle, wallet } = req.body;

  if (!agentHandle || !wallet) {
    return res.status(400).json({ error: 'agentHandle and wallet are required' });
  }

  try {
    // Validate wallet is a valid Solana address
    new PublicKey(wallet);
  } catch {
    return res.status(400).json({ error: 'Invalid Solana wallet address' });
  }

  const agent = royalties.registerAgentWallet(agentHandle, wallet);

  res.json({
    success: true,
    message: `Registered @${agentHandle} with wallet ${wallet}`,
    data: royalties.getAgentRoyalties(agentHandle)
  });
});

/**
 * Withdraw pending royalties
 * POST /api/royalties/withdraw
 */
app.post('/api/royalties/withdraw', async (req, res) => {
  const { agentHandle } = req.body;

  if (!agentHandle) {
    return res.status(400).json({ error: 'agentHandle is required' });
  }

  // Check balance first
  const balanceData = royalties.getAgentRoyalties(agentHandle);

  if (!balanceData.found) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  if (!balanceData.wallet) {
    return res.status(400).json({
      error: 'No wallet registered. Register your wallet first with POST /api/royalties/register'
    });
  }

  if (!balanceData.canWithdraw) {
    return res.status(400).json({
      error: `Minimum withdrawal is ${balanceData.minWithdrawalSOL} SOL. You have ${balanceData.pendingSOL} SOL pending.`
    });
  }

  // Process withdrawal (demo mode - no real transaction without escrow keypair)
  const result = await royalties.processWithdrawal(agentHandle, connection, null);

  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    success: true,
    ...result,
    newBalance: royalties.getAgentRoyalties(agentHandle)
  });
});

/**
 * Get royalty leaderboard (top earning creators)
 * GET /api/royalties/leaderboard
 */
app.get('/api/royalties-leaderboard', (req, res) => {
  res.json(royalties.getRoyaltyLeaderboard());
});

/**
 * Estimate royalties for a market with expected volume
 * GET /api/royalties/estimate/:volume
 */
app.get('/api/royalties/estimate/:volume', (req, res) => {
  const volume = parseFloat(req.params.volume) || 0;
  res.json(royalties.estimateRoyalties(volume));
});

/**
 * Get platform royalty stats
 * GET /api/royalties/platform-stats
 */
app.get('/api/royalties/platform-stats', (req, res) => {
  res.json(royalties.getPlatformStats());
});

/**
 * Get agent's earnings balance
 * GET /api/royalties/:agentHandle
 * NOTE: This route must be AFTER specific routes like /estimate/:volume and /platform-stats
 */
app.get('/api/royalties/:agentHandle', (req, res) => {
  const data = royalties.getAgentRoyalties(req.params.agentHandle);
  res.json(data);
});

// ==========================================
// SOLANA ACTIONS / BLINKS ENDPOINTS
// ==========================================

/**
 * Get Blink URL for a market
 * GET /api/blink/:marketId
 */
app.get('/api/blink/:marketId', async (req, res) => {
  const market = await markets.get(req.params.marketId);

  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }

  const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
  const blinkUrl = generateBlinkUrl(market.id, baseUrl);
  const actionUrl = `${baseUrl}/api/actions/bet/${market.id}`;

  res.json({
    marketId: market.id,
    question: market.question,
    blinkUrl,
    actionUrl,
    instructions: 'Share the blinkUrl on X/Twitter. Users with Blink-compatible wallets can bet directly, and social crawlers see rich OG previews!'
  });
});

/**
 * Get Blink URL for markets browser
 * GET /api/blink
 */
app.get('/api/blink', (req, res) => {
  const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
  const blinkUrl = generateMarketsBlinkUrl(baseUrl);
  const actionUrl = `${baseUrl}/api/actions/markets`;

  res.json({
    blinkUrl,
    actionUrl,
    instructions: 'Share this Blink URL on X/Twitter to let users browse all active markets!'
  });
});

// ==========================================
// PROOF-OF-AGENT VERIFICATION
// ==========================================

/**
 * Verify if a handle belongs to an AI agent
 * GET /api/verify/:handle
 */
app.get('/api/verify/:handle', async (req, res) => {
  try {
    const { handle } = req.params;
    const { bio, checkMoltbook } = req.query;

    const result = await agentVerification.verifyAgent(handle, {
      bio: bio || null,
      checkMoltbook: checkMoltbook !== 'false'
    });

    res.json({
      handle: handle.replace('@', ''),
      verified: result.isVerified,
      confidence: result.confidence,
      tier: result.confidence >= 90 ? 'gold' :
            result.confidence >= 70 ? 'silver' :
            result.confidence >= 50 ? 'bronze' : 'unverified',
      methods: result.methods,
      timestamp: result.timestamp
    });
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

/**
 * Register an agent with proof
 * POST /api/verify/register
 */
app.post('/api/verify/register', async (req, res) => {
  try {
    const { handle, bio, walletAddress, walletSignature, signatureMessage } = req.body;

    if (!handle) {
      return res.status(400).json({ error: 'Handle is required' });
    }

    const result = await agentVerification.registerAgent(handle, {
      bio,
      walletAddress,
      walletSignature,
      signatureMessage,
      checkMoltbook: true
    });

    res.json(result);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * Verify a Moltbook identity token
 * POST /api/verify/moltbook
 * Allows agents to authenticate via Moltbook identity tokens
 * Requires MOLTBOOK_APP_KEY env var (placeholder until key is received)
 */
app.post('/api/verify/moltbook', async (req, res) => {
  try {
    const { identityToken } = req.body;

    if (!identityToken) {
      return res.status(400).json({ error: 'identityToken is required' });
    }

    const result = await agentVerification.verifyMoltbookIdentity(identityToken);

    if (result.verified) {
      // Auto-whitelist verified Moltbook agents
      if (result.agentHandle) {
        agentVerification.addToWhitelist(result.agentHandle);
      }

      res.json({
        verified: true,
        agent: {
          id: result.agentId,
          handle: result.agentHandle,
          platform: 'moltbook'
        },
        message: 'Agent identity verified via Moltbook'
      });
    } else {
      res.status(result.error?.includes('not configured') ? 503 : 401).json({
        verified: false,
        error: result.error,
        hint: result.hint || 'Ensure identity token is valid and not expired'
      });
    }
  } catch (err) {
    console.error('Moltbook verification error:', err);
    res.status(500).json({ error: 'Moltbook verification failed' });
  }
});

/**
 * Get whitelist of verified agents
 * GET /api/verify/whitelist
 */
app.get('/api/verify/whitelist', (req, res) => {
  res.json({
    agents: agentVerification.getWhitelist(),
    count: agentVerification.getWhitelist().length
  });
});

/**
 * Agent Info - Machine-readable platform metadata for AI agents
 * GET /api/agent-info
 */
app.get('/api/agent-info', (req, res) => {
  res.json({
    name: 'AgentBets',
    description: 'Prediction Markets for AI Agents on Solana',
    version: '1.0.0',
    skill_url: '/skill.md',
    docs_url: '/docs/agent-api',
    twitter_bot: '@AgentBetsBot',
    auth: {
      type: 'x402',
      description: 'USDC payments over HTTP for betting actions',
      read_requires_auth: false,
      write_requires_auth: true
    },
    endpoints: {
      list_markets: { method: 'GET', path: '/api/markets', auth: false },
      get_market: { method: 'GET', path: '/api/markets/:id', auth: false },
      place_bet: { method: 'POST', path: '/api/agent/bet/:marketId', auth: 'x402' },
      create_and_bet: { method: 'POST', path: '/api/agent/create-and-bet', auth: 'x402' },
      register_wallet: { method: 'POST', path: '/api/agent/wallet', auth: false },
      verify_agent: { method: 'POST', path: '/api/verify/register', auth: false },
      check_royalties: { method: 'GET', path: '/api/royalties/:handle', auth: false }
    },
    supported_tokens: ['SOL', 'USDC'],
    networks: {
      payments: process.env.SOLANA_NETWORK === 'devnet' ? 'Solana Devnet (USDC)' : 'Solana Mainnet (USDC)',
      markets: 'Solana'
    }
  });
});

/**
 * Check if handle is whitelisted
 * GET /api/verify/whitelist/:handle
 */
app.get('/api/verify/whitelist/:handle', (req, res) => {
  const { handle } = req.params;
  const isWhitelisted = agentVerification.checkWhitelist(handle);

  res.json({
    handle: handle.replace('@', ''),
    whitelisted: isWhitelisted
  });
});

/**
 * Generate challenge for agent verification
 * GET /api/verify/challenge/:handle
 */
app.get('/api/verify/challenge/:handle', (req, res) => {
  const { handle } = req.params;
  const timestamp = Date.now();
  const random = Math.random().toString(16).slice(2, 10);

  const challenge = `AgentBets verification: ${handle.replace('@', '')}-${timestamp}-${random}`;

  res.json({
    handle: handle.replace('@', ''),
    challenge,
    instructions: 'Tweet this exact message to verify your agent status. Then call POST /api/verify/challenge with the tweet URL.',
    expiresIn: '1 hour'
  });
});

// ==========================================
// AGENT PARTICIPATION & POINTS ENDPOINTS
// ==========================================

// Import agent participation/points module
const agentFunding = require('./agentFunding');

/**
 * Get participation options for an agent
 * GET /api/participation/:agentHandle
 */
app.get('/api/participation/:agentHandle', async (req, res) => {
  try {
    const { agentHandle } = req.params;
    const cleanHandle = agentHandle.replace('@', '');

    // Get verification status
    const verificationStatus = await agentVerification.verifyAgent(cleanHandle);

    const options = await agentFunding.getParticipationOptions(cleanHandle, verificationStatus);
    const points = await agentFunding.getAgentPoints(cleanHandle);

    res.json({
      agentHandle: cleanHandle,
      verified: verificationStatus?.isVerified || false,
      confidence: verificationStatus?.confidence || 0,
      tier: verificationStatus?.confidence >= 90 ? 'gold' :
            verificationStatus?.confidence >= 70 ? 'silver' :
            verificationStatus?.confidence >= 50 ? 'bronze' : 'unverified',
      points: points.totalPoints,
      participationOptions: options
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get agent's points
 * GET /api/points/:agentHandle
 */
app.get('/api/points/:agentHandle', async (req, res) => {
  try {
    const { agentHandle } = req.params;
    const cleanHandle = agentHandle.replace('@', '');
    const points = await agentFunding.getAgentPoints(cleanHandle);

    res.json({
      agentHandle: cleanHandle,
      ...points,
      note: 'Points will convert to $AGENTBETS tokens when launched (no timeline)'
    });
  } catch (error) {
    console.error('Error fetching agent points:', error);
    res.status(500).json({ error: 'Failed to fetch agent points' });
  }
});

/**
 * Get points leaderboard
 * GET /api/points-leaderboard
 */
app.get('/api/points-leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const leaderboard = await agentFunding.getPointsLeaderboard(limit);

    res.json({
      leaderboard,
      pointsInfo: agentFunding.pointsSystem
    });
  } catch (error) {
    console.error('Error fetching points leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch points leaderboard' });
  }
});

/**
 * Claim verification bonus points
 * POST /api/points/claim-verification
 */
app.post('/api/points/claim-verification', async (req, res) => {
  try {
    const { agentHandle } = req.body;

    if (!agentHandle) {
      return res.status(400).json({ error: 'agentHandle is required' });
    }

    const cleanHandle = agentHandle.replace('@', '');

    // Verify the agent first
    const verification = await agentVerification.verifyAgent(cleanHandle);
    if (!verification?.isVerified || verification.confidence < 50) {
      return res.status(403).json({
        error: 'Agent not verified or confidence too low',
        currentConfidence: verification?.confidence || 0,
        requiredConfidence: 50
      });
    }

    const result = await agentFunding.awardVerificationBonus(cleanHandle);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Claim whitelist bonus points
 * POST /api/points/claim-whitelist
 */
app.post('/api/points/claim-whitelist', async (req, res) => {
  try {
    const { agentHandle } = req.body;

    if (!agentHandle) {
      return res.status(400).json({ error: 'agentHandle is required' });
    }

    const cleanHandle = agentHandle.replace('@', '');

    // Check if whitelisted
    if (!agentVerification.checkWhitelist(cleanHandle)) {
      return res.status(403).json({
        error: 'Agent is not whitelisted',
        handle: cleanHandle
      });
    }

    const result = await agentFunding.awardWhitelistBonus(cleanHandle);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get participation/rewards info
 * GET /api/participation/info
 */
app.get('/api/participation-info', (req, res) => {
  res.json({
    pointsSystem: agentFunding.pointsSystem,
    royalties: {
      name: agentFunding.royaltyEarnings.name,
      description: agentFunding.royaltyEarnings.description,
      rate: agentFunding.royaltyEarnings.rate,
      important: agentFunding.royaltyEarnings.important,
      example: agentFunding.royaltyEarnings.example
    },
    freeMarketCreation: {
      name: agentFunding.freeMarketCreation.name,
      description: agentFunding.freeMarketCreation.description,
      requirements: agentFunding.freeMarketCreation.requirements
    },
    whitelistBenefits: {
      name: agentFunding.whitelistBenefits.name,
      description: agentFunding.whitelistBenefits.description,
      whitelist: agentFunding.whitelistBenefits.whitelist,
      benefits: agentFunding.whitelistBenefits.benefits
    },
    solanaAgentKitIntegration: {
      docs: 'https://github.com/sendaifun/solana-agent-kit',
      note: 'Agents can use solana-agent-kit to autonomously create wallets and interact with AgentBets'
    }
  });
});

// ==========================================
// REFERRAL SYSTEM ENDPOINTS
// ==========================================

/**
 * Get or generate referral code + stats for an agent
 * GET /api/referral/:agentHandle
 */
app.get('/api/referral/:agentHandle', async (req, res) => {
  try {
    const { agentHandle } = req.params;
    const cleanHandle = agentHandle.replace('@', '').toLowerCase();

    // Generate code if doesn't exist
    const code = await Referral.generateCode(cleanHandle);
    const stats = await Referral.getReferralStats(cleanHandle);

    res.json({
      agentHandle: cleanHandle,
      referralCode: code,
      referralLink: `https://agentbets.gg?ref=${code}`,
      ...stats,
      bonusPct: 10,
      note: 'Share your referral code! You earn 10% of your referred agents\' wager points.'
    });
  } catch (error) {
    console.error('Error getting referral info:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Register as referred by a code
 * POST /api/referral/register
 * Body: { referralCode, agentHandle }
 */
app.post('/api/referral/register', async (req, res) => {
  try {
    const { referralCode, agentHandle } = req.body;

    if (!referralCode || !agentHandle) {
      return res.status(400).json({ error: 'referralCode and agentHandle are required' });
    }

    const cleanHandle = agentHandle.replace('@', '').toLowerCase();
    const result = await Referral.registerReferral(referralCode, cleanHandle);

    // Award referral bonus to the referrer for the sign-up itself
    try {
      await agentFunding.awardPoints(
        result.referrerHandle,
        agentFunding.POINT_REWARDS.REFERRAL_BONUS,
        'Referral bonus - new agent referred'
      );
    } catch (bonusError) {
      console.error('Error awarding referral sign-up bonus:', bonusError.message);
    }

    res.json({
      success: true,
      message: `Successfully registered! @${result.referrerHandle} is now your referrer.`,
      referral: result
    });
  } catch (error) {
    console.error('Error registering referral:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * Get top referrers leaderboard
 * GET /api/referral/leaderboard
 */
app.get('/api/referral/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const leaderboard = await Referral.getLeaderboard(limit);

    res.json({
      leaderboard,
      note: 'Referrers earn 10% of their referred agents\' wager points'
    });
  } catch (error) {
    console.error('Error fetching referral leaderboard:', error);
    res.status(500).json({ error: 'Failed to fetch referral leaderboard' });
  }
});

// ==========================================
// STATS & HEALTH
// ==========================================

/**
 * Health check endpoint
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    network: process.env.SOLANA_NETWORK || 'mainnet'
  });
});

app.get('/api/stats', async (req, res) => {
  try {
    const allMarkets = await markets.values();
    const allBets = await bets.values();

    // Calculate USDC volume from market totalVolume (authoritative, includes on-chain synced data)
    const totalVolumeFromMarkets = allMarkets
      .reduce((sum, m) => sum + (m.totalVolume || 0), 0) / 1e6;

    // Also check bets table as fallback
    const totalVolumeFromBets = allBets
      .filter(b => b.amountUSDC)
      .reduce((sum, b) => sum + (b.amountUSDC || 0), 0);

    // Use whichever is larger (markets totalVolume includes on-chain synced data)
    const totalVolumeUSDC = Math.max(totalVolumeFromMarkets, totalVolumeFromBets);
    
    const activeMarkets = allMarkets.filter(m => m.status === 'active').length;
    const resolvedMarkets = allMarkets.filter(m => m.status === 'resolved').length;

    res.json({
      markets: {
        total: allMarkets.length,
        active: activeMarkets,
        resolved: resolvedMarkets
      },
      bets: {
        total: allBets.length,
        totalVolumeUSDC: Math.round(totalVolumeUSDC * 100) / 100
      },
      uniqueWallets: new Set(allBets.map(b => b.wallet)).size,
      agents: {
        verified: agentVerification.getWhitelist().length
      }
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'AgentBets API',
    version: '1.0.0',
    network: process.env.SOLANA_NETWORK || 'mainnet',
    escrowWallet: ESCROW_WALLET,
    marketsCount: markets.size,
    betsCount: bets.size,
    message: 'Ready to bet on agents! 🎰🦞'
  });
});

// API documentation endpoint (moved from / to /api)
app.get('/api', (req, res) => {
  res.json({
    name: 'AgentBets API',
    tagline: 'Prediction Markets for AI Agent Outcomes',
    version: '1.0.0',
    currency: {
      gas: 'SOL (Solana native token for transaction fees)',
      wagers: 'USDC (stablecoin for betting)',
      offChain: 'SOL (for off-chain markets via escrow)',
      note: 'On-chain markets (Poll.fun) use USDC for wagers. Users need SOL for gas fees.'
    },
    network: process.env.SOLANA_NETWORK || 'mainnet',
    endpoints: {
      markets: {
        'GET /api/markets': 'List all markets',
        'GET /api/markets/:id': 'Get market details',
        'POST /api/markets': 'Create market',
        'PUT /api/markets/:id/resolve': 'Resolve market'
      },
      bets: {
        'POST /api/bets': 'Place a bet',
        'GET /api/bets/user/:wallet': 'Get user bets',
        'GET /api/bets/market/:id': 'Get market bets'
      },
      positions: {
        'GET /api/positions/:wallet': 'Get user positions',
        'POST /api/positions/claim': 'Claim winnings'
      },
      escrow: {
        'GET /api/escrow/balance': 'Get escrow wallet balance',
        'POST /api/escrow/deposit': 'Create deposit transaction',
        'POST /api/escrow/verify': 'Verify bet transaction',
        'POST /api/escrow/payout': 'Process market payouts'
      },
      onchain: {
        _currency: 'SOL for gas fees, USDC for wagers',
        _note: 'Users must have a Poll.fun account before placing wagers',
        'POST /api/onchain/user/init': 'Check/initialize user account (required first)',
        'GET /api/onchain/user/:wallet/exists': 'Check if user has Poll.fun account',
        'POST /api/onchain/markets': 'Create on-chain market (USDC)',
        'POST /api/onchain/wager': 'Create wager instruction (user signs)',
        'GET /api/onchain/markets/:betPda': 'Get on-chain market data',
        'POST /api/onchain/resolve': 'Resolve market (oracle/admin)',
        'POST /api/onchain/settle': 'Settle single batch of winners',
        'POST /api/onchain/settle-all': 'Settle ALL batches (full payout)',
        'POST /api/onchain/close': 'Close settled bet, reclaim ~0.039 SOL rent',
        'GET /api/onchain/settle-status/:betPda': 'Check settlement status',
        'POST /api/onchain/payout-preview': 'Preview potential payout',
        'GET /api/onchain/user/:wallet': 'Get user on-chain data'
      },
      actions: {
        'GET /api/actions/bet/:marketId': 'Solana Action metadata for market (Blink)',
        'POST /api/actions/bet/:marketId/place': 'Create bet transaction via Action',
        'GET /api/actions/markets': 'Browse markets Action',
        'GET /api/actions/royalties/:handle': 'Agent royalties Action',
        'GET /api/blink/:marketId': 'Get Blink URL for market',
        'GET /api/blink': 'Get Blink URL for markets browser'
      },
      royalties: {
        'GET /api/royalties/:handle': 'Get agent royalty balance',
        'POST /api/royalties/register': 'Register wallet for withdrawals',
        'POST /api/royalties/withdraw': 'Withdraw pending royalties',
        'GET /api/royalties-leaderboard': 'Top earning creators'
      },
      verification: {
        'GET /api/verify/:handle': 'Verify if handle is an AI agent',
        'POST /api/verify/register': 'Register agent with proof',
        'GET /api/verify/whitelist': 'Get verified agents whitelist',
        'GET /api/verify/whitelist/:handle': 'Check if handle is whitelisted',
        'GET /api/verify/challenge/:handle': 'Generate verification challenge'
      },
      points: {
        'GET /api/points/:handle': 'Get agent points balance',
        'GET /api/points-leaderboard': 'Points leaderboard',
        'POST /api/points/claim-verification': 'Claim verification bonus (+500)',
        'POST /api/points/claim-whitelist': 'Claim whitelist bonus (+1000)',
        'GET /api/participation/:handle': 'Get participation options',
        'GET /api/participation-info': 'Get rewards/points info'
      },
      other: {
        'GET /api/leaderboard': 'Top predictors',
        'GET /api/stats': 'Platform stats',
        'GET /api/oracle/:marketId': 'Oracle info'
      }
    },
    builtBy: 'Butters (@AIButters)',
    hackathon: 'Colosseum Solana Agent Hackathon 2026'
  });
});

// NOTE: Test market seeding removed for production.
// All markets are created on-chain via POST /api/onchain/markets
// or off-chain via POST /api/markets.

// ==========================================
// x402 AGENT BETTING ENDPOINTS
// Programmatic betting for AI agents via HTTP
// ==========================================

/**
 * Place a bet via x402 payment (for AI agents)
 * POST /api/agent/bet/:marketId
 *
 * Body: { outcome: "YES"|"NO", amount: number, agentHandle: string }
 *
 * Flow:
 * 1. First call returns 402 with payment requirements
 * 2. Agent signs payment with x402 wallet
 * 3. Retry with PAYMENT-SIGNATURE header
 * 4. Bet is recorded and confirmed
 */
app.post('/api/agent/bet/:marketId',
  agentLimiter,
  requireApiKey,
  x402.x402BetGate({ minAmount: 1, maxAmount: 10000 }),
  async (req, res) => {
    try {
      const { marketId } = req.params;
      const { outcome, amount, agentHandle } = req.body;
      const payment = req.x402Payment;

      // Get market
      const market = await markets.get(marketId);
      if (!market) {
        return res.status(404).json({ error: 'Market not found' });
      }

      if (market.status !== 'active') {
        return res.status(400).json({ error: `Market is ${market.status}, cannot place bets` });
      }

      if (new Date(market.endDate) < new Date()) {
        return res.status(400).json({ error: 'Market has ended' });
      }

      // Convert USDC to lamports equivalent for pool tracking
      const lamportsEquiv = Math.round(x402.usdcToSolApprox(payment.amountUSDC) * LAMPORTS_PER_SOL);

      // Record the bet
      const betId = uuidv4();
      const bet = {
        id: betId,
        marketId,
        outcome: payment.outcome,
        amount: lamportsEquiv,
        amountUSDC: payment.amountUSDC,
        currency: 'USDC',
        wallet: `x402:${agentHandle || 'anonymous'}`, // Agent identifier
        agentHandle: agentHandle || null,
        timestamp: new Date().toISOString(),
        x402Signature: payment.signature?.slice(0, 32),
        paymentNetwork: payment.network || 'eip155:84532',
        type: 'agent-x402' // Distinguish from Blink/SOL bets
      };

      bets.set(betId, bet);

      // Update market pools
      if (payment.outcome === 'YES') {
        market.yesPool = (market.yesPool || 0) + lamportsEquiv;
      } else {
        market.noPool = (market.noPool || 0) + lamportsEquiv;
      }

      // Recalculate odds (probability-based)
      const totalPool = market.yesPool + market.noPool;
      if (totalPool > 0) {
        market.yesOdds = market.yesPool / totalPool;
        market.noOdds = market.noPool / totalPool;
      }

      market.totalVolume = (market.totalVolume || 0) + lamportsEquiv;
      market.totalBets = (market.totalBets || 0) + 1;

      // Record odds history so charts update with agent/bot bets
      await recordOddsHistory(marketId, market);

      // Update positions
      const positionKey = `${bet.wallet}:${marketId}`;
      const existingPosition = positions.get(positionKey) || {
        wallet: bet.wallet,
        marketId,
        yesAmount: 0,
        noAmount: 0
      };

      if (payment.outcome === 'YES') {
        existingPosition.yesAmount += lamportsEquiv;
      } else {
        existingPosition.noAmount += lamportsEquiv;
      }
      positions.set(positionKey, existingPosition);

      console.log(`[x402] Agent bet recorded: ${betId} - ${agentHandle} bet ${payment.amountUSDC} USDC ${payment.outcome} on ${marketId}`);

      // Award wager points for x402 agent bets
      let pointsAwarded = null;
      if (agentHandle) {
        try {
          pointsAwarded = await agentFunding.awardWagerPoints(agentHandle, payment.amountUSDC);
        } catch (pointsError) {
          console.error('[Points] Error awarding x402 wager points:', pointsError.message);
        }
      }

      res.json({
        success: true,
        pointsAwarded: pointsAwarded ? pointsAwarded.totalPoints : null,
        bet: {
          id: betId,
          marketId,
          outcome: payment.outcome,
          amountUSDC: payment.amountUSDC,
          currency: 'USDC',
          agentHandle,
          timestamp: bet.timestamp
        },
        market: {
          id: market.id,
          question: market.question,
          yesOdds: market.yesOdds,
          noOdds: market.noOdds,
          yesPool: market.yesPool / LAMPORTS_PER_SOL,
          noPool: market.noPool / LAMPORTS_PER_SOL
        },
        payment: {
          verified: true,
          network: payment.network,
          signature: payment.signature?.slice(0, 16) + '...'
        }
      });

    } catch (error) {
      console.error('[x402] Bet error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

/**
 * Create market AND place initial bet in one call (for agents)
 * POST /api/agent/create-and-bet
 *
 * Body: {
 *   question, endDate, category, resolutionSource,
 *   initialBet: number, initialOutcome: "YES"|"NO",
 *   agentHandle: string
 * }
 */
app.post('/api/agent/create-and-bet', agentLimiter, requireApiKey, async (req, res) => {
  try {
    const {
      question,
      description,
      category,
      resolutionSource,
      endDate,
      initialBet,
      initialOutcome,
      agentHandle,
      threshold,
      verificationMethod,
      tags
    } = req.body;

    // Validate required fields
    if (!question || !endDate) {
      return res.status(400).json({ error: 'Question and endDate are required' });
    }

    // Validate end date is in the future (at least 10 minutes)
    const endDateTime = new Date(endDate);
    const now = new Date();
    const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
    
    if (isNaN(endDateTime.getTime())) {
      return res.status(400).json({ error: 'Invalid endDate format. Use ISO 8601 format' });
    }
    
    if (endDateTime <= now) {
      return res.status(400).json({ error: 'End date must be in the future. Cannot create markets that have already ended.' });
    }
    
    if (endDateTime < tenMinutesFromNow) {
      return res.status(400).json({ error: 'End date must be at least 10 minutes in the future' });
    }

    // Check for x402 payment if initial bet is specified
    const paymentHeader = x402.getPaymentHeader(req);

    if (initialBet && initialBet > 0) {
      // Enforce $1 minimum bet (50-wager cap per market makes sub-dollar bets uneconomical)
      if (initialBet < 1) {
        return res.status(400).json({ error: 'Minimum bet amount is 1 USDC' });
      }

      if (!paymentHeader) {
        // No payment - return 402 with requirements
        const marketId = 'pending-' + Date.now(); // Temporary ID
        return x402.sendBetPaymentRequired(res, {
          amountUSDC: initialBet,
          marketId,
          outcome: initialOutcome || 'YES',
          agentHandle,
          network: req.body.network || 'eip155:84532'
        });
      }
    }

    // Create the market
    const marketId = uuidv4();
    const createdAt = new Date().toISOString();

    const market = {
      id: marketId,
      question,
      description: description || `Created by ${agentHandle || 'agent'} via AgentBets`,
      category: category || 'general',
      outcomes: ['YES', 'NO'],
      resolutionSource: resolutionSource || 'manual',
      endDate,
      createdAt: createdAt,
      creatorWallet: null,
      creatorAgent: agentHandle || null,
      status: 'active',
      resolution: null,
      resolvedAt: null,
      verificationMethod: verificationMethod || null,
      threshold: threshold || null,
      tags: tags || ['agent-created'],
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    };

    markets.set(marketId, market);

    // Register creator for royalties
    if (agentHandle) {
      royalties.registerCreator(agentHandle, null, marketId);
    }

    let betResult = null;

    // Place initial bet if payment was provided
    if (initialBet && initialBet > 0 && paymentHeader) {
      const payment = x402.parsePaymentHeader(paymentHeader);
      const lamportsEquiv = Math.round(x402.usdcToSolApprox(initialBet) * LAMPORTS_PER_SOL);
      const outcome = (initialOutcome || 'YES').toUpperCase();

      // Record the bet
      const betId = uuidv4();
      const bet = {
        id: betId,
        marketId,
        outcome,
        amount: lamportsEquiv,
        amountUSDC: initialBet,
        currency: 'USDC',
        wallet: `x402:${agentHandle || 'anonymous'}`,
        agentHandle,
        timestamp: createdAt,
        x402Signature: payment.signature?.slice(0, 32),
        type: 'agent-x402-initial'
      };

      bets.set(betId, bet);

      // Update market pools
      if (outcome === 'YES') {
        market.yesPool = lamportsEquiv;
      } else {
        market.noPool = lamportsEquiv;
      }

      // Recalculate odds (probability-based)
      const totalPool = market.yesPool + market.noPool;
      if (totalPool > 0) {
        market.yesOdds = market.yesPool / totalPool;
        market.noOdds = market.noPool / totalPool;
      }

      market.totalVolume = lamportsEquiv;
      market.totalBets = 1;

      // Record odds history for initial bet
      await recordOddsHistory(marketId, market);

      betResult = {
        id: betId,
        outcome,
        amountUSDC: initialBet,
        currency: 'USDC'
      };

      console.log(`[x402] Initial bet placed: ${betId} - ${agentHandle} bet ${initialBet} USDC ${outcome}`);
    }

    // Generate Blink URL for others to bet
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const blinkUrl = `${baseUrl}/markets/${marketId}`;

    console.log(`[x402] Market created: ${marketId} by ${agentHandle}`);

    res.status(201).json({
      success: true,
      market: {
        id: marketId,
        question,
        category: market.category,
        endDate,
        resolutionSource: market.resolutionSource,
        yesOdds: market.yesOdds,
        noOdds: market.noOdds,
        yesPoolSOL: market.yesPool / LAMPORTS_PER_SOL,
        noPoolSOL: market.noPool / LAMPORTS_PER_SOL,
        creatorAgent: agentHandle
      },
      initialBet: betResult,
      blinkUrl,
      marketUrl: `${baseUrl}/markets/${marketId}`,
      royaltyInfo: {
        creator: agentHandle,
        rate: '0.3%',
        description: 'You earn 0.3% of winning payouts from this market'
      }
    });

  } catch (error) {
    console.error('[x402] Create-and-bet error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get x402 payment info for a bet (dry run)
 * GET /api/agent/bet/:marketId/price?amount=10&outcome=YES
 */
app.get('/api/agent/bet/:marketId/price', async (req, res) => {
  const { marketId } = req.params;
  const { amount, outcome } = req.query;

  const market = await markets.get(marketId);
  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }

  const amountUSDC = parseFloat(amount) || 10;
  const betOutcome = (outcome || 'YES').toUpperCase();

  // Build payment requirements without sending 402
  const solanaNetwork = process.env.SOLANA_NETWORK === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
  const requirements = x402.buildBetPaymentRequirements({
    amountUSDC,
    marketId,
    outcome: betOutcome,
    network: solanaNetwork
  });

  res.json({
    market: {
      id: market.id,
      question: market.question,
      yesOdds: market.yesOdds,
      noOdds: market.noOdds
    },
    bet: {
      outcome: betOutcome,
      amountUSDC,
      potentialWinnings: betOutcome === 'YES'
        ? (market.yesOdds > 0 ? amountUSDC / market.yesOdds : amountUSDC * 2)
        : (market.noOdds > 0 ? amountUSDC / market.noOdds : amountUSDC * 2)
    },
    x402: {
      payTo: x402.getPayToAddress(),
      network: solanaNetwork,
      networkName: process.env.SOLANA_NETWORK === 'devnet' ? 'Solana Devnet' : 'Solana Mainnet',
      currency: 'USDC',
      amount: amountUSDC,
      paymentHeader: requirements
    },
    howToPay: {
      step1: 'POST to /api/agent/bet/' + marketId + ' with body: { outcome, amount, agentHandle }',
      step2: 'Receive 402 response with PAYMENT-REQUIRED header',
      step3: 'Sign payment with x402 wallet (createPayClient from @x402/fetch)',
      step4: 'Retry request with PAYMENT-SIGNATURE header',
      step5: 'Receive bet confirmation'
    }
  });
});

/**
 * Agent wallet registration for x402
 * POST /api/agent/wallet
 */
app.post('/api/agent/wallet', requireApiKey, (req, res) => {
  const { agentHandle, evmAddress, solanaAddress } = req.body;

  if (!agentHandle) {
    return res.status(400).json({ error: 'agentHandle is required' });
  }

  // Store wallet mapping (in production, would use database)
  const agentWallets = app.locals.agentWallets || new Map();
  agentWallets.set(agentHandle.toLowerCase(), {
    handle: agentHandle,
    evmAddress: evmAddress || null,
    solanaAddress: solanaAddress || null,
    registeredAt: new Date().toISOString()
  });
  app.locals.agentWallets = agentWallets;

  // Also register for royalties if Solana address provided
  if (solanaAddress) {
    royalties.registerCreator(agentHandle, solanaAddress, null);
  }

  console.log(`[x402] Agent wallet registered: ${agentHandle} - EVM: ${evmAddress}, SOL: ${solanaAddress}`);

  res.json({
    success: true,
    agent: agentHandle,
    wallets: {
      evm: evmAddress || 'not set',
      solana: solanaAddress || 'not set'
    },
    message: 'Wallet registered for x402 payments and royalty withdrawals'
  });
});

/**
 * Get agent's bets and positions
 * GET /api/agent/:handle/bets
 */
app.get('/api/agent/:handle/bets', async (req, res) => {
  const { handle } = req.params;
  const agentKey = `x402:${handle}`;

  // Get all bets by this agent
  const allBetsList = await bets.values();
  const agentBetsList = allBetsList
    .filter(bet => bet.agentHandle === handle || bet.wallet === agentKey);
  const agentBets = await Promise.all(agentBetsList.map(async (bet) => ({
      id: bet.id,
      marketId: bet.marketId,
      outcome: bet.outcome,
      amountUSDC: bet.amountUSDC || x402.solToUsdcApprox(bet.amount / LAMPORTS_PER_SOL),
      currency: bet.currency || 'SOL',
      timestamp: bet.timestamp,
      market: (await markets.get(bet.marketId))?.question || 'Unknown market'
    })));

  // Get positions
  const allPositionsList = await positions.findByWallet(agentKey);
  const agentPositions = await Promise.all(allPositionsList.map(async (pos) => {
      const market = await markets.get(pos.marketId);
      return {
        marketId: pos.marketId,
        question: market?.question || 'Unknown market',
        yesAmountSOL: (pos.yesAmount || 0) / LAMPORTS_PER_SOL,
        noAmountSOL: (pos.noAmount || 0) / LAMPORTS_PER_SOL,
        status: market?.status || 'unknown',
        currentOdds: {
          yes: market?.yesOdds || 0.5,
          no: market?.noOdds || 0.5
        }
      };
    }));

  // Get royalties
  const royaltyInfo = royalties.getCreatorRoyalties(handle);

  res.json({
    agent: handle,
    totalBets: agentBets.length,
    bets: agentBets,
    positions: agentPositions,
    royalties: royaltyInfo || { earned: 0, pending: 0, withdrawn: 0 },
    marketsCreated: Array.from(markets.values())
      .filter(m => m.creatorAgent === `@${handle}` || m.creatorAgent === handle)
      .length
  });
});

// Mount OG image generation endpoint
app.use('/api/og', ogRouter);

// Serve frontend in production mode
// This serves the built React app from frontend/dist
const frontendPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendPath));

// Bot/crawler User-Agent patterns for social media preview cards
const BOT_USER_AGENTS = /Twitterbot|facebookexternalhit|Facebot|Slackbot|Discordbot|LinkedInBot|WhatsApp|TelegramBot|Applebot|Googlebot|bingbot|Pinterestbot|redditbot/i;

/**
 * Crawler-detection middleware for /markets/:id
 * Serves dynamic HTML with OG meta tags to social media bots,
 * while regular users fall through to the SPA catch-all.
 */
app.get('/markets/:marketId', async (req, res, next) => {
  const userAgent = req.get('User-Agent') || '';
  
  // Only intercept for known bots/crawlers
  if (!BOT_USER_AGENTS.test(userAgent)) {
    return next(); // Regular users get the SPA
  }

  try {
    const { marketId } = req.params;
    const market = await markets.get(marketId);
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';

    if (!market) {
      // Market not found - serve generic OG tags
      return res.send(buildOgHtml({
        title: 'AgentBets - Prediction Markets for AI Agents',
        description: 'Bet on AI agent outcomes with USDC on Solana. On-chain prediction markets powered by Poll.fun.',
        image: `${baseUrl}/agentbets-logo-full.png`,
        url: `${baseUrl}/markets`,
      }));
    }

    // Calculate odds for description
    const yesPool = (market.yesPool || 0) / 1e6;
    const noPool = (market.noPool || 0) / 1e6;
    const totalPool = yesPool + noPool;
    const yesPercent = totalPool > 0 ? Math.round((yesPool / totalPool) * 100) : 50;
    const noPercent = totalPool > 0 ? Math.round((noPool / totalPool) * 100) : 50;
    const totalBets = market.totalBets || 0;

    const question = market.question.length > 100
      ? market.question.substring(0, 97) + '...'
      : market.question;

    let description = `YES ${yesPercent}% | NO ${noPercent}%`;
    if (totalPool > 0) description += ` | Pool: ${totalPool.toFixed(2)} USDC`;
    if (totalBets > 0) description += ` | ${totalBets} bet${totalBets !== 1 ? 's' : ''}`;
    description += ' — Bet now on AgentBets';

    res.send(buildOgHtml({
      title: question,
      description,
      image: `${baseUrl}/api/og/${marketId}`,
      url: `${baseUrl}/markets/${marketId}`,
    }));

  } catch (error) {
    console.error('[Crawler] Error serving OG tags:', error);
    next(); // Fall through to SPA on error
  }
});

/**
 * Crawler-detection for /markets (browse all)
 */
app.get('/markets', (req, res, next) => {
  const userAgent = req.get('User-Agent') || '';
  if (!BOT_USER_AGENTS.test(userAgent)) {
    return next();
  }

  const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
  res.send(buildOgHtml({
    title: 'AgentBets - Browse Prediction Markets',
    description: 'Bet on AI agent outcomes with USDC on Solana. On-chain prediction markets powered by Poll.fun.',
    image: `${baseUrl}/agentbets-logo-full.png`,
    url: `${baseUrl}/markets`,
  }));
});

/**
 * Build minimal HTML with OG meta tags for social crawlers
 */
function buildOgHtml({ title, description, image, url }) {
  const escHtml = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta property="og:title" content="${escHtml(title)}" />
  <meta property="og:description" content="${escHtml(description)}" />
  <meta property="og:image" content="${escHtml(image)}" />
  <meta property="og:url" content="${escHtml(url)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="AgentBets" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:site" content="@AgentBetsBot" />
  <meta name="twitter:title" content="${escHtml(title)}" />
  <meta name="twitter:description" content="${escHtml(description)}" />
  <meta name="twitter:image" content="${escHtml(image)}" />
  <title>${escHtml(title)}</title>
</head>
<body>
  <p>${escHtml(title)}</p>
  <p>${escHtml(description)}</p>
</body>
</html>`;
}

// Embed route - serve SPA with iframe-friendly headers
// Allows partner platforms to embed market cards via iframe
app.get('/embed/:marketId', (req, res, next) => {
  const indexPath = path.join(frontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    // Remove X-Frame-Options and set permissive frame-ancestors for embedding
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// Handle SPA routing - serve index.html for all non-API routes
app.get('*', (req, res, next) => {
  // Skip API routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/health')) {
    return next();
  }
  // Serve index.html for SPA routing
  const indexPath = path.join(frontendPath, 'index.html');
  const fs = require('fs');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    next();
  }
});

// Store server reference for graceful shutdown
let server = null;

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database connection
    if (process.env.DATABASE_URL) {
      console.log('[DB] Connecting to PostgreSQL...');
      const connected = await db.initDatabase();
      
      if (connected) {
        dbConnected = true;
        dbCompat.setDbConnected(true);
        console.log('[DB] Running migrations...');
        await db.runMigrations();
        
        // Seed default verified agents
        const defaultAgents = [
          'truth_terminal', 'aibutters', 'aikidonft', 'aethernet',
          'luna_virtuals', 'zerebro', 'dolos_diary', 'freysa_ai'
        ];
        await Agent.seedWhitelist(defaultAgents);
        console.log('[DB] Seeded default verified agents');
      } else {
        console.warn('[DB] Failed to connect - falling back to in-memory storage');
      }
    } else {
      console.warn('[DB] DATABASE_URL not set - using in-memory storage');
      console.warn('[DB] Data will be lost on restart!');
    }

    // AUTO: Initialize bot's Poll.fun user account on startup
    // This ensures the bot can create markets without "Account does not exist" errors
    if (pollFunService.creatorKeypair) {
      // Check and log creator wallet SOL balance
      try {
        const { LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const balance = await pollFunService.connection.getBalance(pollFunService.creatorKeypair.publicKey);
        const balanceSOL = (balance / LAMPORTS_PER_SOL).toFixed(4);
        const marketsAffordable = Math.floor(balance / 50_000_000); // ~0.05 SOL per market
        console.log(`[PollFun] Creator wallet: ${pollFunService.creatorKeypair.publicKey.toBase58()}`);
        console.log(`[PollFun] Creator wallet balance: ${balanceSOL} SOL (~${marketsAffordable} markets possible)`);
        if (balance < 50_000_000) {
          console.warn(`[PollFun] LOW BALANCE WARNING: Creator wallet needs SOL to create markets (~0.05 SOL each)`);
          console.warn(`[PollFun] Send SOL to: ${pollFunService.creatorKeypair.publicKey.toBase58()}`);
        }
      } catch (err) {
        console.warn('[PollFun] Could not check creator wallet balance:', err.message);
      }

      console.log('[PollFun] Ensuring bot creator user account exists on-chain...');
      try {
        const userResult = await pollFunService.ensureCreatorUserExists();
        if (userResult.success) {
          console.log(`[PollFun] Bot creator account ready: ${userResult.userAddress}`);
        } else {
          console.warn(`[PollFun] WARNING: Could not initialize bot creator account: ${userResult.error}`);
          console.warn('[PollFun] Market creation may fail until this is resolved.');
        }
      } catch (err) {
        console.warn('[PollFun] WARNING: Error initializing bot creator account:', err.message);
        console.warn('[PollFun] Will retry automatically on first market creation.');
      }
    } else {
      console.warn('[PollFun] No SOLANA_PRIVATE_KEY - bot creator account not initialized');
    }

    // Initialize Gasless Relay Service (Octane-style USDC fee payer)
    if (gaslessService.enabled) {
      console.log('[Gasless] Initializing USDC relay service...');
      try {
        await gaslessService.initialize();
        console.log(`[Gasless] Relay active — agents only need USDC (fee: ${gaslessService.feeUsdc} USDC/tx)`);
      } catch (err) {
        console.warn('[Gasless] WARNING: Relay initialization failed:', err.message);
        console.warn('[Gasless] Gasless transactions will be unavailable.');
      }
    } else {
      console.log('[Gasless] Relay disabled (set GASLESS_ENABLED=true to enable)');
    }

    // Sync on-chain markets from Solana PDAs on startup
    // This backfills any wagers placed outside the API (e.g., before recording was added)
    if (pollFunService.creatorKeypair) {
      // Run sync in background so it doesn't delay server startup
      syncAllMarketsFromChain().catch(err => {
        console.warn('[Sync] Background sync failed:', err.message);
      });
    }

    // Start server and store reference
    const gaslessStatus = gaslessService.enabled ? `Gasless: ${gaslessService.feeUsdc} USDC/tx` : 'Gasless: Disabled';
    server = app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║          AgentBets API Server Running                     ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                               ║
║  Network: Solana Mainnet                                  ║
║  Escrow: ${ESCROW_WALLET.slice(0,8)}...                              ║
║  ${gaslessStatus.padEnd(55)}║
║  Database: ${dbConnected ? 'PostgreSQL Connected' : 'In-Memory (no persistence)'}        ║
║                                                           ║
║  Prediction Markets for AI Agent Outcomes                 ║
║  Built by Butters (@AIButters)                            ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });
    
    // Disable keep-alive so connections close promptly on shutdown
    server.keepAliveTimeout = 5000;
    server.headersTimeout = 6000;
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    process.exit(1);
  }
}

// Track if shutdown is in progress
let isShuttingDown = false;

// Graceful shutdown function
async function gracefulShutdown(signal) {
  // Prevent multiple shutdown attempts
  if (isShuttingDown) {
    console.log('[Server] Shutdown already in progress, forcing exit...');
    process.exit(1);
    return;
  }
  isShuttingDown = true;
  
  console.log(`\n[Server] Received ${signal}, shutting down...`);
  
  // Hard timeout: force exit after 5 seconds no matter what
  const forceExitTimeout = setTimeout(() => {
    console.error('[Server] Forced exit after 5s timeout');
    process.exit(1);
  }, 5000);
  forceExitTimeout.unref(); // Don't let this timer keep the event loop alive
  
  // Close HTTP server (stop accepting new connections)
  if (server) {
    try {
      // closeAllConnections() immediately destroys all sockets (Node 18.2+)
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      
      server.close(() => {
        console.log('[Server] HTTP server closed');
      });
    } catch (err) {
      console.error('[Server] Error closing HTTP server:', err.message);
    }
  }
  
  // Close database connection pool
  try {
    await db.closePool();
    console.log('[Server] Database pool closed');
  } catch (err) {
    console.error('[Server] Error closing database:', err.message);
  }
  
  console.log('[Server] Shutdown complete');
  process.exit(0);
}

// Handle ALL shutdown signals (Replit may send SIGHUP)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Server] Unhandled rejection at:', promise, 'reason:', reason);
});

// Start the server
startServer();

module.exports = app;
