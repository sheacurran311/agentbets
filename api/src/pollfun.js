/**
 * AgentBets Poll.fun SDK Integration
 * Handles on-chain prediction market creation, wagering, and settlement
 *
 * IMPORTANT: This uses isCreatorResolver=true so AgentBets oracle system
 * resolves markets, bypassing the vulnerable consensus voting mechanism.
 */

const { Connection, PublicKey, Keypair, Transaction } = require('@solana/web3.js');
const { SDK, Outcome, MarketStatus } = require('@solworks/poll-sdk');
const bs58 = require('bs58').default;

// USDC mint addresses
const USDC_MINT_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const USDC_MINT_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Default RPC endpoints
const RPC_ENDPOINTS = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet.solana.com'
};

class PollFunService {
  constructor(options = {}) {
    this.network = options.network || 'devnet';
    this.rpcEndpoint = options.rpcEndpoint || RPC_ENDPOINTS[this.network];
    this.connection = new Connection(this.rpcEndpoint, 'confirmed');
    this.usdcMint = this.network === 'mainnet' ? USDC_MINT_MAINNET : USDC_MINT_DEVNET;

    // Creator keypair for creating/resolving markets (loaded from env)
    this.creatorKeypair = null;
    this.sdk = null;

    if (process.env.SOLANA_PRIVATE_KEY) {
      try {
        const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
        this.creatorKeypair = Keypair.fromSecretKey(secretKey);
        console.log('[PollFun] Creator wallet loaded:', this.creatorKeypair.publicKey.toBase58());

        // Initialize SDK with wallet for signing
        this.sdk = SDK.build({
          connection: this.connection,
          wallet: {
            publicKey: this.creatorKeypair.publicKey,
            signTransaction: async (tx) => {
              tx.sign(this.creatorKeypair);
              return tx;
            },
            signAllTransactions: async (txs) => {
              txs.forEach(tx => tx.sign(this.creatorKeypair));
              return txs;
            }
          },
          commitment: 'confirmed'
        });
      } catch (err) {
        console.warn('[PollFun] Failed to load creator keypair:', err.message);
        // Initialize SDK without wallet (read-only mode)
        this.sdk = SDK.build({
          connection: this.connection,
          commitment: 'confirmed'
        });
      }
    } else {
      console.warn('[PollFun] No SOLANA_PRIVATE_KEY set - running in read-only mode');
      this.sdk = SDK.build({
        connection: this.connection,
        commitment: 'confirmed'
      });
    }
  }

  /**
   * Ensure user account exists on-chain (required before placing wagers)
   * @param {Keypair} userKeypair User's keypair
   * @returns {Object} Result with success status
   */
  async ensureUserExists(userKeypair) {
    try {
      const userAddress = this.sdk.addresses.user.get(userKeypair.publicKey);

      // Check if user already exists
      try {
        await this.sdk.accounts.user.single(userAddress);
        console.log('[PollFun] User already exists:', userKeypair.publicKey.toBase58());
        return { success: true, exists: true, userAddress: userAddress.toBase58() };
      } catch {
        // User doesn't exist, create it
        console.log('[PollFun] Creating user:', userKeypair.publicKey.toBase58());

        const txHash = await this.sdk.initializeUser({
          signers: [userKeypair],
          feePayerOverride: userKeypair.publicKey
        });

        return {
          success: true,
          exists: false,
          created: true,
          userAddress: userAddress.toBase58(),
          txSignature: txHash
        };
      }
    } catch (error) {
      console.error('[PollFun] Failed to ensure user exists:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Ensure the bot's creator account exists on-chain
   * This is required before ANY market creation or wagering operation
   * Called automatically by createMarket, but can be called manually too
   * @returns {Object} Result with success status
   */
  async ensureCreatorUserExists() {
    if (!this.creatorKeypair) {
      return { success: false, error: 'Bot creator keypair not configured' };
    }

    try {
      const result = await this.ensureUserExists(this.creatorKeypair);
      if (result.success) {
        if (result.created) {
          console.log('[PollFun] Bot creator user account initialized on-chain:', result.userAddress);
        } else {
          console.log('[PollFun] Bot creator user account already exists:', result.userAddress);
        }
      }
      return result;
    } catch (error) {
      console.error('[PollFun] Failed to ensure creator user exists:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Initialize a new prediction market on-chain
   * Uses isCreatorResolver=true so our oracle can resolve without voting
   *
   * SECURITY: The bot ALWAYS creates markets with its own keypair.
   * Users are "proposers" not creators - they cannot resolve markets they suggest.
   * This prevents conflict of interest and manipulation.
   *
   * @param {Object} params Market parameters
   * @param {string} params.question The market question (max 256 chars)
   * @param {number} params.expectedUserCount Max participants (1-50)
   * @param {number} params.minimumVoteCount Min votes needed (only matters if !isCreatorResolver)
   * @param {string} params.proposerAgent Optional: agent who proposed this market (for royalties)
   * @returns {Object} Market creation result with bet PDA
   */
  async createMarket(params) {
    const {
      question,
      expectedUserCount = 50,
      minimumVoteCount = 1,
      proposerAgent // NEW: track who proposed it, but they don't create it
    } = params;

    // SECURITY: ALWAYS use the bot's keypair as creator
    // Never allow user-provided keypairs to create markets
    const creator = this.creatorKeypair;
    if (!creator) {
      return {
        success: false,
        error: 'Bot creator keypair not configured (SOLANA_PRIVATE_KEY env var missing)'
      };
    }

    if (question.length > 256) {
      return { success: false, error: 'Question must be 256 characters or less' };
    }

    console.log('[PollFun] Creating market:', question);

    try {
      // AUTO: Ensure bot's program user account exists before creating market
      // This is required by Poll.fun SDK - without it, "Account does not exist" error occurs
      const userResult = await this.ensureCreatorUserExists();
      if (!userResult.success) {
        console.error('[PollFun] Failed to ensure creator user account:', userResult.error);
        return { success: false, error: `Failed to initialize creator account: ${userResult.error}` };
      }

      // Create bet with creator resolution (bypasses voting vulnerability)
      const result = await this.sdk.initializeBetV2({
        question,
        expectedUserCount,
        minimumVoteCount,
        isCreatorResolver: true, // IMPORTANT: Our oracle resolves, not voters
        signers: [creator],
        payerOverride: creator.publicKey
      });

      console.log('[PollFun] Market created by bot!');
      console.log('[PollFun] Bet PDA:', result.bet.toBase58());
      console.log('[PollFun] Fee Pool:', result.feePool.toBase58());
      console.log('[PollFun] Tx:', result.tx);
      if (proposerAgent) {
        console.log('[PollFun] Proposed by:', proposerAgent);
      }

      return {
        success: true,
        betPda: result.bet.toBase58(),
        feePool: result.feePool.toBase58(),
        txSignature: result.tx,
        creator: creator.publicKey.toBase58(), // Bot's address
        proposerAgent: proposerAgent || null, // Who proposed it (for royalties)
        question,
        expectedUserCount,
        isCreatorResolver: true,
        note: 'Market created by AgentBets bot. Only bot can resolve.'
      };
    } catch (error) {
      console.error('[PollFun] Failed to create market:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Build wager instruction for user to sign client-side
   * Note: User must have a program account (call ensureUserExists first)
   *
   * @param {Object} params Wager parameters
   * @param {string} params.betPda Market PDA address
   * @param {string} params.side 'YES' or 'NO' (maps to Outcome.For / Outcome.Against)
   * @param {number} params.amount Amount in USDC (human-readable, e.g., 25 for $25)
   * @param {string} params.userPubkey User's wallet public key
   * @param {string} [params.feePayerPubkey] Optional: override who pays SOL rent (for gasless relay)
   * @returns {Object} Instruction for user to sign
   */
  async buildWagerInstruction(params) {
    const { betPda, side, amount, userPubkey, feePayerPubkey } = params;

    console.log(`[PollFun] Building wager instruction: ${amount} USDC on ${side}`);

    try {
      // Map YES/NO to Poll.fun Outcome enum
      const outcome = side === 'YES' ? Outcome.For : Outcome.Against;

      // payerOverride determines who pays SOL rent for on-chain accounts.
      // In gasless mode, the API wallet pays; otherwise the user pays.
      const payer = feePayerPubkey ? new PublicKey(feePayerPubkey) : new PublicKey(userPubkey);

      // Get the instruction (not signed transaction)
      const ix = await this.sdk.instructions.placeWagerV2({
        bet: new PublicKey(betPda),
        amount, // SDK handles USDC decimals
        side: outcome,
        payerOverride: payer
      });

      return {
        success: true,
        instruction: ix,
        betPda,
        side,
        amount,
        message: `Place ${amount} USDC wager on ${side}`
      };
    } catch (error) {
      console.error('[PollFun] Failed to build wager instruction:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Place a wager (server-side, requires user keypair)
   * For client-side, use buildWagerInstruction instead
   *
   * @param {Object} params Wager parameters
   * @param {string} params.betPda Market PDA address
   * @param {string} params.side 'YES' or 'NO'
   * @param {number} params.amount Amount in USDC
   * @param {Keypair} params.userKeypair User's keypair for signing
   * @returns {Object} Transaction result
   */
  async placeWager(params) {
    const { betPda, side, amount, userKeypair } = params;

    if (!userKeypair) {
      return { success: false, error: 'User keypair required' };
    }

    console.log(`[PollFun] Placing wager: ${amount} USDC on ${side}`);

    try {
      // AUTO: Ensure user's program account exists before placing wager
      const userResult = await this.ensureUserExists(userKeypair);
      if (!userResult.success) {
        return { success: false, error: `Failed to initialize user account: ${userResult.error}` };
      }

      const outcome = side === 'YES' ? Outcome.For : Outcome.Against;

      const txHash = await this.sdk.placeWagerV2({
        bet: new PublicKey(betPda),
        amount,
        side: outcome,
        signers: [userKeypair],
        payerOverride: userKeypair.publicKey
      });

      console.log('[PollFun] Wager placed:', txHash);

      return {
        success: true,
        txSignature: txHash,
        betPda,
        side,
        amount
      };
    } catch (error) {
      console.error('[PollFun] Failed to place wager:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Initiate the voting/resolution phase
   * Only needed when isCreatorResolver=false (consensus voting)
   * For creator-resolved markets, the creator just calls placeVote
   *
   * @param {Object} params Parameters
   * @param {string} params.betPda Market PDA address
   * @param {Keypair} params.initiatorKeypair Initiator's keypair (must have wager)
   * @returns {Object} Result
   */
  async initiateVote(params) {
    const { betPda, initiatorKeypair } = params;

    const initiator = initiatorKeypair || this.creatorKeypair;
    if (!initiator) {
      return { success: false, error: 'Initiator keypair required' };
    }

    console.log('[PollFun] Initiating vote phase for market:', betPda);

    try {
      const txHash = await this.sdk.initiateVoteV2({
        bet: new PublicKey(betPda),
        signers: [initiator],
        payerOverride: initiator.publicKey
      });

      console.log('[PollFun] Vote phase initiated:', txHash);

      return {
        success: true,
        txSignature: txHash,
        betPda
      };
    } catch (error) {
      console.error('[PollFun] Failed to initiate vote:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Resolve a market by casting the creator's vote
   * Since isCreatorResolver=true, creator's vote immediately resolves
   *
   * @param {Object} params Resolution parameters
   * @param {string} params.betPda Market PDA address
   * @param {string} params.winningOutcome 'YES' or 'NO'
   * @param {Keypair} params.creatorKeypair Creator's keypair
   * @returns {Object} Resolution result
   */
  async resolveMarket(params) {
    const { betPda, winningOutcome, creatorKeypair } = params;

    const creator = creatorKeypair || this.creatorKeypair;
    if (!creator) {
      return { success: false, error: 'Creator keypair required to resolve market' };
    }

    console.log(`[PollFun] Resolving market ${betPda}: ${winningOutcome} wins`);

    try {
      // AUTO: Ensure creator's program account exists before resolving
      const userResult = await this.ensureUserExists(creator);
      if (!userResult.success) {
        return { success: false, error: `Failed to initialize creator account: ${userResult.error}` };
      }

      const outcome = winningOutcome === 'YES' ? Outcome.For : Outcome.Against;

      // First initiate vote phase
      const initTx = await this.sdk.initiateVoteV2({
        bet: new PublicKey(betPda),
        signers: [creator],
        payerOverride: creator.publicKey
      });
      console.log('[PollFun] Vote phase initiated:', initTx);

      // Then place creator's vote (resolves immediately since isCreatorResolver=true)
      const voteTx = await this.sdk.placeVoteV2({
        bet: new PublicKey(betPda),
        outcome,
        signers: [creator],
        payerOverride: creator.publicKey
      });
      console.log('[PollFun] Market resolved:', voteTx);

      return {
        success: true,
        betPda,
        winningOutcome,
        initiateTx: initTx,
        resolveTx: voteTx
      };
    } catch (error) {
      console.error('[PollFun] Failed to resolve market:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Settle payouts for a resolved market
   * Distributes winnings to all winners in batches
   *
   * @param {Object} params Settlement parameters
   * @param {string} params.betPda Market PDA address
   * @param {number} params.batchNumber Which batch to settle (0-indexed)
   * @param {number} params.usersPerBatch Users per batch (recommended: 10-20)
   * @param {Keypair} params.creatorKeypair Creator's keypair
   * @returns {Object} Settlement result
   */
  async settleBatch(params) {
    const { betPda, batchNumber = 0, usersPerBatch = 10, creatorKeypair } = params;

    const creator = creatorKeypair || this.creatorKeypair;
    if (!creator) {
      return { success: false, error: 'Creator keypair required to settle' };
    }

    console.log(`[PollFun] Settling batch ${batchNumber} for market ${betPda}`);

    try {
      const txHash = await this.sdk.settleBetBatchV2({
        bet: new PublicKey(betPda),
        batchNumber,
        usersPerBatch,
        signers: [creator],
        payerOverride: creator.publicKey
      });

      console.log('[PollFun] Batch settled:', txHash);

      return {
        success: true,
        betPda,
        batchNumber,
        txSignature: txHash
      };
    } catch (error) {
      console.error('[PollFun] Failed to settle batch:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get market (bet) data from on-chain
   * @param {string} betPda Market PDA address
   * @returns {Object} Market data
   */
  async getMarketData(betPda) {
    try {
      const betAccount = await this.sdk.accounts.betV2.single(new PublicKey(betPda));

      // Calculate odds from pool sizes
      const totalOi = (betAccount.totalOiFor || 0) + (betAccount.totalOiAgainst || 0);
      const yesPool = betAccount.totalOiFor || 0;
      const noPool = betAccount.totalOiAgainst || 0;

      return {
        success: true,
        betPda,
        question: betAccount.question,
        creator: betAccount.creator.toBase58(),
        status: SDK.convertRustEnumValueToString(betAccount.status),
        isCreatorResolver: betAccount.isCreatorResolver,
        expectedUserCount: betAccount.expectedUserCount,
        currentUserCount: betAccount.wagers?.length || 0,
        minimumVoteCount: betAccount.minimumVoteCount,
        totalPool: totalOi / 1e6, // Convert from USDC lamports
        yesPool: yesPool / 1e6,
        noPool: noPool / 1e6,
        yesOdds: totalOi > 0 ? noPool / totalOi : 0.5,
        noOdds: totalOi > 0 ? yesPool / totalOi : 0.5,
        resolvedOutcome: betAccount.resolvedOutcome !== undefined ?
          SDK.convertRustEnumValueToString(betAccount.resolvedOutcome) : null,
        wagers: betAccount.wagers?.map(w => ({
          user: w.user.toBase58(),
          amount: (w.amount || 0) / 1e6,
          side: SDK.convertRustEnumValueToString(w.side),
          hasVoted: w.hasVoted,
          votedOutcome: w.votedOutcome ? SDK.convertRustEnumValueToString(w.votedOutcome) : null
        })) || []
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user account data
   * @param {string} userPubkey User's public key
   * @returns {Object} User data
   */
  async getUserData(userPubkey) {
    try {
      const userAddress = this.sdk.addresses.user.get(new PublicKey(userPubkey));
      const userAccount = await this.sdk.accounts.user.single(userAddress);

      return {
        success: true,
        user: userPubkey,
        userAddress: userAddress.toBase58(),
        totalWagersCount: userAccount.totalWagersCount,
        totalWageredAmount: (userAccount.totalWageredAmount || 0) / 1e6,
        inWagerAmount: (userAccount.inWagerAmount || 0) / 1e6,
        nextWagerId: userAccount.nextWagerId
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Close a resolved & settled market to reclaim rent SOL
   * Call this after all settlement batches are complete (status = Distributed)
   * Returns ~0.039 SOL rent back to the creator wallet
   *
   * @param {Object} params Parameters
   * @param {string} params.betPda Market PDA address
   * @param {Keypair} params.creatorKeypair Creator's keypair (must be original creator)
   * @returns {Object} Result with reclaimed rent info
   */
  async closeBet(params) {
    const { betPda, creatorKeypair } = params;

    const creator = creatorKeypair || this.creatorKeypair;
    if (!creator) {
      return { success: false, error: 'Creator keypair required to close bet' };
    }

    console.log(`[PollFun] Closing bet to reclaim rent: ${betPda}`);

    try {
      // Verify bet is in Distributed status before closing
      const betAccount = await this.sdk.accounts.betV2.single(new PublicKey(betPda));
      const status = SDK.convertRustEnumValueToString(betAccount.status);

      if (status !== 'Distributed') {
        return {
          success: false,
          error: `Cannot close bet in "${status}" status. Must be "Distributed" (fully settled).`
        };
      }

      // Get creator SOL balance before close (to calculate reclaimed amount)
      const balanceBefore = await this.connection.getBalance(creator.publicKey);

      const txHash = await this.sdk.closeBetV2({
        bet: new PublicKey(betPda),
        signers: [creator],
        payerOverride: creator.publicKey
      });

      console.log('[PollFun] Bet closed, rent reclaimed:', txHash);

      // Get balance after to calculate reclaimed amount
      const balanceAfter = await this.connection.getBalance(creator.publicKey);
      const reclaimedLamports = balanceAfter - balanceBefore;
      const reclaimedSOL = reclaimedLamports / 1e9;

      console.log(`[PollFun] Reclaimed ~${reclaimedSOL.toFixed(6)} SOL from closed bet`);

      return {
        success: true,
        betPda,
        txSignature: txHash,
        reclaimedLamports,
        reclaimedSOL
      };
    } catch (error) {
      console.error('[PollFun] Failed to close bet:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Cancel/withdraw a wager if market hasn't started resolving
   * @param {Object} params Parameters
   * @param {string} params.betPda Market PDA address
   * @param {Keypair} params.userKeypair User's keypair
   * @returns {Object} Result
   */
  async cancelWager(params) {
    const { betPda, userKeypair } = params;

    if (!userKeypair) {
      return { success: false, error: 'User keypair required' };
    }

    console.log('[PollFun] Attempting to cancel wager for market:', betPda);

    try {
      const txHash = await this.sdk.tryCancelWagerV2({
        bet: new PublicKey(betPda),
        signers: [userKeypair]
      });

      console.log('[PollFun] Wager cancelled:', txHash);

      return {
        success: true,
        txSignature: txHash,
        betPda
      };
    } catch (error) {
      console.error('[PollFun] Failed to cancel wager:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate potential payout for a wager
   * @param {Object} marketData Market data from getMarketData
   * @param {string} side 'YES' or 'NO'
   * @param {number} amount Wager amount in USDC
   * @returns {Object} Potential payout info
   */
  calculatePotentialPayout(marketData, side, amount) {
    const yesPool = marketData.yesPool || 0;
    const noPool = marketData.noPool || 0;
    const totalPool = yesPool + noPool;

    const isYes = side === 'YES';
    const myPool = isYes ? yesPool : noPool;
    const oppositePool = isYes ? noPool : yesPool;

    // After placing this bet
    const newMyPool = myPool + amount;
    const newTotal = totalPool + amount;

    // Your share of the winning pool
    const share = amount / newMyPool;

    // Potential winnings (your share of total pool minus protocol fee ~3%)
    const grossWinnings = newTotal * share;
    const netWinnings = grossWinnings * 0.97; // 3% protocol fee
    const profit = netWinnings - amount;

    // Implied probability
    const impliedProb = newMyPool / newTotal;

    return {
      side,
      wagerAmount: amount,
      potentialWinnings: Math.round(netWinnings * 100) / 100,
      potentialProfit: Math.round(profit * 100) / 100,
      impliedProbability: `${Math.round(impliedProb * 100)}%`,
      currentYesPool: yesPool,
      currentNoPool: noPool,
      newPoolSize: newTotal
    };
  }
}

// Export singleton instance and class
// NOTE: Poll.fun program (po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u) is deployed on MAINNET only
// Always default to mainnet for Poll.fun, unless explicitly overridden with POLLFUN_NETWORK
const pollFunNetwork = process.env.POLLFUN_NETWORK || 'mainnet';
console.log(`[PollFun] Using network: ${pollFunNetwork} (set POLLFUN_NETWORK env to override)`);
const pollFunService = new PollFunService({
  network: pollFunNetwork,
  rpcEndpoint: process.env.POLLFUN_RPC_URL || (pollFunNetwork === 'mainnet' ? 'https://api.mainnet.solana.com' : undefined)
});

module.exports = {
  PollFunService,
  pollFunService,
  USDC_MINT_DEVNET,
  USDC_MINT_MAINNET,
  Outcome,
  MarketStatus
};
