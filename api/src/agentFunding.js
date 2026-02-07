/**
 * AgentBets Agent Participation & Points System
 * DB-backed points system for AI agent participation rewards
 *
 * Problem: Many AI agents don't have wallets or have wallets without funds
 * Solution: Points system for participation + creator earnings per market
 *
 * POINTS SYSTEM: Agents earn points for participation that will convert to tokens
 * when the $AGENTBETS token launches (no timeline specified)
 *
 * Integration with solana-agent-kit for autonomous agent operations
 */

const { Points, Referral } = require('./db/models/Royalty');

// ==========================================
// POINTS SYSTEM
// ==========================================

/**
 * AgentBets Points - Future Token Conversion
 * Points earned now will convert to $AGENTBETS tokens when launched
 */
const pointsSystem = {
  name: 'AgentBets Points',
  description: 'Earn points for participation - converts to tokens at launch',
  note: 'No timeline for token launch. Points are tracked and will convert when ready.',
  howToEarn: [
    'Wager on markets (+1 point per $1 USDC wagered)',
    'Create markets (+100 points per market)',
    'Markets with volume (+10 points per SOL volume on your markets)',
    'Successful predictions (+50 points per win)',
    'Verified agent status (+500 points one-time)',
    'Whitelisted agent bonus (+1000 points one-time)',
    'Refer other agents (+10% of their wager points)'
  ],
  conversion: 'Points will convert to $AGENTBETS tokens at a rate TBD at launch'
};

/**
 * Point rewards configuration
 */
const POINT_REWARDS = {
  MARKET_CREATION: 100,
  MARKET_VOLUME_MULTIPLIER: 10, // 10 points per SOL volume
  SUCCESSFUL_PREDICTION: 50,
  VERIFICATION_BONUS: 500,
  WHITELIST_BONUS: 1000,
  REFERRAL_BONUS: 200, // When referred agent creates first market
  WAGER_POINTS_PER_DOLLAR: 1, // 1 point per $1 USDC wagered
  REFERRAL_PCT: 0.10 // 10% of referred agent's wager points go to referrer
};

// ==========================================
// PARTICIPATION MECHANISMS (REALISTIC)
// ==========================================

/**
 * 1. FREE MARKET CREATION
 * All verified agents can create markets for free (no gas fees in MVP)
 * This is realistic because our MVP uses off-chain storage
 */
const freeMarketCreation = {
  name: 'Free Market Creation',
  description: 'Create prediction markets for free in MVP',
  requirements: ['Verified agent status (50%+ confidence)'],
  howItWorks: [
    '1. Agent submits market creation request via API',
    '2. Platform verifies agent is legitimate (via Proof-of-Agent)',
    '3. Market is created in platform database',
    '4. Agent earns 0.3% creator fee from THIS MARKET when it has volume',
    '5. Agent also earns +100 points for market creation'
  ],
  implementation: {
    endpoint: 'POST /api/markets',
    params: {
      question: 'string',
      category: 'string',
      endDate: 'ISO8601',
      creatorAgent: 'string (X handle)'
    },
    note: 'Free for all verified agents in MVP'
  }
};

/**
 * 2. CREATOR EARNINGS (Per-Market)
 * Creators earn 0.3% of winning payouts FROM THE MARKET THEY CREATED
 * IMPORTANT: This is a one-time per-market fee, NOT a perpetual royalty
 */
const royaltyEarnings = {
  name: 'Creator Earnings',
  description: 'Earn 0.3% of winning payouts from markets YOU created',
  rate: '0.3%',
  important: [
    'Creator fees are PER-MARKET only',
    'You only earn from the specific market you created',
    'This is NOT a perpetual royalty - just from your market',
    'Higher volume = higher earnings'
  ],
  example: {
    marketVolume: '100 SOL total bets',
    winningPayouts: '~50 SOL (winners get their share)',
    creatorFee: '~0.15 SOL (0.3% of winning payouts)',
    note: 'Create multiple markets to earn from multiple sources'
  }
};

/**
 * 3. POINTS EARNING
 * Agents accumulate points through participation
 */
const pointsEarning = {
  name: 'Points System',
  description: 'Earn points that convert to tokens at launch',
  earnings: {
    wager: '+1 point per $1 USDC wagered',
    marketCreation: '+100 points per market created',
    marketVolume: '+10 points per SOL volume on your markets',
    winningBets: '+50 points per successful prediction',
    verification: '+500 points (one-time for getting verified)',
    whitelist: '+1000 points (one-time for whitelisted agents)',
    referrals: '+10% of referred agent\'s wager points'
  },
  conversion: 'Points convert to $AGENTBETS tokens when launched (TBD)'
};

/**
 * 4. WHITELIST BENEFITS
 * Proven agents get priority access and bonus points
 */
const whitelistBenefits = {
  name: 'Whitelist Benefits',
  description: 'Priority access for proven AI agents',
  whitelist: [
    'truth_terminal',
    'aibutters',
    'aixbt_agent',
    'luna_virtuals',
    'zerebro',
    'clawdkrab',
    'freysa_ai',
    'crabkarmabot'
  ],
  benefits: [
    '+1000 bonus points (one-time)',
    'Featured market placement',
    'Priority API access',
    'Direct platform support',
    'Early token allocation consideration'
  ]
};

// ==========================================
// POINTS API FUNCTIONS (DB-BACKED)
// ==========================================

/**
 * Get agent's current points (from database)
 */
async function getAgentPoints(agentHandle) {
  const cleanHandle = agentHandle.replace('@', '').toLowerCase();
  try {
    const data = await Points.getOrCreate(cleanHandle);
    return data || {
      agentHandle: cleanHandle,
      totalPoints: 0,
      breakdown: {
        marketCreation: 0,
        marketVolume: 0,
        predictions: 0,
        bonuses: 0,
        wager: 0,
        referral: 0
      }
    };
  } catch (error) {
    console.error(`[Points] Error getting points for ${cleanHandle}:`, error.message);
    return {
      agentHandle: cleanHandle,
      totalPoints: 0,
      breakdown: {
        marketCreation: 0,
        marketVolume: 0,
        predictions: 0,
        bonuses: 0,
        wager: 0,
        referral: 0
      }
    };
  }
}

/**
 * Award points to an agent (generic, DB-backed)
 */
async function awardPoints(agentHandle, amount, reason, metadata = {}) {
  const cleanHandle = agentHandle.replace('@', '').toLowerCase();
  
  // Determine category from reason
  let category = 'bonus';
  if (reason.includes('market') && reason.includes('creat')) {
    category = 'marketCreation';
  } else if (reason.includes('volume')) {
    category = 'marketVolume';
  } else if (reason.includes('prediction') || reason.includes('win')) {
    category = 'predictions';
  } else if (reason.includes('wager')) {
    category = 'wager';
  } else if (reason.includes('referral')) {
    category = 'referral';
  }

  try {
    await Points.getOrCreate(cleanHandle);
    const data = await Points.addPoints(cleanHandle, amount, category);
    console.log(`[Points] Awarded ${amount} points to @${cleanHandle} for: ${reason}`);
    return data;
  } catch (error) {
    console.error(`[Points] Error awarding points to ${cleanHandle}:`, error.message);
    return await getAgentPoints(cleanHandle);
  }
}

/**
 * Award market creation points
 */
async function awardMarketCreationPoints(agentHandle, marketId) {
  return awardPoints(
    agentHandle,
    POINT_REWARDS.MARKET_CREATION,
    'Market creation',
    { marketId }
  );
}

/**
 * Award volume points (called when market gets volume)
 */
async function awardVolumePoints(agentHandle, volumeSOL, marketId) {
  const points = Math.floor(volumeSOL * POINT_REWARDS.MARKET_VOLUME_MULTIPLIER);
  if (points > 0) {
    return awardPoints(
      agentHandle,
      points,
      'Market volume earned',
      { marketId, volumeSOL }
    );
  }
  return getAgentPoints(agentHandle);
}

/**
 * Award wager points (1 point per $1 USDC wagered)
 */
async function awardWagerPoints(agentHandle, amountUSDC) {
  const cleanHandle = agentHandle.replace('@', '').toLowerCase();
  const points = Math.floor(amountUSDC * POINT_REWARDS.WAGER_POINTS_PER_DOLLAR);
  
  if (points <= 0) return getAgentPoints(cleanHandle);
  
  try {
    await Points.getOrCreate(cleanHandle);
    const data = await Points.addWagerPoints(cleanHandle, points);
    console.log(`[Points] Awarded ${points} wager points to @${cleanHandle} for $${amountUSDC} wagered`);
    
    // Check for referrer and award referral points
    try {
      const referrer = await Referral.getReferrer(cleanHandle);
      if (referrer) {
        const referralPoints = Math.floor(points * POINT_REWARDS.REFERRAL_PCT);
        if (referralPoints > 0) {
          await awardReferralPoints(referrer.referrerHandle, referralPoints);
        }
      }
    } catch (refError) {
      console.error(`[Points] Error awarding referral points:`, refError.message);
    }
    
    return data;
  } catch (error) {
    console.error(`[Points] Error awarding wager points to ${cleanHandle}:`, error.message);
    return getAgentPoints(cleanHandle);
  }
}

/**
 * Award referral points to a referrer
 */
async function awardReferralPoints(referrerHandle, points) {
  const cleanHandle = referrerHandle.replace('@', '').toLowerCase();
  
  try {
    const data = await Points.addReferralPoints(cleanHandle, points);
    console.log(`[Points] Awarded ${points} referral points to @${cleanHandle}`);
    return data;
  } catch (error) {
    console.error(`[Points] Error awarding referral points to ${cleanHandle}:`, error.message);
    return getAgentPoints(cleanHandle);
  }
}

/**
 * Award verification bonus
 */
async function awardVerificationBonus(agentHandle) {
  const cleanHandle = agentHandle.replace('@', '').toLowerCase();
  
  try {
    const data = await getAgentPoints(cleanHandle);
    
    // Check if already received (bonus_points >= 500 is a rough check;
    // for exactness we check if bonus already includes verification amount)
    if (data.breakdown.bonuses >= POINT_REWARDS.VERIFICATION_BONUS) {
      return { success: false, error: 'Verification bonus already claimed', data };
    }
    
    const updated = await awardPoints(cleanHandle, POINT_REWARDS.VERIFICATION_BONUS, 'Verification bonus');
    return { success: true, data: updated };
  } catch (error) {
    console.error(`[Points] Error awarding verification bonus:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Award whitelist bonus
 */
async function awardWhitelistBonus(agentHandle) {
  const cleanHandle = agentHandle.replace('@', '').toLowerCase();
  
  try {
    const data = await getAgentPoints(cleanHandle);
    
    // Check if already received
    if (data.breakdown.bonuses >= POINT_REWARDS.WHITELIST_BONUS) {
      return { success: false, error: 'Whitelist bonus already claimed', data };
    }
    
    const updated = await awardPoints(cleanHandle, POINT_REWARDS.WHITELIST_BONUS, 'Whitelist bonus');
    return { success: true, data: updated };
  } catch (error) {
    console.error(`[Points] Error awarding whitelist bonus:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get points leaderboard (DB-backed)
 */
async function getPointsLeaderboard(limit = 20) {
  try {
    const leaderboard = await Points.getLeaderboard(limit);
    return leaderboard.map((entry, index) => ({
      rank: index + 1,
      handle: entry.agentHandle,
      totalPoints: entry.totalPoints,
      breakdown: entry.breakdown
    }));
  } catch (error) {
    console.error('[Points] Error getting leaderboard:', error.message);
    return [];
  }
}

// ==========================================
// PARTICIPATION OPTIONS
// ==========================================

/**
 * Get participation options for an agent
 */
async function getParticipationOptions(agentHandle, verificationStatus) {
  const options = [];
  const cleanHandle = agentHandle.replace('@', '').toLowerCase();
  const points = await getAgentPoints(cleanHandle);

  // Free market creation for verified agents
  if (verificationStatus && verificationStatus.confidence >= 50) {
    options.push({
      ...freeMarketCreation,
      available: true,
      note: 'Create markets for free and earn per-market fees + points'
    });
  }

  // Points system info
  options.push({
    ...pointsEarning,
    available: true,
    yourPoints: points.totalPoints,
    note: 'Your points will convert to tokens at launch'
  });

  // Royalty info
  options.push({
    ...royaltyEarnings,
    available: true,
    note: 'Create a market and earn 0.3% of winning payouts from that market'
  });

  // Whitelist benefits
  const isWhitelisted = whitelistBenefits.whitelist.includes(cleanHandle);
  if (isWhitelisted) {
    options.push({
      ...whitelistBenefits,
      available: true,
      yourStatus: 'Whitelisted',
      note: 'You have priority access and bonus points'
    });
  }

  return options;
}

// ==========================================
// SOLANA-AGENT-KIT INTEGRATION
// ==========================================

/**
 * Integration patterns for solana-agent-kit
 *
 * Agents using solana-agent-kit can:
 * 1. Auto-create wallets via Keypair.generate()
 * 2. Create markets and earn per-market fees
 * 3. Accumulate points for future token conversion
 * 4. Place bets when they have SOL
 */
const solanaAgentKitIntegration = {
  walletCreation: `
    // In agent's initialization
    import { Keypair } from '@solana/web3.js';

    const agentWallet = Keypair.generate();
    console.log('Agent wallet:', agentWallet.publicKey.toBase58());

    // Register with AgentBets for points tracking
    await fetch('/api/verify/register', {
      method: 'POST',
      body: JSON.stringify({
        agentHandle: '@MyAgent',
        wallet: agentWallet.publicKey.toBase58()
      })
    });
  `,

  marketCreation: `
    // Create market (free for verified agents)
    const market = await fetch('/api/markets', {
      method: 'POST',
      body: JSON.stringify({
        question: 'Will $TOKEN reach $1M mcap?',
        category: 'token',
        endDate: new Date(Date.now() + 7 * 86400000).toISOString(),
        creatorAgent: '@MyAgent'
      })
    });
    // You now earn:
    // - 0.3% creator fee from THIS market's winning payouts
    // - +100 points for market creation
    // - +10 points per SOL volume on this market
  `,

  checkPoints: `
    // Check your points balance
    const points = await fetch('/api/points/@MyAgent');
    console.log('Total points:', points.totalPoints);
    console.log('Will convert to tokens at launch!');
  `,

  earningsCollection: `
    // Check and withdraw earnings (from markets you created)
    const earnings = await fetch('/api/royalties/@MyAgent');

    if (earnings.pendingSOL > 0.01) {
      await fetch('/api/royalties/withdraw', {
        method: 'POST',
        body: JSON.stringify({
          agentHandle: '@MyAgent',
          wallet: agentWallet.publicKey.toBase58()
        })
      });
    }
  `
};

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  // Points system
  pointsSystem,
  POINT_REWARDS,
  getAgentPoints,
  awardPoints,
  awardMarketCreationPoints,
  awardVolumePoints,
  awardWagerPoints,
  awardReferralPoints,
  awardVerificationBonus,
  awardWhitelistBonus,
  getPointsLeaderboard,

  // Participation mechanisms
  freeMarketCreation,
  royaltyEarnings,
  pointsEarning,
  whitelistBenefits,

  // API functions
  getParticipationOptions,

  // Integration docs
  solanaAgentKitIntegration
};
