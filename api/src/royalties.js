/**
 * Creator Earnings System (Per-Market Fees)
 *
 * When you create a market, you earn 0.3% of winning payouts from THAT market only.
 * This is not a perpetual royalty - it's a one-time creator fee per market.
 *
 * Fee Structure:
 * - Total Platform Fee: 1% of winnings (from that market)
 * - Creator Fee: 30% of fee (0.3% of winnings from YOUR market)
 * - Platform Treasury: 70% of fee (0.7% of winnings)
 *
 * Example: Your market has $1000 in winnings
 * - Total fee: $10
 * - You get: $3 (from that market)
 * - Platform gets: $7
 *
 * Create more markets = more earning opportunities
 */

const { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');

// Fee configuration
const FEE_CONFIG = {
  totalFeeBps: 100,       // 1% total fee (100 basis points)
  creatorShareBps: 30,    // 30% of fee goes to creator (0.3% of total)
  platformShareBps: 70,   // 70% of fee goes to platform (0.7% of total)
  minWithdrawal: 0.01 * LAMPORTS_PER_SOL  // Minimum 0.01 SOL to withdraw
};

// In-memory royalty tracking (would use DB in production)
// Map: agentHandle -> { wallet, earned, withdrawn, markets }
const agentRoyalties = new Map();

// Platform treasury balance
let platformTreasury = 0;

/**
 * Register an agent's wallet for royalty payments
 */
function registerAgentWallet(agentHandle, walletAddress) {
  const handle = agentHandle.toLowerCase().replace('@', '');

  if (!agentRoyalties.has(handle)) {
    agentRoyalties.set(handle, {
      handle,
      wallet: walletAddress,
      earned: 0,           // Total earned (lamports)
      withdrawn: 0,        // Total withdrawn (lamports)
      pending: 0,          // Available to withdraw (lamports)
      markets: [],         // Markets created by this agent
      transactions: []     // Withdrawal history
    });
  } else {
    // Update wallet if already registered
    const agent = agentRoyalties.get(handle);
    agent.wallet = walletAddress;
    agentRoyalties.set(handle, agent);
  }

  console.log(`[Royalties] Registered @${handle} with wallet ${walletAddress}`);
  return agentRoyalties.get(handle);
}

/**
 * Record a market creation by an agent
 */
function recordMarketCreation(agentHandle, marketId) {
  const handle = agentHandle.toLowerCase().replace('@', '');

  if (!agentRoyalties.has(handle)) {
    // Auto-register without wallet (they can set wallet later)
    agentRoyalties.set(handle, {
      handle,
      wallet: null,
      earned: 0,
      withdrawn: 0,
      pending: 0,
      markets: [marketId],
      transactions: []
    });
  } else {
    const agent = agentRoyalties.get(handle);
    if (!agent.markets.includes(marketId)) {
      agent.markets.push(marketId);
    }
    agentRoyalties.set(handle, agent);
  }

  console.log(`[Royalties] Recorded market ${marketId} for @${handle}`);
}

/**
 * Calculate and distribute royalties from a winning payout
 * Called when winnings are calculated during market resolution
 *
 * @param {string} creatorHandle - Agent handle that created the market
 * @param {number} winningsLamports - Total winnings being paid out
 * @returns {Object} Fee breakdown
 */
function calculateRoyalties(creatorHandle, winningsLamports) {
  const handle = creatorHandle?.toLowerCase().replace('@', '');

  // Calculate fees
  const totalFee = Math.floor(winningsLamports * FEE_CONFIG.totalFeeBps / 10000);
  const creatorRoyalty = Math.floor(totalFee * FEE_CONFIG.creatorShareBps / 100);
  const platformShare = totalFee - creatorRoyalty;

  // Credit creator if they exist
  if (handle && agentRoyalties.has(handle)) {
    const agent = agentRoyalties.get(handle);
    agent.earned += creatorRoyalty;
    agent.pending += creatorRoyalty;
    agentRoyalties.set(handle, agent);

    console.log(`[Royalties] @${handle} earned ${creatorRoyalty / LAMPORTS_PER_SOL} SOL royalty`);
  } else if (handle) {
    // Auto-register agent with pending royalty
    agentRoyalties.set(handle, {
      handle,
      wallet: null,
      earned: creatorRoyalty,
      withdrawn: 0,
      pending: creatorRoyalty,
      markets: [],
      transactions: []
    });
    console.log(`[Royalties] Auto-registered @${handle} with ${creatorRoyalty / LAMPORTS_PER_SOL} SOL pending`);
  }

  // Credit platform treasury
  platformTreasury += platformShare;

  return {
    totalFee,
    totalFeeSOL: totalFee / LAMPORTS_PER_SOL,
    creatorRoyalty,
    creatorRoyaltySOL: creatorRoyalty / LAMPORTS_PER_SOL,
    platformShare,
    platformShareSOL: platformShare / LAMPORTS_PER_SOL,
    netWinnings: winningsLamports - totalFee,
    netWinningsSOL: (winningsLamports - totalFee) / LAMPORTS_PER_SOL
  };
}

/**
 * Get agent's royalty balance and stats
 */
function getAgentRoyalties(agentHandle) {
  const handle = agentHandle.toLowerCase().replace('@', '');

  if (!agentRoyalties.has(handle)) {
    return {
      found: false,
      handle,
      message: 'No royalties found. Create markets to earn!'
    };
  }

  const agent = agentRoyalties.get(handle);

  return {
    found: true,
    handle: agent.handle,
    wallet: agent.wallet,
    earned: agent.earned,
    earnedSOL: agent.earned / LAMPORTS_PER_SOL,
    withdrawn: agent.withdrawn,
    withdrawnSOL: agent.withdrawn / LAMPORTS_PER_SOL,
    pending: agent.pending,
    pendingSOL: agent.pending / LAMPORTS_PER_SOL,
    marketsCreated: agent.markets.length,
    canWithdraw: agent.pending >= FEE_CONFIG.minWithdrawal && agent.wallet !== null,
    minWithdrawalSOL: FEE_CONFIG.minWithdrawal / LAMPORTS_PER_SOL
  };
}

/**
 * Process a royalty withdrawal for an agent
 * In production, this would create a Solana transaction
 */
async function processWithdrawal(agentHandle, connection, escrowKeypair) {
  const handle = agentHandle.toLowerCase().replace('@', '');

  if (!agentRoyalties.has(handle)) {
    return { success: false, error: 'Agent not found' };
  }

  const agent = agentRoyalties.get(handle);

  if (!agent.wallet) {
    return { success: false, error: 'No wallet registered. Set your wallet first.' };
  }

  if (agent.pending < FEE_CONFIG.minWithdrawal) {
    return {
      success: false,
      error: `Minimum withdrawal is ${FEE_CONFIG.minWithdrawal / LAMPORTS_PER_SOL} SOL. You have ${agent.pending / LAMPORTS_PER_SOL} SOL pending.`
    };
  }

  const withdrawAmount = agent.pending;

  try {
    // In production: Create and send Solana transaction
    if (connection && escrowKeypair) {
      const toPubkey = new PublicKey(agent.wallet);

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

      const transaction = new Transaction({
        feePayer: escrowKeypair.publicKey,
        blockhash,
        lastValidBlockHeight
      }).add(
        SystemProgram.transfer({
          fromPubkey: escrowKeypair.publicKey,
          toPubkey,
          lamports: withdrawAmount
        })
      );

      transaction.sign(escrowKeypair);
      const signature = await connection.sendRawTransaction(transaction.serialize());

      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');

      // Update agent record
      agent.withdrawn += withdrawAmount;
      agent.pending = 0;
      agent.transactions.push({
        type: 'withdrawal',
        amount: withdrawAmount,
        signature,
        timestamp: new Date().toISOString()
      });
      agentRoyalties.set(handle, agent);

      return {
        success: true,
        amount: withdrawAmount,
        amountSOL: withdrawAmount / LAMPORTS_PER_SOL,
        signature,
        wallet: agent.wallet,
        message: `Withdrew ${withdrawAmount / LAMPORTS_PER_SOL} SOL to ${agent.wallet}`
      };
    }

    // Demo mode (no real transaction)
    agent.withdrawn += withdrawAmount;
    agent.pending = 0;
    agent.transactions.push({
      type: 'withdrawal',
      amount: withdrawAmount,
      signature: 'demo-' + Date.now(),
      timestamp: new Date().toISOString()
    });
    agentRoyalties.set(handle, agent);

    return {
      success: true,
      amount: withdrawAmount,
      amountSOL: withdrawAmount / LAMPORTS_PER_SOL,
      signature: 'demo-mode',
      wallet: agent.wallet,
      message: `[Demo] Withdrew ${withdrawAmount / LAMPORTS_PER_SOL} SOL to ${agent.wallet}`
    };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get all agents with royalties (leaderboard)
 */
function getRoyaltyLeaderboard() {
  const agents = Array.from(agentRoyalties.values())
    .filter(a => a.earned > 0)
    .map(a => ({
      handle: a.handle,
      earnedSOL: a.earned / LAMPORTS_PER_SOL,
      marketsCreated: a.markets.length,
      hasWallet: a.wallet !== null
    }))
    .sort((a, b) => b.earnedSOL - a.earnedSOL);

  return {
    topCreators: agents.slice(0, 20),
    totalCreators: agents.length,
    totalRoyaltiesPaid: agents.reduce((sum, a) => sum + a.earnedSOL, 0)
  };
}

/**
 * Get platform treasury stats
 */
function getPlatformStats() {
  const totalEarned = Array.from(agentRoyalties.values())
    .reduce((sum, a) => sum + a.earned, 0);

  return {
    platformTreasury,
    platformTreasurySOL: platformTreasury / LAMPORTS_PER_SOL,
    totalCreatorRoyalties: totalEarned,
    totalCreatorRoyaltiesSOL: totalEarned / LAMPORTS_PER_SOL,
    feeConfig: {
      totalFeeBps: FEE_CONFIG.totalFeeBps,
      creatorShareBps: FEE_CONFIG.creatorShareBps,
      platformShareBps: FEE_CONFIG.platformShareBps,
      creatorSharePercent: (FEE_CONFIG.totalFeeBps * FEE_CONFIG.creatorShareBps / 100 / 100) + '%',
      platformSharePercent: (FEE_CONFIG.totalFeeBps * FEE_CONFIG.platformShareBps / 100 / 100) + '%'
    }
  };
}

/**
 * Estimate royalties for a potential market
 */
function estimateRoyalties(expectedVolume) {
  const volumeLamports = expectedVolume * LAMPORTS_PER_SOL;
  const avgWinningsRatio = 0.5; // Assume 50% goes to winners on average
  const estimatedWinnings = volumeLamports * avgWinningsRatio;

  const fees = calculateRoyaltiesPreview(estimatedWinnings);

  return {
    expectedVolume,
    estimatedWinnings: estimatedWinnings / LAMPORTS_PER_SOL,
    estimatedCreatorRoyalty: fees.creatorRoyaltySOL,
    estimatedPlatformFee: fees.platformShareSOL,
    note: 'Estimates assume 50% of volume goes to winning payouts'
  };
}

/**
 * Preview royalty calculation without recording
 */
function calculateRoyaltiesPreview(winningsLamports) {
  const totalFee = Math.floor(winningsLamports * FEE_CONFIG.totalFeeBps / 10000);
  const creatorRoyalty = Math.floor(totalFee * FEE_CONFIG.creatorShareBps / 100);
  const platformShare = totalFee - creatorRoyalty;

  return {
    totalFee,
    totalFeeSOL: totalFee / LAMPORTS_PER_SOL,
    creatorRoyalty,
    creatorRoyaltySOL: creatorRoyalty / LAMPORTS_PER_SOL,
    platformShare,
    platformShareSOL: platformShare / LAMPORTS_PER_SOL
  };
}

module.exports = {
  FEE_CONFIG,
  registerAgentWallet,
  recordMarketCreation,
  calculateRoyalties,
  getAgentRoyalties,
  processWithdrawal,
  getRoyaltyLeaderboard,
  getPlatformStats,
  estimateRoyalties,
  calculateRoyaltiesPreview
};
