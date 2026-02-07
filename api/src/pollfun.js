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

    // DEDUPLICATION: Prevent concurrent market creation
    this._creationLock = false; // Simple lock to serialize market creation
    this._recentQuestions = new Map(); // question -> { timestamp, betPda } — dedup window

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

    // DEDUPLICATION: Normalize question for comparison
    const normalizedQ = question.replace(/\s+/g, ' ').trim().toLowerCase();

    // Check if we recently created a market with the same (or very similar) question
    const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10-minute dedup window
    const now = Date.now();
    // Clean up expired entries
    for (const [q, data] of this._recentQuestions) {
      if (now - data.timestamp > DEDUP_WINDOW_MS) {
        this._recentQuestions.delete(q);
      }
    }
    // Check for duplicate
    const existing = this._recentQuestions.get(normalizedQ);
    if (existing) {
      console.warn(`[PollFun] DUPLICATE BLOCKED: Market with same question was created ${Math.round((now - existing.timestamp) / 1000)}s ago. PDA: ${existing.betPda}`);
      return {
        success: false,
        error: `Duplicate market: A market with this question was already created ${Math.round((now - existing.timestamp) / 1000)} seconds ago (PDA: ${existing.betPda}). Wait 10 minutes before creating another market with the same question.`
      };
    }

    // CONCURRENCY LOCK: Only one market creation at a time
    if (this._creationLock) {
      console.warn('[PollFun] CONCURRENT CREATION BLOCKED: Another market is currently being created');
      return {
        success: false,
        error: 'Another market is currently being created. Please wait a moment and try again.'
      };
    }
    this._creationLock = true;

    console.log('[PollFun] Creating market:', question);

    try {
      // Check creator wallet balance before attempting market creation
      // Each market costs ~0.039 SOL for rent (Bet PDA + Fee Pool PDA)
      const MIN_BALANCE_LAMPORTS = 50_000_000; // 0.05 SOL (rent + tx fees buffer)
      const balance = await this.connection.getBalance(creator.publicKey);
      const balanceSOL = (balance / 1e9).toFixed(4);
      console.log(`[PollFun] Creator wallet balance: ${balanceSOL} SOL (${balance} lamports)`);

      if (balance < MIN_BALANCE_LAMPORTS) {
        const needed = ((MIN_BALANCE_LAMPORTS - balance) / 1e9).toFixed(4);
        console.error(`[PollFun] Insufficient SOL! Balance: ${balanceSOL} SOL, need at least 0.05 SOL per market`);
        console.error(`[PollFun] Send at least ${needed} SOL to ${creator.publicKey.toBase58()}`);
        return {
          success: false,
          error: `Insufficient SOL in creator wallet. Balance: ${balanceSOL} SOL, need ~0.05 SOL. Send SOL to ${creator.publicKey.toBase58()}`
        };
      }

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

      const betPda = result.bet.toBase58();
      // Record in dedup map so the same question can't be created again within the window
      this._recentQuestions.set(normalizedQ, { timestamp: Date.now(), betPda });
      this._creationLock = false;

      return {
        success: true,
        betPda,
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

      // TIMEOUT RECOVERY: If the error message contains a transaction signature,
      // the transaction was submitted but confirmation timed out.
      // Check if it actually succeeded on-chain before declaring failure.
      const txSigMatch = error.message?.match(/Check signature (\w{80,90})/);
      if (txSigMatch || (error.message?.includes('was not confirmed') && error.message?.includes('seconds'))) {
        const txSignature = txSigMatch?.[1] || error.message.match(/([1-9A-HJ-NP-Za-km-z]{87,88})/)?.[1];
        if (txSignature) {
          console.log(`[PollFun] Transaction timed out but may have succeeded. Checking signature: ${txSignature}`);
          try {
            const recovered = await this.recoverMarketFromTx(txSignature, creator.publicKey.toBase58(), proposerAgent);
            if (recovered.success) {
              console.log(`[PollFun] RECOVERED! Market exists on-chain despite timeout. PDA: ${recovered.betPda}`);
              // Record in dedup map even for recovered markets
              this._recentQuestions.set(normalizedQ, { timestamp: Date.now(), betPda: recovered.betPda });
              this._creationLock = false;
              return recovered;
            }
          } catch (recoveryErr) {
            console.error('[PollFun] Recovery check failed:', recoveryErr.message);
          }
        }
      }

      this._creationLock = false;
      return { success: false, error: error.message };
    }
  }

  /**
   * Attempt to recover market data from a transaction that may have succeeded
   * despite a confirmation timeout. This is a READ-ONLY operation.
   *
   * @param {string} txSignature Transaction signature to check
   * @param {string} creatorAddress Bot's wallet address (for validation)
   * @param {string} proposerAgent Optional agent who proposed the market
   * @returns {Object} Market data if recovered, or { success: false }
   */
  async recoverMarketFromTx(txSignature, creatorAddress, proposerAgent) {
    // Wait a few seconds for the transaction to finalize
    console.log('[PollFun] Waiting 5 seconds before checking transaction...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Retry up to 3 times with increasing delay
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tx = await this.connection.getTransaction(txSignature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });

        if (!tx) {
          console.log(`[PollFun] Transaction not found yet (attempt ${attempt + 1}/3)`);
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
          }
          return { success: false, error: 'Transaction not found on-chain' };
        }

        // Check if the transaction actually succeeded
        if (tx.meta?.err) {
          console.log('[PollFun] Transaction exists but FAILED on-chain:', JSON.stringify(tx.meta.err));
          return { success: false, error: `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}` };
        }

        // Transaction succeeded! Extract the bet PDA from account keys.
        // In InitializeBetV2, the bet PDA is typically account index 1
        // (index 0 is the creator/signer)
        const accountKeys = tx.transaction?.message?.accountKeys ||
                           tx.transaction?.message?.staticAccountKeys || [];
        const accounts = accountKeys.map(k => typeof k === 'string' ? k : k.toBase58?.() || String(k));

        if (accounts.length < 5) {
          return { success: false, error: 'Transaction has too few accounts to be a market creation' };
        }

        // The bet PDA is at index 1, fee pool at index 3 or 4
        // Validate by checking on-chain data
        const candidatePda = accounts[1];

        try {
          const marketData = await this.getMarketData(candidatePda);
          if (marketData.success) {
            console.log(`[PollFun] Verified market on-chain! PDA: ${candidatePda}, Question: "${marketData.question?.slice(0, 50)}..."`);
            return {
              success: true,
              recovered: true,
              betPda: candidatePda,
              feePool: null, // Not critical for local storage
              txSignature,
              creator: creatorAddress,
              proposerAgent: proposerAgent || null,
              question: marketData.question,
              expectedUserCount: marketData.expectedUserCount || 50,
              isCreatorResolver: marketData.isCreatorResolver || true,
              note: 'Market recovered from timed-out transaction.'
            };
          }
        } catch {
          // candidatePda wasn't the bet PDA, try other accounts
        }

        // Fallback: try other non-system-program accounts
        const systemPrograms = new Set([
          '11111111111111111111111111111111',
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
          'SysvarRent111111111111111111111111111111111',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          'po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u'
        ]);

        for (let i = 2; i < Math.min(accounts.length, 8); i++) {
          if (systemPrograms.has(accounts[i])) continue;
          if (accounts[i] === creatorAddress) continue;
          try {
            const marketData = await this.getMarketData(accounts[i]);
            if (marketData.success) {
              console.log(`[PollFun] Verified market on-chain at index ${i}! PDA: ${accounts[i]}`);
              return {
                success: true,
                recovered: true,
                betPda: accounts[i],
                feePool: null,
                txSignature,
                creator: creatorAddress,
                proposerAgent: proposerAgent || null,
                question: marketData.question,
                expectedUserCount: marketData.expectedUserCount || 50,
                isCreatorResolver: marketData.isCreatorResolver || true,
                note: 'Market recovered from timed-out transaction.'
              };
            }
          } catch {
            continue;
          }
        }

        return { success: false, error: 'Transaction succeeded but could not identify bet PDA' };
      } catch (err) {
        console.error(`[PollFun] Error checking transaction (attempt ${attempt + 1}/3):`, err.message);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    return { success: false, error: 'Could not verify transaction after 3 attempts' };
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

    console.log(`[PollFun] Building wager instruction: ${amount} USDC on ${side} for user ${userPubkey.slice(0, 8)}...`);

    try {
      // Map YES/NO to Poll.fun Outcome enum
      const outcome = side === 'YES' ? Outcome.For : Outcome.Against;

      // payerOverride = the USER (owner, identity, USDC source — always the bettor)
      // feePayerOverride = who pays SOL gas (API wallet in gasless mode, otherwise user)
      const ix = await this.sdk.instructions.placeWagerV2({
        bet: new PublicKey(betPda),
        amount, // SDK handles USDC decimals
        side: outcome,
        payerOverride: new PublicKey(userPubkey),
        feePayerOverride: feePayerPubkey ? new PublicKey(feePayerPubkey) : undefined
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

      // totalOiFor/Against are BN objects from Anchor - convert to numbers
      const yesPool = betAccount.totalOiFor ? betAccount.totalOiFor.toNumber() : 0;
      const noPool = betAccount.totalOiAgainst ? betAccount.totalOiAgainst.toNumber() : 0;
      const totalOi = yesPool + noPool;

      // Safely convert enum values (some may be undefined)
      const safeEnumToString = (val) => {
        if (val === undefined || val === null) return null;
        try { return SDK.convertRustEnumValueToString(val); } catch { return null; }
      };

      return {
        success: true,
        betPda,
        question: betAccount.question,
        creator: betAccount.creator?.toBase58?.() || String(betAccount.creator),
        status: safeEnumToString(betAccount.status) || 'Unknown',
        isCreatorResolver: betAccount.isCreatorResolver,
        expectedUserCount: betAccount.expectedUserCount,
        currentUserCount: betAccount.wagers?.length || 0,
        minimumVoteCount: betAccount.minimumVoteCount,
        totalPool: totalOi / 1e6, // Convert from USDC micro-units
        yesPool: yesPool / 1e6,
        noPool: noPool / 1e6,
        yesOdds: totalOi > 0 ? yesPool / totalOi : 0.5,
        noOdds: totalOi > 0 ? noPool / totalOi : 0.5,
        resolvedOutcome: safeEnumToString(betAccount.resolvedOutcome),
        wagers: betAccount.wagers?.map(w => ({
          user: w.user?.toBase58?.() || String(w.user),
          amount: (w.amount ? w.amount.toNumber() : 0) / 1e6,
          side: safeEnumToString(w.outcome) || 'Unknown',
          status: safeEnumToString(w.status) || 'Unknown',
          isVoteInitiator: w.isVoteInitiator || false
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
   * 
   * NOTE: closeBetV2 requires the Poll.fun protocol's update authority,
   * NOT the market creator. Only the Poll.fun team can close bets.
   * This method is kept for future use if Poll.fun adds creator-level close.
   * 
   * Current cost per market: ~0.039 SOL rent (non-recoverable by creators)
   *
   * @param {Object} params Parameters
   * @param {string} params.betPda Market PDA address
   * @param {Keypair} params.creatorKeypair Creator's keypair
   * @returns {Object} Result
   */
  async closeBet(params) {
    const { betPda, creatorKeypair } = params;

    const creator = creatorKeypair || this.creatorKeypair;
    if (!creator) {
      return { success: false, error: 'Creator keypair required to close bet' };
    }

    console.log(`[PollFun] Attempting to close bet: ${betPda}`);
    console.warn('[PollFun] Note: closeBetV2 requires Poll.fun protocol authority. Market creators cannot reclaim rent.');

    try {
      const betAccount = await this.sdk.accounts.betV2.single(new PublicKey(betPda));
      const status = SDK.convertRustEnumValueToString(betAccount.status);

      if (status !== 'Distributed') {
        return {
          success: false,
          error: `Cannot close bet in "${status}" status. Must be "Distributed" (fully settled).`,
          note: 'Even after settlement, only the Poll.fun protocol admin can close bets and reclaim rent.'
        };
      }

      // Attempt close (will fail with InvalidWithdrawAuthority unless caller is protocol admin)
      const balanceBefore = await this.connection.getBalance(creator.publicKey);

      const txHash = await this.sdk.closeBetV2({
        bet: new PublicKey(betPda),
        signers: [creator],
        payerOverride: creator.publicKey
      });

      const balanceAfter = await this.connection.getBalance(creator.publicKey);
      const reclaimedLamports = balanceAfter - balanceBefore;
      const reclaimedSOL = reclaimedLamports / 1e9;

      console.log(`[PollFun] Bet closed, reclaimed ~${reclaimedSOL.toFixed(6)} SOL`);

      return {
        success: true,
        betPda,
        txSignature: txHash,
        reclaimedLamports,
        reclaimedSOL
      };
    } catch (error) {
      // Expected: InvalidWithdrawAuthority if caller is not protocol admin
      if (error.message?.includes('InvalidWithdrawAuthority')) {
        console.warn(`[PollFun] Cannot close bet: requires Poll.fun protocol authority (not market creator)`);
        return {
          success: false,
          error: 'Only the Poll.fun protocol admin can close bets and reclaim rent. Contact Poll.fun team.',
          protocolLimited: true
        };
      }
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
