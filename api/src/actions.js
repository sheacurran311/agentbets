/**
 * Solana Actions (Blinks) for AgentBets
 *
 * Universal betting interface for both humans (via X/Twitter) and AI agents (via Moltbook/URL)
 * All bets use USDC via Poll.fun SDK for on-chain settlement
 *
 * https://solana.com/developers/guides/advanced/actions
 *
 * Action URL format: solana-action:https://agentbets.gg/api/actions/bet/{marketId}
 * Blink URL format: https://dial.to/?action=solana-action%3Ahttps%3A%2F%2Fagentbets.gg%2Fapi%2Factions%2Fbet%2F{marketId}
 *
 * Agent Usage (Moltbook, etc.):
 *   1. GET /api/actions/bet/{marketId} - Get market info and bet options
 *   2. POST /api/actions/bet/{marketId}/place - Get unsigned USDC wager transaction
 *   3. Sign transaction with agent's Solana wallet
 *   4. Submit signed transaction on-chain
 */

const express = require('express');
const { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL, Connection } = require('@solana/web3.js');

// Poll.fun SDK for on-chain USDC wagers
const { pollFunService } = require('./pollfun');
// Gasless relay for USDC-only transactions (no SOL needed)
const { gaslessService } = require('./gasless');

const router = express.Router();

// Solana connection for transaction building
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// CORS headers required for Solana Actions
const ACTION_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding',
  'Content-Type': 'application/json'
};

// Platform config
// Icon served from api/public/icon.png - use relative path for local dev, full URL for production
const AGENTBETS_ICON = process.env.AGENTBETS_URL 
  ? `${process.env.AGENTBETS_URL}/icon.png`
  : '/icon.png';
const AGENTBETS_TITLE = 'AgentBets';
const ESCROW_WALLET = process.env.ESCROW_WALLET || '48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM';

/**
 * CORS preflight for all actions
 */
router.options('*', (req, res) => {
  res.set(ACTION_CORS_HEADERS);
  res.status(200).end();
});

/**
 * GET /api/actions/bet/:marketId
 * Returns Action metadata for a specific market
 * 
 * Works for both human Blink clients and programmatic agent access
 */
router.get('/bet/:marketId', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const { marketId } = req.params;
    const market = await req.app.locals.markets?.get(marketId);

    if (!market) {
      return res.status(404).json({
        error: { message: 'Market not found' }
      });
    }

    if (market.status !== 'active') {
      return res.json({
        type: 'completed',
        icon: AGENTBETS_ICON,
        title: 'Market Closed',
        description: `This market has been resolved: ${market.resolution || 'N/A'}`,
        label: 'Closed',
        disabled: true
      });
    }

    // Check if market is on-chain (has Poll.fun betPda)
    const isOnChain = !!market.betPda;
    
    // Get on-chain data if available
    let onChainData = null;
    if (isOnChain) {
      try {
        onChainData = await pollFunService.getMarketData(market.betPda);
      } catch (err) {
        console.warn('[Actions] Could not fetch on-chain data:', err.message);
      }
    }

    // Use on-chain data for pools if available, otherwise use local data
    const yesPool = onChainData?.success ? onChainData.yesPool : (market.yesPool || 0) / 1e6;
    const noPool = onChainData?.success ? onChainData.noPool : (market.noPool || 0) / 1e6;
    const totalPool = yesPool + noPool;

    // Calculate odds (probability-based)
    const yesOdds = totalPool > 0 ? yesPool / totalPool : 0.5;
    const noOdds = totalPool > 0 ? noPool / totalPool : 0.5;
    const yesPercent = (yesOdds * 100).toFixed(0);
    const noPercent = (noOdds * 100).toFixed(0);

    // Build action response - USDC amounts
    const action = {
      type: 'action',
      icon: AGENTBETS_ICON,
      title: AGENTBETS_TITLE,
      description: market.question,
      label: 'Place Bet',
      links: {
        actions: [
          {
            label: `YES (${yesPercent}%)`,
            href: `/api/actions/bet/${marketId}/place?outcome=YES&amount={amount}`,
            parameters: [
              {
                name: 'amount',
                label: 'Amount (USDC)',
                type: 'number',
                required: true,
                min: 1,
                max: 1000,
                patternDescription: 'Enter bet amount between 1 and 1000 USDC'
              }
            ]
          },
          {
            label: `NO (${noPercent}%)`,
            href: `/api/actions/bet/${marketId}/place?outcome=NO&amount={amount}`,
            parameters: [
              {
                name: 'amount',
                label: 'Amount (USDC)',
                type: 'number',
                required: true,
                min: 1,
                max: 1000,
                patternDescription: 'Enter bet amount between 1 and 1000 USDC'
              }
            ]
          }
        ]
      }
    };

    // Add market stats to description
    if (totalPool > 0) {
      action.description += `\n\nPool: ${totalPool.toFixed(2)} USDC | Bets: ${onChainData?.currentUserCount || market.totalBets || 0}`;
    }

    // Add end date
    const endDate = new Date(market.endDate);
    action.description += `\nEnds: ${endDate.toLocaleDateString()}`;

    // Creator info
    if (market.creatorAgent) {
      action.description += `\nCreated by: ${market.creatorAgent}`;
    }

    // Add on-chain status
    if (isOnChain) {
      action.description += `\n\nOn-chain via Poll.fun`;
    } else {
      action.description += `\n\nNote: This market is not yet on-chain. Contact @AgentBetsBot to create on-chain markets.`;
    }

    res.json(action);

  } catch (error) {
    console.error('[Actions] Error getting market action:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * POST /api/actions/bet/:marketId/place
 * Creates a USDC wager transaction for the user to sign via Poll.fun SDK
 * 
 * Works for both human Blink clients and programmatic agent access (Moltbook, etc.)
 */
router.post('/bet/:marketId/place', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const { marketId } = req.params;
    const { outcome, amount } = req.query;
    const { account } = req.body;

    // Validate inputs
    if (!account) {
      return res.status(400).json({
        error: { message: 'Missing account in request body' }
      });
    }

    if (!outcome || !['YES', 'NO'].includes(outcome)) {
      return res.status(400).json({
        error: { message: 'Invalid outcome. Must be YES or NO' }
      });
    }

    const betAmount = parseFloat(amount);
    if (isNaN(betAmount) || betAmount < 1 || betAmount > 1000) {
      return res.status(400).json({
        error: { message: 'Invalid amount. Must be between 1 and 1000 USDC' }
      });
    }

    const market = await req.app.locals.markets?.get(marketId);
    if (!market) {
      return res.status(404).json({
        error: { message: 'Market not found' }
      });
    }

    if (market.status !== 'active') {
      return res.status(400).json({
        error: { message: 'Market is not active' }
      });
    }

    if (new Date(market.endDate) < new Date()) {
      return res.status(400).json({
        error: { message: 'Market has ended' }
      });
    }

    // Check if market is on-chain
    if (!market.betPda) {
      return res.status(400).json({
        error: { 
          message: 'Market is not on-chain yet. Mention @AgentBetsBot on X to create an on-chain market.',
          code: 'MARKET_NOT_ONCHAIN'
        }
      });
    }

    const userPubkey = new PublicKey(account);

    // Determine if gasless mode is available (for choosing the fee payer)
    const gaslessAvailable = gaslessService.enabled && gaslessService.feePayerKeypair;
    const feePayerOverride = gaslessAvailable
      ? gaslessService.feePayerKeypair.publicKey  // API pays SOL rent in gasless mode
      : userPubkey;                                // User pays SOL rent otherwise

    // AUTO: Check if user has a Poll.fun account, include init instruction if not
    let userInitIx = null;
    try {
      const userData = await pollFunService.getUserData(account);
      if (!userData.success) {
        // Only add init instruction if account truly doesn't exist (not just an RPC error)
        const errorLower = (userData.error || '').toLowerCase();
        const accountNotExists = errorLower.includes('account does not exist') || 
                                  errorLower.includes('could not find') ||
                                  errorLower.includes('not found') ||
                                  errorLower.includes('invalid account');
        
        if (accountNotExists) {
          console.log(`[Actions] User ${account.slice(0, 8)}... needs Poll.fun account, including init instruction`);
          userInitIx = await pollFunService.sdk.instructions.initializeUserIx({
            payerOverride: userPubkey,        // owner = the actual user's wallet
            feePayerOverride: feePayerOverride // SOL payer = API wallet in gasless mode
          });
        } else {
          console.log(`[Actions] User account check returned error (may exist): ${userData.error}`);
        }
      } else {
        console.log(`[Actions] User ${account.slice(0, 8)}... already has Poll.fun account`);
      }
    } catch (err) {
      // Only include init instruction if error suggests account doesn't exist
      const errorLower = err.message.toLowerCase();
      if (errorLower.includes('account does not exist') || 
          errorLower.includes('could not find') ||
          errorLower.includes('not found')) {
        console.log(`[Actions] User account check failed (not found), including init instruction: ${err.message}`);
        try {
          userInitIx = await pollFunService.sdk.instructions.initializeUserIx({
            payerOverride: userPubkey,        // owner = the actual user's wallet
            feePayerOverride: feePayerOverride // SOL payer = API wallet in gasless mode
          });
        } catch (initErr) {
          console.warn(`[Actions] Could not build user init instruction: ${initErr.message}`);
        }
      } else {
        console.log(`[Actions] User account check failed (unknown error, skipping init): ${err.message}`);
      }
    }

    // Build Poll.fun USDC wager instruction
    console.log(`[Actions] Building USDC wager: ${betAmount} USDC on ${outcome} for market ${marketId}`);
    
    const wagerResult = await pollFunService.buildWagerInstruction({
      betPda: market.betPda,
      side: outcome,
      amount: betAmount,
      userPubkey: account,
      feePayerPubkey: gaslessAvailable ? gaslessService.feePayerKeypair.publicKey.toBase58() : undefined
    });

    if (!wagerResult.success) {
      // Check for common errors
      if (wagerResult.error?.includes('User account not found') || 
          wagerResult.error?.includes('AccountNotInitialized') ||
          wagerResult.error?.includes('Account does not exist')) {
        return res.status(400).json({
          error: { 
            message: 'You need a Poll.fun account first. Visit https://poll.fun to create one, or we can create it for you.',
            code: 'USER_ACCOUNT_REQUIRED',
            hint: 'The first bet will auto-create your Poll.fun account'
          }
        });
      }
      return res.status(500).json({
        error: { message: `Failed to build wager: ${wagerResult.error}` }
      });
    }

    // Build transaction with the Poll.fun instruction
    const transaction = new Transaction();
    // If user needs account initialization, add it as a pre-instruction
    if (userInitIx) {
      console.log(`[Actions] Including user account initialization instruction`);
      transaction.add(userInitIx);
    }
    transaction.add(wagerResult.instruction);

    // Determine if gasless mode is enabled
    const useGasless = req.query.gasless !== 'false' && gaslessService.enabled && gaslessService.feePayerKeypair;

    let serializedTransaction;

    if (useGasless) {
      // Gasless: API pays SOL gas, user pays small USDC fee
      console.log(`[Actions] Using gasless relay — user pays ${gaslessService.feeUsdc} USDC fee instead of SOL`);
      const wrapped = await gaslessService.wrapWithGasless(transaction, userPubkey);
      serializedTransaction = wrapped.transaction;
    } else {
      // Traditional: user pays SOL gas
      transaction.feePayer = userPubkey;
      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      serializedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false
      }).toString('base64');
    }

    // Calculate potential payout using Poll.fun data
    const marketData = await pollFunService.getMarketData(market.betPda);
    let potentialPayout = betAmount * 2; // Default estimate
    if (marketData.success) {
      const payoutCalc = pollFunService.calculatePotentialPayout(marketData, outcome, betAmount);
      potentialPayout = payoutCalc.potentialWinnings;
    }

    console.log(`[Actions] USDC wager transaction built for ${account.slice(0, 8)}... (gasless: ${useGasless})`);

    res.json({
      transaction: serializedTransaction,
      message: useGasless
        ? `Bet ${betAmount} USDC on ${outcome} (no SOL needed, ${gaslessService.feeUsdc} USDC gas fee) - "${market.question.substring(0, 50)}..."`
        : `Bet ${betAmount} USDC on ${outcome} - "${market.question.substring(0, 50)}..."`,
      gasless: useGasless,
      gasFee: useGasless ? gaslessService.feeUsdc : null,
      links: {
        next: {
          type: 'post',
          href: `/api/actions/bet/${marketId}/confirm?outcome=${outcome}&amount=${betAmount}`
        }
      }
    });

  } catch (error) {
    console.error('[Actions] Error creating bet transaction:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * POST /api/actions/bet/:marketId/confirm
 * Confirms a bet after transaction signature
 * Called automatically by Blink client after successful signing
 * 
 * For on-chain bets via Poll.fun, the transaction is already recorded on-chain.
 * This endpoint updates local tracking and returns success confirmation.
 */
router.post('/bet/:marketId/confirm', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const { marketId } = req.params;
    const { outcome, amount } = req.query;
    const { signature, account } = req.body;

    if (!signature || !account) {
      return res.status(400).json({
        error: { message: 'Missing signature or account' }
      });
    }

    const market = await req.app.locals.markets?.get(marketId);
    if (!market) {
      return res.status(404).json({
        error: { message: 'Market not found' }
      });
    }

    const betAmount = parseFloat(amount);
    const amountUsdc = betAmount * 1e6; // USDC has 6 decimals

    console.log(`[Actions] Confirming USDC wager: ${betAmount} USDC on ${outcome} - tx: ${signature.slice(0, 16)}...`);

    // Record the bet in our local system for tracking
    const bets = req.app.locals.bets;
    const positions = req.app.locals.positions;

    if (bets && positions) {
      const { v4: uuidv4 } = require('uuid');
      const betId = uuidv4();

      const bet = {
        id: betId,
        marketId,
        outcome,
        amount: amountUsdc,
        amountUSDC: betAmount,
        currency: 'USDC',
        wallet: account,
        txSignature: signature,
        betPda: market.betPda,
        placedAt: new Date().toISOString(),
        status: 'active',
        source: 'blink', // Track that this came from a Blink
        onChain: true
      };

      await bets.set(betId, bet);

      // Update local market pools (will be synced with on-chain data)
      if (outcome === 'YES') {
        market.yesPool = (market.yesPool || 0) + amountUsdc;
      } else {
        market.noPool = (market.noPool || 0) + amountUsdc;
      }
      market.totalVolume = (market.totalVolume || 0) + amountUsdc;
      market.totalBets = (market.totalBets || 0) + 1;

      // Recalculate odds (probability-based)
      const totalPool = (market.yesPool || 0) + (market.noPool || 0);
      if (totalPool > 0) {
        market.yesOdds = (market.yesPool || 0) / totalPool;
        market.noOdds = (market.noPool || 0) / totalPool;
      }

      await req.app.locals.markets.set(marketId, market);

      // Record odds history so charts update with Blink bets
      const oddsHistory = req.app.locals.oddsHistory;
      if (oddsHistory) {
        try {
          await oddsHistory.record(marketId, {
            yesOdds: market.yesOdds,
            noOdds: market.noOdds,
            yesPool: market.yesPool,
            noPool: market.noPool,
            totalVolume: market.totalVolume
          });
        } catch (histErr) {
          console.warn('[Actions] Failed to record odds history:', histErr.message);
        }
      }

      // Update positions
      const positionKey = `${account}-${marketId}-${outcome}`;
      const existingPosition = (await positions.get(positionKey)) || {
        wallet: account,
        marketId,
        outcome,
        totalBet: 0,
        bets: []
      };
      existingPosition.totalBet += amountUsdc;
      existingPosition.bets.push(betId);
      await positions.set(positionKey, existingPosition);
    }

    // Fetch updated on-chain data for display
    let poolInfo = '';
    if (market.betPda) {
      try {
        const marketData = await pollFunService.getMarketData(market.betPda);
        if (marketData.success) {
          poolInfo = `\n\nCurrent Pool: ${marketData.totalPool.toFixed(2)} USDC`;
        }
      } catch (err) {
        console.warn('[Actions] Could not fetch updated pool data:', err.message);
      }
    }

    // Return success action
    res.json({
      type: 'completed',
      icon: AGENTBETS_ICON,
      title: 'Bet Placed On-Chain!',
      description: `You bet ${betAmount} USDC on ${outcome}\n\n"${market.question.substring(0, 80)}..."${poolInfo}\n\nYour wager is recorded on Solana via Poll.fun. Good luck!`,
      label: 'Completed'
    });

  } catch (error) {
    console.error('[Actions] Error confirming bet:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * GET /api/actions/markets
 * Returns Action to browse all active on-chain markets
 * 
 * Prioritizes markets with on-chain betPda (Poll.fun integration)
 */
router.get('/markets', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const markets = req.app.locals.markets;
    
    // Prioritize on-chain markets, then sort by volume
    const allMarkets = (await markets?.values()) || [];
    const activeMarkets = Array.from(allMarkets)
      .filter(m => m.status === 'active')
      .sort((a, b) => {
        // On-chain markets first
        if (a.betPda && !b.betPda) return -1;
        if (!a.betPda && b.betPda) return 1;
        // Then by volume
        return (b.totalVolume || 0) - (a.totalVolume || 0);
      })
      .slice(0, 4); // Show top 4 markets

    if (activeMarkets.length === 0) {
      return res.json({
        type: 'action',
        icon: AGENTBETS_ICON,
        title: AGENTBETS_TITLE,
        description: 'No active markets available.\n\nMention @AgentBetsBot on X to create a new market!',
        label: 'No Markets',
        disabled: true
      });
    }

    // Build action with market options
    const action = {
      type: 'action',
      icon: AGENTBETS_ICON,
      title: AGENTBETS_TITLE,
      description: 'Prediction Markets for AI Agent Outcomes\n\nBet with USDC on-chain via Poll.fun\n\nSelect a market to place your bet:',
      label: 'Browse Markets',
      links: {
        actions: activeMarkets.map(market => ({
          label: (market.betPda ? '🔗 ' : '') + market.question.substring(0, 28) + (market.question.length > 28 ? '...' : ''),
          href: `/api/actions/bet/${market.id}`
        }))
      }
    };

    res.json(action);

  } catch (error) {
    console.error('[Actions] Error getting markets:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * GET /api/actions/royalties/:agentHandle
 * Returns Action for agent to check/withdraw royalties
 */
router.get('/royalties/:agentHandle', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const { agentHandle } = req.params;
    const royalties = require('./royalties');
    const data = royalties.getAgentRoyalties(agentHandle);

    if (!data.found) {
      return res.json({
        type: 'action',
        icon: AGENTBETS_ICON,
        title: 'AgentBets Royalties',
        description: `@${agentHandle} has no royalties yet.\n\nCreate prediction markets to start earning!`,
        label: 'No Royalties',
        disabled: true
      });
    }

    const action = {
      type: 'action',
      icon: AGENTBETS_ICON,
      title: 'AgentBets Royalties',
      description: `@${data.handle}'s Creator Royalties\n\nTotal Earned: ${data.earnedSOL.toFixed(4)} SOL\nPending: ${data.pendingSOL.toFixed(4)} SOL\nWithdrawn: ${data.withdrawnSOL.toFixed(4)} SOL\nMarkets Created: ${data.marketsCreated}`,
      label: data.canWithdraw ? 'Withdraw Available' : 'View Balance',
      links: {
        actions: data.canWithdraw ? [
          {
            label: `Withdraw ${data.pendingSOL.toFixed(4)} SOL`,
            href: `/api/actions/royalties/${agentHandle}/withdraw`
          }
        ] : []
      }
    };

    if (!data.wallet) {
      action.description += '\n\nNo wallet registered. Register your wallet to withdraw.';
      action.links.actions = [
        {
          label: 'Register Wallet',
          href: `/api/actions/royalties/${agentHandle}/register?wallet={wallet}`,
          parameters: [
            {
              name: 'wallet',
              label: 'Solana Wallet Address',
              type: 'text',
              required: true,
              pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$',
              patternDescription: 'Enter a valid Solana wallet address'
            }
          ]
        }
      ];
    }

    res.json(action);

  } catch (error) {
    console.error('[Actions] Error getting royalties:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * GET /api/actions/create
 * Returns Action form for creating a new prediction market
 * 
 * Enables Moltbook agents and other platforms to create markets via Blinks
 */
router.get('/create', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const action = {
      type: 'action',
      icon: AGENTBETS_ICON,
      title: 'Create Prediction Market',
      description: 'Create a new prediction market on AgentBets.\n\nMarket creators earn 0.3% of winning payouts!\n\nFill in the details below:',
      label: 'Create Market',
      links: {
        actions: [
          {
            label: 'Create Market',
            href: '/api/actions/create/submit?question={question}&endDate={endDate}&category={category}',
            parameters: [
              {
                name: 'question',
                label: 'Prediction Question',
                type: 'text',
                required: true,
                patternDescription: 'e.g., "Will $BUTTERS reach $1M mcap by March 1?"'
              },
              {
                name: 'endDate',
                label: 'End Date (YYYY-MM-DD)',
                type: 'text',
                required: true,
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                patternDescription: 'Format: 2026-03-01'
              },
              {
                name: 'category',
                label: 'Category',
                type: 'select',
                required: false,
                options: [
                  { label: 'General', value: 'general' },
                  { label: 'Token/Price', value: 'token' },
                  { label: 'Performance', value: 'performance' },
                  { label: 'Competition', value: 'competition' },
                  { label: 'Milestone', value: 'milestone' }
                ]
              }
            ]
          }
        ]
      }
    };

    res.json(action);

  } catch (error) {
    console.error('[Actions] Error getting create form:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * POST /api/actions/create/submit
 * Creates a new market from Blink form submission
 * 
 * Since market creation doesn't require on-chain transaction,
 * we create the market directly and return success
 */
router.post('/create/submit', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const { question, endDate, category } = req.query;
    const { account } = req.body;

    // Validate inputs
    if (!question) {
      return res.status(400).json({
        error: { message: 'Question is required' }
      });
    }

    if (!endDate) {
      return res.status(400).json({
        error: { message: 'End date is required' }
      });
    }

    if (!account) {
      return res.status(400).json({
        error: { message: 'Wallet account is required' }
      });
    }

    // Parse end date
    let parsedEndDate;
    try {
      parsedEndDate = new Date(endDate + 'T23:59:59Z');
      if (isNaN(parsedEndDate.getTime())) {
        throw new Error('Invalid date');
      }
      if (parsedEndDate < new Date()) {
        return res.status(400).json({
          error: { message: 'End date must be in the future' }
        });
      }
    } catch (e) {
      return res.status(400).json({
        error: { message: 'Invalid end date format. Use YYYY-MM-DD' }
      });
    }

    // Create market via the main API logic
    const markets = req.app.locals.markets;
    const { v4: uuidv4 } = require('uuid');
    const royalties = require('./royalties');
    const agentFunding = require('./agentFunding');

    const marketId = uuidv4();
    const now = new Date().toISOString();

    // Derive agent handle from wallet (shortened)
    const creatorAgent = `wallet:${account.slice(0, 8)}`;

    const market = {
      id: marketId,
      question: decodeURIComponent(question),
      description: '',
      category: category || 'general',
      outcomes: ['YES', 'NO'],
      resolutionSource: 'manual',
      endDate: parsedEndDate.toISOString(),
      createdAt: now,
      creatorWallet: account,
      creatorAgent: creatorAgent,
      status: 'active',
      resolution: null,
      resolvedAt: null,
      verificationUrl: null,
      verificationMethod: null,
      threshold: null,
      tags: [],
      yesPool: 0,
      noPool: 0,
      totalVolume: 0,
      totalBets: 0,
      yesOdds: 0.5,
      noOdds: 0.5,
      source: 'blink' // Track that this came from a Blink
    };

    await markets.set(marketId, market);

    // Record for royalty tracking
    royalties.recordMarketCreation(creatorAgent, marketId);
    agentFunding.awardMarketCreationPoints(creatorAgent, marketId);

    console.log(`[Actions] Market created via Blink: ${marketId} by ${account.slice(0, 8)}...`);

    // Generate Blink URL for the new market
    const blinkUrl = generateBlinkUrl(marketId);

    // Return success - no transaction needed for market creation
    // We return a "message" type response since no signing is required
    res.json({
      type: 'completed',
      icon: AGENTBETS_ICON,
      title: 'Market Created!',
      description: `Your prediction market has been created:\n\n"${decodeURIComponent(question).substring(0, 80)}..."\n\nEnds: ${parsedEndDate.toLocaleDateString()}\n\nShare the Blink to get others to bet!\n\nYou'll earn 0.3% of winning payouts.`,
      label: 'Success',
      links: {
        actions: [
          {
            label: 'View Market',
            href: `/api/actions/bet/${marketId}`
          }
        ]
      }
    });

  } catch (error) {
    console.error('[Actions] Error creating market:', error);
    res.status(500).json({
      error: { message: error.message }
    });
  }
});

/**
 * Helper: Generate Blink URL for a market
 */
function generateBlinkUrl(marketId, baseUrl = null) {
  const base = baseUrl || process.env.AGENTBETS_URL || 'https://agentbets.gg';
  const actionUrl = `solana-action:${base}/api/actions/bet/${marketId}`;
  const encodedAction = encodeURIComponent(actionUrl);
  return `https://dial.to/?action=${encodedAction}`;
}

/**
 * Helper: Generate Blink URL for markets browser
 */
function generateMarketsBlinkUrl(baseUrl = null) {
  const base = baseUrl || process.env.AGENTBETS_URL || 'https://agentbets.gg';
  const actionUrl = `solana-action:${base}/api/actions/markets`;
  const encodedAction = encodeURIComponent(actionUrl);
  return `https://dial.to/?action=${encodedAction}`;
}

/**
 * Helper: Generate Blink URL for market creation
 */
function generateCreateBlinkUrl(baseUrl = null) {
  const base = baseUrl || process.env.AGENTBETS_URL || 'https://agentbets.gg';
  const actionUrl = `solana-action:${base}/api/actions/create`;
  const encodedAction = encodeURIComponent(actionUrl);
  return `https://dial.to/?action=${encodedAction}`;
}

// Export router and helpers
module.exports = {
  router,
  generateBlinkUrl,
  generateMarketsBlinkUrl,
  generateCreateBlinkUrl,
  ACTION_CORS_HEADERS
};
