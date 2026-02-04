/**
 * AgentBets API Server
 * Prediction Markets for AI Agent Outcomes on Solana
 * Built by Butters (@AIButters) for Colosseum Agent Hackathon
 */

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

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

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files for actions.json
const path = require('path');
app.use(express.static(path.join(__dirname, '../public')));

// Mount Solana Actions router
app.use('/api/actions', actionsRouter);

// Solana connection
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Platform escrow wallet (in production, this would be a PDA)
const ESCROW_WALLET = process.env.ESCROW_WALLET || 'Ds9gRNjHufEa918D2HJSbE9AQo8wpqsor9g8rbH6Xwfw';

// In-memory storage (replace with PostgreSQL in production)
const markets = new Map();
const bets = new Map();
const positions = new Map();

// Expose storage to routers via app.locals
app.locals.markets = markets;
app.locals.bets = bets;
app.locals.positions = positions;

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

    const marketId = uuidv4();
    const now = new Date().toISOString();

    const market = {
      id: marketId,
      question,
      description: description || '',
      category: category || 'general', // performance, competition, token, milestone, head-to-head, app
      outcomes: ['YES', 'NO'],
      resolutionSource: resolutionSource || 'manual',
      endDate,
      createdAt: now,
      creatorWallet: creatorWallet || null,
      creatorAgent: creatorAgent || null,
      status: 'active', // active, resolved, cancelled
      resolution: null, // YES, NO, or null
      resolvedAt: null,

      // Enhanced verification info
      verificationUrl: req.body.verificationUrl || null, // URL to verify outcome
      verificationMethod: req.body.verificationMethod || null, // How outcome is verified
      threshold: req.body.threshold || null, // Target value for resolution
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
app.get('/api/markets', (req, res) => {
  const { status, category, limit = 50 } = req.query;

  let results = Array.from(markets.values());

  if (status) {
    results = results.filter(m => m.status === status);
  }

  if (category) {
    results = results.filter(m => m.category === category);
  }

  // Sort by volume (most active first)
  results.sort((a, b) => b.totalVolume - a.totalVolume);

  res.json({
    markets: results.slice(0, parseInt(limit)),
    total: results.length
  });
});

/**
 * Get market by ID
 * GET /api/markets/:id
 */
app.get('/api/markets/:id', (req, res) => {
  const market = markets.get(req.params.id);

  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }

  // Get bets for this market
  const marketBets = Array.from(bets.values()).filter(b => b.marketId === market.id);

  res.json({
    ...market,
    bets: marketBets,
    betCount: marketBets.length
  });
});

/**
 * Resolve a market
 * PUT /api/markets/:id/resolve
 */
app.put('/api/markets/:id/resolve', async (req, res) => {
  try {
    const { resolution, resolverWallet } = req.body;
    const market = markets.get(req.params.id);

    if (!market) {
      return res.status(404).json({ error: 'Market not found' });
    }

    if (market.status !== 'active') {
      return res.status(400).json({ error: 'Market already resolved or cancelled' });
    }

    if (!['YES', 'NO'].includes(resolution)) {
      return res.status(400).json({ error: 'Resolution must be YES or NO' });
    }

    // Update market
    market.resolution = resolution;
    market.status = 'resolved';
    market.resolvedAt = new Date().toISOString();
    market.resolverWallet = resolverWallet;

    markets.set(market.id, market);

    // Calculate payouts with creator royalties
    const marketBets = Array.from(bets.values()).filter(b => b.marketId === market.id);
    const winningBets = marketBets.filter(b => b.outcome === resolution);
    const losingPool = resolution === 'YES' ? market.noPool : market.yesPool;
    const winningPool = resolution === 'YES' ? market.yesPool : market.noPool;

    // Track total royalties for this resolution
    let totalCreatorRoyalty = 0;
    let totalPlatformFee = 0;

    // Calculate each winner's share with royalty deduction
    const payouts = winningBets.map(bet => {
      const share = bet.amount / winningPool;
      const grossWinnings = bet.amount + (share * losingPool);

      // Calculate royalties for this payout
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

    // Royalty summary
    const royaltySummary = {
      creatorAgent: market.creatorAgent,
      creatorRoyalty: totalCreatorRoyalty,
      creatorRoyaltySOL: totalCreatorRoyalty / LAMPORTS_PER_SOL,
      platformFee: totalPlatformFee,
      platformFeeSOL: totalPlatformFee / LAMPORTS_PER_SOL,
      feeBreakdown: '1% total fee: 0.3% to creator, 0.7% to platform'
    };

    res.json({
      success: true,
      market,
      resolution,
      payouts,
      royalties: royaltySummary,
      message: `Market resolved: ${resolution}! ${winningBets.length} winners. Creator @${market.creatorAgent || 'unknown'} earned ${royaltySummary.creatorRoyaltySOL.toFixed(4)} SOL in royalties!`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// BETTING ENDPOINTS
// ==========================================

/**
 * Place a bet
 * POST /api/bets
 */
app.post('/api/bets', async (req, res) => {
  try {
    const { marketId, outcome, amount, wallet, txSignature } = req.body;

    if (!marketId || !outcome || !amount || !wallet) {
      return res.status(400).json({
        error: 'marketId, outcome, amount, and wallet are required'
      });
    }

    const market = markets.get(marketId);
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

    const amountLamports = Math.floor(amount * LAMPORTS_PER_SOL);

    // In production: verify txSignature on-chain
    // For MVP: trust the client (or verify via RPC)

    const betId = uuidv4();
    const bet = {
      id: betId,
      marketId,
      outcome,
      amount: amountLamports,
      amountSOL: amount,
      wallet,
      txSignature: txSignature || null,
      placedAt: new Date().toISOString(),
      status: 'active' // active, won, lost, claimed
    };

    bets.set(betId, bet);

    // Update market pools
    if (outcome === 'YES') {
      market.yesPool += amountLamports;
    } else {
      market.noPool += amountLamports;
    }
    market.totalVolume += amountLamports;
    market.totalBets += 1;

    // Recalculate odds
    const totalPool = market.yesPool + market.noPool;
    if (totalPool > 0) {
      market.yesOdds = market.noPool / totalPool; // Payout ratio for YES
      market.noOdds = market.yesPool / totalPool; // Payout ratio for NO
    }

    markets.set(marketId, market);

    // Update user positions
    const positionKey = `${wallet}-${marketId}-${outcome}`;
    const existingPosition = positions.get(positionKey) || {
      wallet,
      marketId,
      outcome,
      totalBet: 0,
      bets: []
    };
    existingPosition.totalBet += amountLamports;
    existingPosition.bets.push(betId);
    positions.set(positionKey, existingPosition);

    res.status(201).json({
      success: true,
      bet,
      market: {
        id: market.id,
        yesPool: market.yesPool / LAMPORTS_PER_SOL,
        noPool: market.noPool / LAMPORTS_PER_SOL,
        yesOdds: market.yesOdds,
        noOdds: market.noOdds
      },
      message: `Bet placed! ${amount} SOL on ${outcome} 🎰`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get user's bets
 * GET /api/bets/user/:wallet
 */
app.get('/api/bets/user/:wallet', (req, res) => {
  const userBets = Array.from(bets.values())
    .filter(b => b.wallet === req.params.wallet)
    .map(bet => {
      const market = markets.get(bet.marketId);
      return {
        ...bet,
        market: market ? {
          question: market.question,
          status: market.status,
          resolution: market.resolution
        } : null
      };
    });

  res.json({
    wallet: req.params.wallet,
    bets: userBets,
    totalBets: userBets.length
  });
});

/**
 * Get bets for a market
 * GET /api/bets/market/:id
 */
app.get('/api/bets/market/:id', (req, res) => {
  const marketBets = Array.from(bets.values())
    .filter(b => b.marketId === req.params.id);

  const yesBets = marketBets.filter(b => b.outcome === 'YES');
  const noBets = marketBets.filter(b => b.outcome === 'NO');

  res.json({
    marketId: req.params.id,
    bets: marketBets,
    summary: {
      totalBets: marketBets.length,
      yesBets: yesBets.length,
      noBets: noBets.length,
      yesVolume: yesBets.reduce((sum, b) => sum + b.amountSOL, 0),
      noVolume: noBets.reduce((sum, b) => sum + b.amountSOL, 0)
    }
  });
});

// ==========================================
// POSITION & CLAIM ENDPOINTS
// ==========================================

/**
 * Get user's positions
 * GET /api/positions/:wallet
 */
app.get('/api/positions/:wallet', (req, res) => {
  const userPositions = Array.from(positions.values())
    .filter(p => p.wallet === req.params.wallet)
    .map(pos => {
      const market = markets.get(pos.marketId);
      let status = 'active';
      let potentialWinnings = 0;

      if (market && market.status === 'resolved') {
        status = pos.outcome === market.resolution ? 'won' : 'lost';
        if (status === 'won') {
          const winningPool = market.resolution === 'YES' ? market.yesPool : market.noPool;
          const losingPool = market.resolution === 'YES' ? market.noPool : market.yesPool;
          const share = pos.totalBet / winningPool;
          potentialWinnings = pos.totalBet + (share * losingPool * 0.99);
        }
      } else if (market) {
        // Calculate potential winnings if they win
        const pool = pos.outcome === 'YES' ? market.yesPool : market.noPool;
        const oppositePool = pos.outcome === 'YES' ? market.noPool : market.yesPool;
        if (pool > 0) {
          const share = pos.totalBet / pool;
          potentialWinnings = pos.totalBet + (share * oppositePool * 0.99);
        }
      }

      return {
        ...pos,
        totalBetSOL: pos.totalBet / LAMPORTS_PER_SOL,
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
    });

  res.json({
    wallet: req.params.wallet,
    positions: userPositions,
    totalPositions: userPositions.length
  });
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
    const market = markets.get(marketId);

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
  const market = markets.get(req.params.marketId);

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
  const market = markets.get(req.params.marketId);

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
app.get('/api/leaderboard', (req, res) => {
  // Calculate win/loss record for each wallet
  const walletStats = new Map();

  bets.forEach(bet => {
    const market = markets.get(bet.marketId);
    if (!market || market.status !== 'resolved') return;

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
    stats.totalWagered += bet.amountSOL;

    if (bet.outcome === market.resolution) {
      stats.wins += 1;
      // Calculate winnings
      const winningPool = market.resolution === 'YES' ? market.yesPool : market.noPool;
      const losingPool = market.resolution === 'YES' ? market.noPool : market.yesPool;
      const share = bet.amount / winningPool;
      const winnings = (bet.amount + (share * losingPool * 0.99)) / LAMPORTS_PER_SOL;
      stats.totalWon += winnings;
      stats.profit += (winnings - bet.amountSOL);
    } else {
      stats.losses += 1;
      stats.profit -= bet.amountSOL;
    }

    walletStats.set(bet.wallet, stats);
  });

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

    const market = markets.get(marketId);
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
 * Note: This endpoint creates the instruction for client-side signing
 * The user needs SOL for gas to create their account
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

    // Return information about how to initialize
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
app.post('/api/onchain/markets', async (req, res) => {
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
      tags
    } = req.body;

    if (!question || !endDate) {
      return res.status(400).json({ error: 'Question and endDate are required' });
    }

    if (question.length > 256) {
      return res.status(400).json({ error: 'Question must be 256 characters or less' });
    }

    // Create on-chain market with creator resolution (our oracle decides)
    const result = await pollFunService.createMarket({
      question,
      expectedUserCount: Math.min(expectedUserCount, 50), // Max 50 users per Poll.fun
      minimumVoteCount: 1 // Not used since isCreatorResolver=true
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    // Also store in local database for tracking
    const marketId = uuidv4();
    const now = new Date().toISOString();

    const market = {
      id: marketId,
      betPda: result.betPda, // On-chain PDA
      question,
      description: description || '',
      category: category || 'general',
      outcomes: ['YES', 'NO'],
      resolutionSource: 'pollfun', // On-chain resolution
      endDate,
      createdAt: now,
      creatorWallet: result.creator,
      status: 'active',
      resolution: null,
      resolvedAt: null,
      verificationUrl: verificationUrl || null,
      verificationMethod: verificationMethod || null,
      threshold: threshold || null,
      tags: tags || [],
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
      currency: 'USDC'
    };

    markets.set(marketId, market);

    res.status(201).json({
      success: true,
      market,
      onChainData: {
        betPda: result.betPda,
        txSignature: result.txSignature,
        network: pollFunService.network
      },
      message: `On-chain market created! Bet with USDC on: "${question}"`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Create a wager transaction for user to sign
 * POST /api/onchain/wager
 */
app.post('/api/onchain/wager', async (req, res) => {
  try {
    const { marketId, betPda, outcome, amount, wallet } = req.body;

    if ((!marketId && !betPda) || !outcome || !amount || !wallet) {
      return res.status(400).json({
        error: 'marketId or betPda, outcome, amount, and wallet are required'
      });
    }

    // Get betPda from market if not provided directly
    let pdaAddress = betPda;
    let market = null;

    if (marketId) {
      market = markets.get(marketId);
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

    // Build wager instruction for client-side signing
    const result = await pollFunService.buildWagerInstruction({
      betPda: pdaAddress,
      side: outcome, // 'YES' or 'NO'
      amount,
      userPubkey: wallet
    });

    if (!result.success) {
      return res.status(500).json({ error: result.error });
    }

    res.json({
      success: true,
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
      instructions: 'Build a transaction with this instruction and sign with your wallet. User must have a Poll.fun account first.'
    });
  } catch (error) {
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
      market = markets.get(marketId);
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
      const market = markets.get(marketId);
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
      market = markets.get(marketId);
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
      message: errorCount === 0
        ? `Successfully settled all ${totalBatches} batches for ${totalUsers} users!`
        : `Settled ${successCount}/${totalBatches} batches with ${errorCount} errors`
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
 * Get agent's earnings balance
 * GET /api/royalties/:agentHandle
 */
app.get('/api/royalties/:agentHandle', (req, res) => {
  const data = royalties.getAgentRoyalties(req.params.agentHandle);
  res.json(data);
});

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

// ==========================================
// SOLANA ACTIONS / BLINKS ENDPOINTS
// ==========================================

/**
 * Get Blink URL for a market
 * GET /api/blink/:marketId
 */
app.get('/api/blink/:marketId', (req, res) => {
  const market = markets.get(req.params.marketId);

  if (!market) {
    return res.status(404).json({ error: 'Market not found' });
  }

  const baseUrl = process.env.API_BASE_URL || `https://3002-capy-1769786465404-780459-preview.happycapy.ai`;
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
  const baseUrl = process.env.API_BASE_URL || `https://3002-capy-1769786465404-780459-preview.happycapy.ai`;
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
    network: process.env.SOLANA_NETWORK || 'devnet'
  });
});

app.get('/api/stats', (req, res) => {
  const allMarkets = Array.from(markets.values());
  const allBets = Array.from(bets.values());

  const totalVolume = allMarkets.reduce((sum, m) => sum + m.totalVolume, 0);
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
      totalVolume: totalVolume / LAMPORTS_PER_SOL
    },
    uniqueWallets: new Set(allBets.map(b => b.wallet)).size
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'AgentBets API',
    version: '1.0.0',
    network: 'solana-devnet',
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
    network: process.env.SOLANA_NETWORK || 'devnet',
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

// Initialize test markets on startup
function initializeTestMarkets() {
  const testMarkets = [
    {
      id: uuidv4(),
      question: "Will Butters finish top 3 in Colosseum Solana Agent Hackathon?",
      description: "Resolution based on official Colosseum hackathon results announcement.",
      category: "competition",
      outcomes: ["YES", "NO"],
      resolutionSource: "colosseum",
      verificationUrl: "https://www.colosseum.org/hackathon",
      verificationMethod: "Official Colosseum announcement of hackathon winners",
      threshold: "Top 3 placement",
      tags: ["hackathon", "butters", "colosseum"],
      endDate: new Date("2026-02-12T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 1000000000,
      noPool: 500000000,
      totalVolume: 1500000000,
      totalBets: 2,
      yesOdds: 0.333,
      noOdds: 0.667
    },
    {
      id: uuidv4(),
      question: "Will CrabKarmaBot reach 75K Karma by Feb 10, 2026?",
      description: "Verified via CrabKarmaBot's Moltbook profile karma count at end date.",
      category: "milestone",
      outcomes: ["YES", "NO"],
      resolutionSource: "moltbook",
      verificationUrl: "https://www.moltbook.com/u/crabkarmabot",
      verificationMethod: "Check karma count on Moltbook profile page at resolution time",
      threshold: "75,000 karma",
      tags: ["moltbook", "karma", "crabkarmabot"],
      endDate: new Date("2026-02-10T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    {
      id: uuidv4(),
      question: "Will Moltbook cross 2M agents by Feb 12, 2026?",
      description: "Verified via Moltbook homepage agent counter.",
      category: "app",
      outcomes: ["YES", "NO"],
      resolutionSource: "moltbook",
      verificationUrl: "https://www.moltbook.com/",
      verificationMethod: "Check total agent count displayed on Moltbook homepage",
      threshold: "2,000,000 agents",
      tags: ["moltbook", "agents", "growth"],
      endDate: new Date("2026-02-12T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    {
      id: uuidv4(),
      question: "How many Submolts on Feb 16, 2026? Over/Under 25,000",
      description: "Bet YES for Over 25,000 submolts, NO for Under 25,000. Verified via Moltbook.",
      category: "app",
      outcomes: ["YES", "NO"],
      resolutionSource: "moltbook",
      verificationUrl: "https://www.moltbook.com/",
      verificationMethod: "Check submolt count on Moltbook platform. YES = Over 25K, NO = Under 25K",
      threshold: "25,000 submolts",
      tags: ["moltbook", "submolts", "over-under"],
      endDate: new Date("2026-02-16T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    {
      id: uuidv4(),
      question: "Will $BUTTERS token reach $100K market cap by Feb 15, 2026?",
      description: "Resolution via DexScreener price data for $BUTTERS token.",
      category: "token",
      outcomes: ["YES", "NO"],
      resolutionSource: "dexscreener",
      verificationUrl: "https://dexscreener.com/solana/butters",
      verificationMethod: "Check market cap on DexScreener at resolution time",
      threshold: "$100,000 market cap",
      tags: ["token", "butters", "price"],
      endDate: new Date("2026-02-15T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    {
      id: uuidv4(),
      question: "Head-to-Head: Will @AIButters gain more X followers than @ClawdKrab this week?",
      description: "Compare follower delta between both accounts from Feb 3-9, 2026.",
      category: "head-to-head",
      outcomes: ["YES", "NO"],
      resolutionSource: "x-api",
      verificationUrl: "https://x.com/AIButters",
      verificationMethod: "Compare X follower count change for @AIButters vs @ClawdKrab between Feb 3-9",
      threshold: "Higher follower gain",
      tags: ["x", "followers", "head-to-head", "butters", "clawdkrab"],
      endDate: new Date("2026-02-09T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    {
      id: uuidv4(),
      question: "Will AgentBets reach 100+ unique users by Feb 28, 2026?",
      description: "Based on unique wallet addresses that have placed bets on the platform.",
      category: "milestone",
      outcomes: ["YES", "NO"],
      resolutionSource: "manual",
      verificationUrl: "https://agentbets.gg",
      verificationMethod: "Count unique wallet addresses in AgentBets database",
      threshold: "100 unique wallets",
      tags: ["agentbets", "users", "milestone"],
      endDate: new Date("2026-02-28T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    // AIXBT & Major Agents
    {
      id: uuidv4(),
      question: "Will $AIXBT reach $2B market cap by March 2026?",
      description: "The leading AI agent token. Resolution via DexScreener.",
      category: "token",
      outcomes: ["YES", "NO"],
      resolutionSource: "dexscreener",
      verificationUrl: "https://dexscreener.com/base/aixbt",
      verificationMethod: "Check AIXBT market cap on DexScreener",
      threshold: "$2,000,000,000",
      tags: ["aixbt", "token", "ai16z"],
      endDate: new Date("2026-03-01T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@aixbt_agent",
      status: "active",
      yesPool: 800000000,
      noPool: 400000000,
      totalVolume: 1200000000,
      totalBets: 8,
      yesOdds: 0.333,
      noOdds: 0.667
    },
    {
      id: uuidv4(),
      question: "Will @truth_terminal post more than 100 tweets in Feb 2026?",
      description: "Total tweet count for February 2026.",
      category: "performance",
      outcomes: ["YES", "NO"],
      resolutionSource: "x-api",
      verificationUrl: "https://x.com/truth_terminal",
      verificationMethod: "Count tweets posted between Feb 1-28, 2026",
      threshold: "100 tweets",
      tags: ["truth_terminal", "x", "tweets"],
      endDate: new Date("2026-02-28T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@truth_terminal",
      status: "active",
      yesPool: 200000000,
      noPool: 300000000,
      totalVolume: 500000000,
      totalBets: 5,
      yesOdds: 0.6,
      noOdds: 0.4
    },
    // Hackathon Markets
    {
      id: uuidv4(),
      question: "Will AgentBets win the Colosseum Hackathon Grand Prize ($50K)?",
      description: "The moment of truth! Built by @AIButters.",
      category: "competition",
      outcomes: ["YES", "NO"],
      resolutionSource: "colosseum",
      verificationUrl: "https://colosseum.com/agent-hackathon/",
      verificationMethod: "Check official hackathon results announcement",
      threshold: "Grand Prize Winner",
      tags: ["hackathon", "colosseum", "agentbets", "competition"],
      endDate: new Date("2026-02-12T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 500000000,
      noPool: 100000000,
      totalVolume: 600000000,
      totalBets: 6,
      yesOdds: 0.167,
      noOdds: 0.833
    },
    {
      id: uuidv4(),
      question: "Will there be 50+ hackathon submissions to Colosseum Agent Hackathon?",
      description: "Total project submissions by deadline.",
      category: "competition",
      outcomes: ["YES", "NO"],
      resolutionSource: "colosseum",
      verificationUrl: "https://colosseum.com/agent-hackathon/",
      verificationMethod: "Check total submissions on Colosseum",
      threshold: "50 submissions",
      tags: ["hackathon", "colosseum", "submissions"],
      endDate: new Date("2026-02-12T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@AIButters",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    // Virtuals & Gaming Agents
    {
      id: uuidv4(),
      question: "Will @luna_virtuals reach 100K followers by Feb 20?",
      description: "Luna from Virtuals Protocol.",
      category: "performance",
      outcomes: ["YES", "NO"],
      resolutionSource: "x-api",
      verificationUrl: "https://x.com/luna_virtuals",
      verificationMethod: "Check X follower count",
      threshold: "100,000 followers",
      tags: ["virtuals", "luna", "followers"],
      endDate: new Date("2026-02-20T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@luna_virtuals",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    // Zerebro & AI Art
    {
      id: uuidv4(),
      question: "Will @zerebro NFT floor price exceed 1 SOL by Feb 15?",
      description: "Zerebro AI-generated art collection.",
      category: "token",
      outcomes: ["YES", "NO"],
      resolutionSource: "manual",
      verificationUrl: "https://magiceden.io/marketplace/zerebro",
      verificationMethod: "Check floor price on Magic Eden",
      threshold: "1 SOL floor",
      tags: ["zerebro", "nft", "art"],
      endDate: new Date("2026-02-15T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@zerebro",
      status: "active",
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5
    },
    // AI Framework Markets
    {
      id: uuidv4(),
      question: "Will Eliza framework reach 10K GitHub stars by March 2026?",
      description: "ai16z's Eliza agent framework.",
      category: "milestone",
      outcomes: ["YES", "NO"],
      resolutionSource: "github",
      verificationUrl: "https://github.com/ai16z/eliza",
      verificationMethod: "Check GitHub star count",
      threshold: "10,000 stars",
      tags: ["eliza", "ai16z", "github", "framework"],
      endDate: new Date("2026-03-01T23:59:59Z").toISOString(),
      createdAt: new Date().toISOString(),
      creatorAgent: "@ai16zdao",
      status: "active",
      yesPool: 150000000,
      noPool: 50000000,
      totalVolume: 200000000,
      totalBets: 3,
      yesOdds: 0.25,
      noOdds: 0.75
    }
  ];

  testMarkets.forEach(market => {
    markets.set(market.id, market);
  });

  console.log(`[AgentBets] Initialized ${testMarkets.length} test markets`);
}

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

// Start server
app.listen(PORT, () => {
  // Initialize test markets
  initializeTestMarkets();

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║          🎰 AgentBets API Server Running 🎰              ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                               ║
║  Network: Solana Devnet                                   ║
║  Escrow: ${ESCROW_WALLET.slice(0,8)}...                              ║
║                                                           ║
║  Prediction Markets for AI Agent Outcomes                 ║
║  Built by Butters (@AIButters) 🦞                        ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
