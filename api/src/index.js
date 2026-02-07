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
const { Market, Bet, Agent, Royalty, Points, OddsHistory, Position } = require('./db/models');

// Use compatibility layer for storage (works with both DB and in-memory)
const { markets, bets, positions, oddsHistory } = dbCompat;

// Escrow module for on-chain operations
const escrow = require('./escrow');
// Oracle module for market resolution
const oracle = require('./oracle');
// Poll.fun SDK for on-chain prediction markets
const { pollFunService, PollFunService } = require('./pollfun');
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

const app = express();
const PORT = process.env.PORT || 3002;

// Trust proxy for rate limiting behind reverse proxy (Replit, Railway, etc.)
app.set('trust proxy', 1);

// Input Sanitization Utilities - Prevent XSS and injection attacks
const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input
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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
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
      creatorAgent
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
      tags: req.body.tags || [], // Additional tags for filtering

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
      agentFunding.awardMarketCreationPoints(creatorAgent, marketId);
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
    const { status, category, limit = 50 } = req.query;

    let results = await markets.findAll({ status, category, limit: parseInt(limit) });

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
        totalVolume: (m.totalVolume || 0) / 1000000, // USDC decimals
        totalBets: m.totalBets || 0,
        yesPool: (m.yesPool || 0) / 1000000,
        noPool: (m.noPool || 0) / 1000000,
        endDate: m.endDate,
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

// Middleware to check if wallet is admin with signature verification
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

    if (!['YES', 'NO'].includes(proposedOutcome)) {
      return res.status(400).json({ error: 'Proposed outcome must be YES or NO' });
    }

    // Move to pending confirmation state
    await markets.update(market.id, {
      status: 'pending_confirmation',
      proposedResolution: {
        outcome: proposedOutcome,
        confidence: confidence || 0,
        evidence: evidence || {},
        proposedAt: new Date().toISOString(),
        proposedBy: proposedBy || 'manual'
      }
    });

    console.log(`[Resolution] Market ${market.id} proposed: ${proposedOutcome} (by ${proposedBy})`);

    res.json({
      success: true,
      market,
      message: `Resolution proposed: ${proposedOutcome}. Awaiting admin confirmation.`,
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
app.post('/api/markets/:id/confirm-resolution', adminLimiter, requireAdmin, async (req, res) => {
  try {
    const { finalOutcome, adminNotes, adminWallet } = req.body;
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

      const onChainResult = await pollFunService.resolveMarket({
        betPda: market.betPda,
        winningOutcome: finalOutcome
      });

      if (!onChainResult.success) {
        return res.status(500).json({
          error: 'Failed to resolve on-chain',
          details: onChainResult.error
        });
      }

      market.onChainResolutionTx = onChainResult.txSignature;

      // Auto-settle all batches for on-chain market
      console.log(`[Resolution] Auto-settling on-chain market: ${market.betPda}`);

      const marketData = await pollFunService.getMarketData(market.betPda);
      if (marketData.success) {
        const totalUsers = marketData.currentUserCount || 0;
        const totalBatches = Math.ceil(totalUsers / 10);

        for (let batchNumber = 0; batchNumber < totalBatches; batchNumber++) {
          try {
            await pollFunService.settleBatch({
              betPda: market.betPda,
              batchNumber,
              usersPerBatch: 10
            });
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
    }

    markets.set(market.id, market);

    // Calculate payouts for off-chain markets
    const marketBets = Array.from(bets.values()).filter(b => b.marketId === market.id);
    const winningBets = marketBets.filter(b => b.outcome === finalOutcome);
    const losingPool = finalOutcome === 'YES' ? market.noPool : market.yesPool;
    const winningPool = finalOutcome === 'YES' ? market.yesPool : market.noPool;

    let totalCreatorRoyalty = 0;
    let totalPlatformFee = 0;

    const payouts = winningBets.map(bet => {
      const share = bet.amount / winningPool;
      const grossWinnings = bet.amount + (share * losingPool);

      const royaltyInfo = royalties.calculateRoyalties(market.creatorAgent, grossWinnings);
      totalCreatorRoyalty += royaltyInfo.creatorRoyalty;
      totalPlatformFee += royaltyInfo.platformShare;

      return {
        betId: bet.id,
        wallet: bet.wallet,
        originalBet: bet.amount,
        grossWinnings: Math.floor(grossWinnings),
        netWinnings: Math.floor(royaltyInfo.netWinnings),
        feeDeducted: Math.floor(royaltyInfo.totalFee),
        share: share
      };
    });

    const royaltySummary = {
      creatorAgent: market.creatorAgent,
      creatorRoyalty: totalCreatorRoyalty,
      creatorRoyaltySOL: totalCreatorRoyalty / LAMPORTS_PER_SOL,
      platformFee: totalPlatformFee,
      platformFeeSOL: totalPlatformFee / LAMPORTS_PER_SOL,
      feeBreakdown: '1% total fee: 0.3% to creator, 0.7% to platform'
    };

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
    res.status(500).json({ error: error.message });
  }
});

/**
 * Override proposed resolution (ADMIN ONLY)
 * POST /api/markets/:id/override-resolution
 *
 * Use this if you disagree with the bot's proposed resolution
 */
app.post('/api/markets/:id/override-resolution', adminLimiter, requireAdmin, async (req, res) => {
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

    markets.set(market.id, market);

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
    const { marketId, outcome, amount, wallet, txSignature } = req.body;

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
      txSignature: txSignature || null,
      placedAt: new Date().toISOString(),
      status: 'active', // active, won, lost, claimed
      currency: 'USDC'
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
      market.yesOdds = market.noPool / totalPool; // Payout ratio for YES
      market.noOdds = market.yesPool / totalPool; // Payout ratio for NO
    }

    await markets.set(marketId, market);

    // Record odds history after bet
    await recordOddsHistory(marketId, market);

    // Update user positions
    await positions.upsert(wallet, marketId, outcome, amountMicroUsdc);

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
      message: `Bet placed! ${amount} USDC on ${outcome}`
    });
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
      proposerWallet // NEW: proposer's wallet (for UI display, NOT for resolution)
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
    const sanitizedTags = Array.isArray(tags) ? tags.map(t => sanitizeInput(String(t))).slice(0, 10) : [];

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

    const market = {
      id: marketId,
      betPda: result.betPda, // On-chain PDA
      question: sanitizedQuestion,
      description: sanitizedDescription,
      category: sanitizedCategory,
      outcomes: ['YES', 'NO'],
      resolutionSource: 'pollfun', // On-chain resolution
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
      // SECURITY NOTE: Bot is on-chain creator, can resolve
      securityNote: 'Bot-created market. Only bot can resolve (isCreatorResolver).'
    };

    markets.set(marketId, market);

    // Track market creation for royalties (proposer gets credit, not bot)
    if (sanitizedCreatorAgent) {
      royalties.recordMarketCreation(sanitizedCreatorAgent, marketId);
      agentFunding.awardMarketCreationPoints(sanitizedCreatorAgent, marketId);
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

    // Build wager instruction for client-side signing
    const result = await pollFunService.buildWagerInstruction({
      betPda: pdaAddress,
      side: outcome,
      amount,
      userPubkey: wallet,
      feePayerPubkey: useGasless ? gaslessService.feePayerKeypair.publicKey.toBase58() : undefined
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    if (useGasless) {
      // GASLESS MODE: Build full transaction, wrap with USDC fee, pre-sign
      console.log(`[API] Building gasless wager for ${wallet.slice(0, 8)}...`);

      const transaction = new Transaction();
      if (userInitIx) {
        transaction.add(userInitIx);
      }
      transaction.add(result.instruction);

      const wrapped = await gaslessService.wrapWithGasless(transaction, userPubkey);

      res.json({
        success: true,
        gasless: true,
        transaction: wrapped.transaction,
        blockhash: wrapped.blockhash,
        lastValidBlockHeight: wrapped.lastValidBlockHeight,
        feePayer: wrapped.feePayer,
        gasFee: wrapped.feeUsdc,
        wagerDetails: {
          betPda: pdaAddress,
          marketId: marketId || null,
          side: outcome,
          amount,
          currency: 'USDC'
        },
        message: `Bet ${amount} USDC on ${outcome} (gasless — ${wrapped.feeUsdc} USDC gas fee, no SOL needed)`,
        instructions: 'Transaction is pre-signed by the relay. Sign with your wallet and broadcast directly, or POST to /api/relay.'
      });
    } else {
      // TRADITIONAL MODE: Return individual instructions
      res.json({
        success: true,
        gasless: false,
        userInitInstruction: userInitInstructionSerialized || null,
        userAccountNote: userInitInstructionSerialized
          ? 'User account does not exist. Include the userInitInstruction BEFORE the wager instruction in your transaction.'
          : 'User account exists.',
        instruction: result.instruction ? {
          programId: result.instruction.programId?.toBase58(),
          keys: result.instruction.keys?.map(k => ({
            pubkey: k.pubkey.toBase58(),
            isSigner: k.isSigner,
            isWritable: k.isWritable
          })),
          data: result.instruction.data?.toString('base64')
        } : null,
        wagerDetails: {
          betPda: pdaAddress,
          marketId: marketId || null,
          side: outcome,
          amount,
          currency: 'USDC'
        },
        message: result.message,
        instructions: userInitInstructionSerialized
          ? 'Build a transaction with userInitInstruction first, then the wager instruction, and sign with your wallet.'
          : 'Build a transaction with this instruction and sign with your wallet.'
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
    dialToUrl: `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`,
    instructions: 'Share the blinkUrl on X/Twitter. Users with Blink-compatible wallets can bet directly!'
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
    dialToUrl: `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`,
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
      payments: 'Base Sepolia (testnet) / Base (mainnet)',
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

    const options = agentFunding.getParticipationOptions(cleanHandle, verificationStatus);
    const points = agentFunding.getAgentPoints(cleanHandle);

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
app.get('/api/points/:agentHandle', (req, res) => {
  const { agentHandle } = req.params;
  const cleanHandle = agentHandle.replace('@', '');
  const points = agentFunding.getAgentPoints(cleanHandle);

  res.json({
    agentHandle: cleanHandle,
    ...points,
    note: 'Points will convert to $AGENTBETS tokens when launched (no timeline)'
  });
});

/**
 * Get points leaderboard
 * GET /api/points-leaderboard
 */
app.get('/api/points-leaderboard', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const leaderboard = agentFunding.getPointsLeaderboard(limit);

  res.json({
    leaderboard,
    pointsInfo: agentFunding.pointsSystem
  });
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

    const result = agentFunding.awardVerificationBonus(cleanHandle);
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

    const result = agentFunding.awardWhitelistBonus(cleanHandle);
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

    // Calculate USDC volume from bets that have amountUSDC field
    const totalVolumeUSDC = allBets
      .filter(b => b.amountUSDC)
      .reduce((sum, b) => sum + (b.amountUSDC || 0), 0);
    
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
  x402.x402BetGate({ minAmount: 0.01, maxAmount: 10000 }),
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

      // Recalculate odds (AMM-style)
      const totalPool = market.yesPool + market.noPool;
      if (totalPool > 0) {
        market.yesOdds = market.noPool / totalPool;
        market.noOdds = market.yesPool / totalPool;
      }

      market.totalVolume = (market.totalVolume || 0) + lamportsEquiv;
      market.totalBets = (market.totalBets || 0) + 1;

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

      res.json({
        success: true,
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

      // Recalculate odds
      const totalPool = market.yesPool + market.noPool;
      if (totalPool > 0) {
        market.yesOdds = market.noPool / totalPool;
        market.noOdds = market.yesPool / totalPool;
      }

      market.totalVolume = lamportsEquiv;
      market.totalBets = 1;

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
    const actionUrl = `${baseUrl}/api/actions/bet/${marketId}`;
    const blinkUrl = `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`;

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
  const requirements = x402.buildBetPaymentRequirements({
    amountUSDC,
    marketId,
    outcome: betOutcome,
    network: 'eip155:84532' // Testnet
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
        ? amountUSDC / market.yesOdds
        : amountUSDC / market.noOdds
    },
    x402: {
      payTo: x402.getPayToAddress(),
      network: 'eip155:84532',
      networkName: 'Base Sepolia (testnet)',
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

// Serve frontend in production mode
// This serves the built React app from frontend/dist
const frontendPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendPath));

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
