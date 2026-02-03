/**
 * Solana Actions (Blinks) for AgentBets
 *
 * Enables prediction market betting directly from X/Twitter through Blinks
 * https://solana.com/developers/guides/advanced/actions
 *
 * Action URL format: solana-action:https://agentbets.gg/api/actions/bet/{marketId}
 * Blink URL format: https://dial.to/?action=solana-action%3Ahttps%3A%2F%2Fagentbets.gg%2Fapi%2Factions%2Fbet%2F{marketId}
 */

const express = require('express');
const { PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const router = express.Router();

// CORS headers required for Solana Actions
const ACTION_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding',
  'Content-Type': 'application/json'
};

// Platform config
const AGENTBETS_ICON = 'https://agentbets.gg/icon.png'; // TODO: Add actual icon
const AGENTBETS_TITLE = 'AgentBets';
const ESCROW_WALLET = process.env.ESCROW_WALLET || 'Ds9gRNjHufEa918D2HJSbE9AQo8wpqsor9g8rbH6Xwfw';

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
 */
router.get('/bet/:marketId', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const { marketId } = req.params;
    const market = req.app.locals.markets?.get(marketId);

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
        description: `This market has been resolved: ${market.resolution}`,
        label: 'Closed',
        disabled: true
      });
    }

    // Format odds for display
    const yesPercent = (market.yesOdds * 100).toFixed(0);
    const noPercent = (market.noOdds * 100).toFixed(0);
    const totalPool = (market.yesPool + market.noPool) / LAMPORTS_PER_SOL;

    // Build action response
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
                label: 'Amount (SOL)',
                type: 'number',
                required: true,
                min: 0.01,
                max: 100,
                patternDescription: 'Enter bet amount between 0.01 and 100 SOL'
              }
            ]
          },
          {
            label: `NO (${noPercent}%)`,
            href: `/api/actions/bet/${marketId}/place?outcome=NO&amount={amount}`,
            parameters: [
              {
                name: 'amount',
                label: 'Amount (SOL)',
                type: 'number',
                required: true,
                min: 0.01,
                max: 100,
                patternDescription: 'Enter bet amount between 0.01 and 100 SOL'
              }
            ]
          }
        ]
      }
    };

    // Add market stats to description
    if (totalPool > 0) {
      action.description += `\n\nPool: ${totalPool.toFixed(2)} SOL | Bets: ${market.totalBets}`;
    }

    // Add end date
    const endDate = new Date(market.endDate);
    action.description += `\nEnds: ${endDate.toLocaleDateString()}`;

    // Creator info
    if (market.creatorAgent) {
      action.description += `\nCreated by: ${market.creatorAgent}`;
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
 * Creates a bet transaction for the user to sign
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
    if (isNaN(betAmount) || betAmount < 0.01 || betAmount > 100) {
      return res.status(400).json({
        error: { message: 'Invalid amount. Must be between 0.01 and 100 SOL' }
      });
    }

    const market = req.app.locals.markets?.get(marketId);
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

    // Create transfer transaction to escrow
    const userPubkey = new PublicKey(account);
    const escrowPubkey = new PublicKey(ESCROW_WALLET);
    const lamports = Math.floor(betAmount * LAMPORTS_PER_SOL);

    // Build the transaction
    const transaction = new Transaction();

    // Add transfer instruction
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: userPubkey,
        toPubkey: escrowPubkey,
        lamports
      })
    );

    // Add memo with bet details for tracking
    // Note: In production, use @solana/spl-memo
    // For now, we'll track via our API after signature confirmation

    // Set fee payer (will be overwritten by client if not signed)
    transaction.feePayer = userPubkey;

    // Serialize transaction (unsigned - client will add blockhash and sign)
    const serializedTransaction = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    }).toString('base64');

    // Calculate potential payout
    const pool = outcome === 'YES' ? market.yesPool : market.noPool;
    const oppositePool = outcome === 'YES' ? market.noPool : market.yesPool;
    const newPool = pool + lamports;
    const share = lamports / newPool;
    const potentialPayout = lamports + (share * oppositePool * 0.99);

    res.json({
      transaction: serializedTransaction,
      message: `Bet ${betAmount} SOL on ${outcome} - "${market.question.substring(0, 50)}..."`,
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

    const market = req.app.locals.markets?.get(marketId);
    if (!market) {
      return res.status(404).json({
        error: { message: 'Market not found' }
      });
    }

    const betAmount = parseFloat(amount);
    const lamports = Math.floor(betAmount * LAMPORTS_PER_SOL);

    // Record the bet in our system
    const bets = req.app.locals.bets;
    const positions = req.app.locals.positions;

    if (bets && positions) {
      const { v4: uuidv4 } = require('uuid');
      const betId = uuidv4();

      const bet = {
        id: betId,
        marketId,
        outcome,
        amount: lamports,
        amountSOL: betAmount,
        wallet: account,
        txSignature: signature,
        placedAt: new Date().toISOString(),
        status: 'active',
        source: 'blink' // Track that this came from a Blink
      };

      bets.set(betId, bet);

      // Update market pools
      if (outcome === 'YES') {
        market.yesPool += lamports;
      } else {
        market.noPool += lamports;
      }
      market.totalVolume += lamports;
      market.totalBets += 1;

      // Recalculate odds
      const totalPool = market.yesPool + market.noPool;
      if (totalPool > 0) {
        market.yesOdds = market.noPool / totalPool;
        market.noOdds = market.yesPool / totalPool;
      }

      req.app.locals.markets.set(marketId, market);

      // Update positions
      const positionKey = `${account}-${marketId}-${outcome}`;
      const existingPosition = positions.get(positionKey) || {
        wallet: account,
        marketId,
        outcome,
        totalBet: 0,
        bets: []
      };
      existingPosition.totalBet += lamports;
      existingPosition.bets.push(betId);
      positions.set(positionKey, existingPosition);
    }

    // Return success action
    res.json({
      type: 'completed',
      icon: AGENTBETS_ICON,
      title: 'Bet Placed!',
      description: `You bet ${betAmount} SOL on ${outcome}\n\n"${market.question.substring(0, 80)}..."\n\nGood luck!`,
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
 * Returns Action to browse all active markets
 */
router.get('/markets', async (req, res) => {
  res.set(ACTION_CORS_HEADERS);

  try {
    const markets = req.app.locals.markets;
    const activeMarkets = Array.from(markets?.values() || [])
      .filter(m => m.status === 'active')
      .sort((a, b) => b.totalVolume - a.totalVolume)
      .slice(0, 4); // Show top 4 markets

    if (activeMarkets.length === 0) {
      return res.json({
        type: 'action',
        icon: AGENTBETS_ICON,
        title: AGENTBETS_TITLE,
        description: 'No active markets available.',
        label: 'No Markets',
        disabled: true
      });
    }

    // Build action with market options
    const action = {
      type: 'action',
      icon: AGENTBETS_ICON,
      title: AGENTBETS_TITLE,
      description: 'Prediction Markets for AI Agent Outcomes\n\nSelect a market to place your bet:',
      label: 'Browse Markets',
      links: {
        actions: activeMarkets.map(market => ({
          label: market.question.substring(0, 30) + (market.question.length > 30 ? '...' : ''),
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
 * Helper: Generate Blink URL for a market
 */
function generateBlinkUrl(marketId, baseUrl = 'https://agentbets.gg') {
  const actionUrl = `solana-action:${baseUrl}/api/actions/bet/${marketId}`;
  const encodedAction = encodeURIComponent(actionUrl);
  return `https://dial.to/?action=${encodedAction}`;
}

/**
 * Helper: Generate Blink URL for markets browser
 */
function generateMarketsBlinkUrl(baseUrl = 'https://agentbets.gg') {
  const actionUrl = `solana-action:${baseUrl}/api/actions/markets`;
  const encodedAction = encodeURIComponent(actionUrl);
  return `https://dial.to/?action=${encodedAction}`;
}

// Export router and helpers
module.exports = {
  router,
  generateBlinkUrl,
  generateMarketsBlinkUrl,
  ACTION_CORS_HEADERS
};
