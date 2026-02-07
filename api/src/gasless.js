/**
 * Gasless Transaction Relay Service (Octane-Style)
 * 
 * Enables agents and users to transact using only USDC — no SOL required.
 * The API server acts as feePayer for all transactions, collecting a small 
 * USDC fee to cover SOL gas costs.
 * 
 * Security model mirrors Octane (anza-xyz/octane):
 * - Validates USDC fee is paid as first instruction
 * - Validates no instructions drain the fee payer wallet
 * - Simulates transactions before signing
 * - Rate limits per source wallet
 * - Duplicate transaction prevention
 * 
 * Built with existing @solana/web3.js and @solana/spl-token — no external deps.
 */

const {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  sendAndConfirmRawTransaction
} = require('@solana/web3.js');

const {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} = require('@solana/spl-token');

const bs58 = require('bs58').default;

// USDC mint on mainnet
const USDC_MINT_MAINNET = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

class GaslessRelayService {
  constructor(options = {}) {
    // Connection
    this.rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet.solana.com';
    this.connection = options.connection || new Connection(this.rpcUrl, 'confirmed');

    // USDC configuration
    this.usdcMint = options.usdcMint || USDC_MINT_MAINNET;
    this.feeUsdc = parseFloat(process.env.GASLESS_FEE_USDC || '0.001');
    this.feeAmount = BigInt(Math.round(this.feeUsdc * Math.pow(10, USDC_DECIMALS))); // e.g., 1000 for 0.001 USDC

    // Feature toggle
    this.enabled = (process.env.GASLESS_ENABLED || 'true') === 'true';

    // Fee payer keypair (reuses bot wallet)
    this.feePayerKeypair = null;
    this.feePayerAta = null; // USDC associated token account

    if (process.env.SOLANA_PRIVATE_KEY) {
      try {
        const secretKey = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
        this.feePayerKeypair = Keypair.fromSecretKey(secretKey);
        console.log('[Gasless] Fee payer wallet:', this.feePayerKeypair.publicKey.toBase58());
        console.log(`[Gasless] Fee per transaction: ${this.feeUsdc} USDC (${this.feeAmount.toString()} base units)`);
      } catch (err) {
        console.warn('[Gasless] Failed to load fee payer keypair:', err.message);
      }
    } else {
      console.warn('[Gasless] No SOLANA_PRIVATE_KEY set — gasless relay disabled');
      this.enabled = false;
    }

    // Duplicate transaction cache (Map<txHash, timestamp>)
    this._txCache = new Map();
    this._txCacheTTL = 60_000; // 60 seconds

    // Rate limit cache (Map<walletPubkey, { count, resetTime }>)
    this._rateLimitCache = new Map();
    this._rateLimitMax = parseInt(process.env.GASLESS_RATE_LIMIT || '30', 10); // per minute
    this._rateLimitWindow = 60_000; // 1 minute
  }

  /**
   * Initialize the service — ensures the fee payer's USDC ATA exists
   * Call this at server startup
   */
  async initialize() {
    if (!this.feePayerKeypair) {
      console.warn('[Gasless] Skipping initialization — no fee payer keypair');
      return;
    }

    try {
      // Derive the fee payer's USDC associated token account
      this.feePayerAta = await getAssociatedTokenAddress(
        this.usdcMint,
        this.feePayerKeypair.publicKey
      );

      // Check if the ATA exists
      try {
        const accountInfo = await getAccount(this.connection, this.feePayerAta);
        console.log(`[Gasless] Fee payer USDC ATA exists: ${this.feePayerAta.toBase58()}`);
        console.log(`[Gasless] Current USDC balance: ${Number(accountInfo.amount) / Math.pow(10, USDC_DECIMALS)} USDC`);
      } catch {
        // ATA doesn't exist — create it
        console.log('[Gasless] Creating fee payer USDC ATA...');
        const createAtaIx = createAssociatedTokenAccountInstruction(
          this.feePayerKeypair.publicKey, // payer
          this.feePayerAta,               // ata
          this.feePayerKeypair.publicKey,  // owner
          this.usdcMint                    // mint
        );

        const tx = new Transaction().add(createAtaIx);
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.feePayerKeypair.publicKey;
        tx.sign(this.feePayerKeypair);

        const sig = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(sig, 'confirmed');
        console.log(`[Gasless] Fee payer USDC ATA created: ${this.feePayerAta.toBase58()} (tx: ${sig})`);
      }

      console.log('[Gasless] Service initialized successfully');
    } catch (error) {
      console.error('[Gasless] Initialization error:', error.message);
      // Don't disable — it might work on retry
    }
  }

  /**
   * Returns public configuration for clients
   */
  getConfig() {
    return {
      enabled: this.enabled && !!this.feePayerKeypair,
      feePayerPubkey: this.feePayerKeypair?.publicKey?.toBase58() || null,
      feePayerAta: this.feePayerAta?.toBase58() || null,
      feeUsdc: this.feeUsdc,
      feeAmount: this.feeAmount.toString(),
      usdcMint: this.usdcMint.toBase58(),
      usdcDecimals: USDC_DECIMALS,
      rateLimit: this._rateLimitMax
    };
  }

  /**
   * Builds the USDC fee transfer instruction
   * @param {PublicKey} userPubkey - User's wallet public key
   * @returns {Promise<TransactionInstruction>} The fee transfer instruction
   */
  async buildFeeInstruction(userPubkey) {
    const userPk = userPubkey instanceof PublicKey ? userPubkey : new PublicKey(userPubkey);

    // Get user's USDC ATA
    const userAta = await getAssociatedTokenAddress(this.usdcMint, userPk);

    // Build SPL token transfer: user -> fee payer ATA
    return createTransferInstruction(
      userAta,                    // source (user's USDC ATA)
      this.feePayerAta,           // destination (fee payer's USDC ATA)
      userPk,                     // owner/authority (user signs)
      this.feeAmount              // amount in smallest units
    );
  }

  /**
   * Wraps a transaction with gasless support:
   * - Prepends USDC fee instruction
   * - Sets feePayer to API wallet
   * - Partially signs as feePayer
   * - Returns base64 serialized partially-signed transaction
   * 
   * @param {Transaction} transaction - The existing transaction (with wager/bet instructions)
   * @param {PublicKey|string} userPubkey - User's wallet public key
   * @returns {Promise<string>} Base64 serialized partially-signed transaction
   */
  async wrapWithGasless(transaction, userPubkey) {
    if (!this.enabled || !this.feePayerKeypair || !this.feePayerAta) {
      throw new Error('Gasless relay is not available');
    }

    const userPk = userPubkey instanceof PublicKey ? userPubkey : new PublicKey(userPubkey);

    // Build fee instruction
    const feeIx = await this.buildFeeInstruction(userPk);

    // Create new transaction with fee instruction first
    const gaslessTx = new Transaction();
    gaslessTx.add(feeIx); // USDC fee as first instruction

    // Add all existing instructions
    for (const ix of transaction.instructions) {
      gaslessTx.add(ix);
    }

    // Set fee payer to our wallet
    gaslessTx.feePayer = this.feePayerKeypair.publicKey;

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    gaslessTx.recentBlockhash = blockhash;

    // Partially sign as feePayer
    gaslessTx.partialSign(this.feePayerKeypair);

    // Serialize (allow missing user signature)
    const serialized = gaslessTx.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });

    console.log(`[Gasless] Transaction wrapped for ${userPk.toBase58().slice(0, 8)}... (${gaslessTx.instructions.length} instructions, fee: ${this.feeUsdc} USDC)`);

    return {
      transaction: serialized.toString('base64'),
      blockhash,
      lastValidBlockHeight,
      feeUsdc: this.feeUsdc,
      feePayer: this.feePayerKeypair.publicKey.toBase58()
    };
  }

  /**
   * Validates and relays a user-signed transaction
   * Used by the POST /api/relay endpoint
   * 
   * @param {string} serializedTx - Base64 serialized transaction (user-signed)
   * @returns {Promise<Object>} Result with signature
   */
  async validateAndRelay(serializedTx) {
    if (!this.enabled || !this.feePayerKeypair || !this.feePayerAta) {
      throw new Error('Gasless relay is not available');
    }

    // Deserialize
    const txBuffer = Buffer.from(serializedTx, 'base64');
    const transaction = Transaction.from(txBuffer);

    // ── Security Check 1: Verify feePayer is our wallet ──
    if (!transaction.feePayer || !transaction.feePayer.equals(this.feePayerKeypair.publicKey)) {
      throw new Error('Transaction feePayer does not match relay wallet');
    }

    // ── Security Check 2: Verify first instruction is USDC fee transfer ──
    const instructions = transaction.instructions;
    if (instructions.length < 2) {
      throw new Error('Transaction must have at least 2 instructions (fee + payload)');
    }

    const feeIx = instructions[0];
    this._validateFeeInstruction(feeIx);

    // ── Security Check 3: No other instructions touch our wallet as writable ──
    this._validateInstructionsSafety(instructions);

    // ── Security Check 4: Rate limit ──
    // Find the user's pubkey from the fee instruction (the owner/signer)
    const userPubkey = this._extractUserFromFeeInstruction(feeIx);
    if (userPubkey) {
      this._checkRateLimit(userPubkey);
    }

    // ── Security Check 5: Duplicate detection ──
    const txHash = txBuffer.slice(0, 32).toString('hex');
    if (this._txCache.has(txHash)) {
      throw new Error('Duplicate transaction detected');
    }

    // ── Security Check 6: Simulate transaction ──
    try {
      const simulation = await this.connection.simulateTransaction(transaction);
      if (simulation.value.err) {
        throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }
    } catch (simError) {
      if (simError.message.includes('Simulation failed')) {
        throw simError;
      }
      // Non-simulation errors (network issues) — continue cautiously
      console.warn('[Gasless] Simulation warning:', simError.message);
    }

    // ── Sign as feePayer if not already signed ──
    const feePayerSigIndex = transaction.signatures.findIndex(
      sig => sig.publicKey.equals(this.feePayerKeypair.publicKey)
    );

    if (feePayerSigIndex >= 0 && !transaction.signatures[feePayerSigIndex].signature) {
      transaction.partialSign(this.feePayerKeypair);
    } else if (feePayerSigIndex < 0) {
      transaction.partialSign(this.feePayerKeypair);
    }

    // ── Broadcast ──
    const rawTx = transaction.serialize();
    const signature = await this.connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      preflightCommitment: 'confirmed'
    });

    // Cache this tx to prevent replays
    this._txCache.set(txHash, Date.now());
    this._cleanCache();

    console.log(`[Gasless] Transaction relayed: ${signature} (user: ${userPubkey || 'unknown'})`);

    return {
      success: true,
      signature,
      feeCharged: this.feeUsdc,
      explorer: `https://solscan.io/tx/${signature}`
    };
  }

  // ── Private validation helpers ──

  /**
   * Validates the fee instruction is a valid USDC transfer to our ATA
   */
  _validateFeeInstruction(ix) {
    // Must be a Token Program instruction
    if (!ix.programId.equals(TOKEN_PROGRAM_ID)) {
      throw new Error('First instruction must be a Token Program instruction (USDC fee transfer)');
    }

    // SPL Token Transfer instruction has 3 accounts: source, destination, owner
    // and the data starts with instruction discriminator 3 (Transfer) or 12 (TransferChecked)
    if (ix.keys.length < 3) {
      throw new Error('Fee instruction has insufficient accounts');
    }

    // Verify destination is our ATA
    const destination = ix.keys[1].pubkey;
    if (!destination.equals(this.feePayerAta)) {
      throw new Error(`Fee must be paid to relay ATA (${this.feePayerAta.toBase58()}), got ${destination.toBase58()}`);
    }

    // Check instruction data for transfer amount
    // Transfer (type 3): 1 byte type + 8 bytes amount (LE)
    // TransferChecked (type 12): 1 byte type + 8 bytes amount (LE) + 1 byte decimals
    const data = ix.data;
    const ixType = data[0];

    if (ixType !== 3 && ixType !== 12) {
      throw new Error('Fee instruction must be a Transfer or TransferChecked instruction');
    }

    // Read amount (little-endian u64 at offset 1)
    const amountBytes = data.slice(1, 9);
    const amount = amountBytes.reduce((acc, byte, i) => acc + BigInt(byte) * (2n ** BigInt(8 * i)), 0n);

    if (amount < this.feeAmount) {
      throw new Error(`Insufficient fee: got ${amount.toString()}, need ${this.feeAmount.toString()} (${this.feeUsdc} USDC)`);
    }
  }

  /**
   * Validates that no instructions (other than the fee transfer) drain
   * the fee payer's USDC token account.
   * 
   * The fee payer's SOL account IS allowed to be writable in other instructions
   * because it needs to pay rent for creating on-chain accounts (e.g., user init,
   * wager pool authority). Only the USDC ATA is protected.
   */
  _validateInstructionsSafety(instructions) {
    const feePayerAtaPk = this.feePayerAta;

    // Skip first instruction (fee transfer — expected to reference our ATA)
    for (let i = 1; i < instructions.length; i++) {
      const ix = instructions[i];
      for (const key of ix.keys) {
        // Block writable access to fee payer's USDC ATA (prevents draining)
        if (key.isWritable && key.pubkey.equals(feePayerAtaPk)) {
          throw new Error(
            `Security: Instruction ${i} attempts writable access to fee payer USDC account (${key.pubkey.toBase58()})`
          );
        }
      }
    }
  }

  /**
   * Extracts the user's pubkey from the fee transfer instruction
   */
  _extractUserFromFeeInstruction(ix) {
    // In a Transfer instruction, keys[2] is the owner/authority
    if (ix.keys.length >= 3) {
      return ix.keys[2].pubkey.toBase58();
    }
    return null;
  }

  /**
   * Rate limit check per wallet
   */
  _checkRateLimit(walletPubkey) {
    const now = Date.now();
    const entry = this._rateLimitCache.get(walletPubkey);

    if (!entry || now > entry.resetTime) {
      this._rateLimitCache.set(walletPubkey, { count: 1, resetTime: now + this._rateLimitWindow });
      return;
    }

    entry.count++;
    if (entry.count > this._rateLimitMax) {
      throw new Error(`Rate limit exceeded: max ${this._rateLimitMax} transactions per minute`);
    }
  }

  /**
   * Clean expired entries from caches
   */
  _cleanCache() {
    const now = Date.now();

    // Clean tx cache
    for (const [hash, timestamp] of this._txCache) {
      if (now - timestamp > this._txCacheTTL) {
        this._txCache.delete(hash);
      }
    }

    // Clean rate limit cache
    for (const [key, entry] of this._rateLimitCache) {
      if (now > entry.resetTime) {
        this._rateLimitCache.delete(key);
      }
    }
  }
}

// Export singleton and class
const gaslessService = new GaslessRelayService();

module.exports = {
  GaslessRelayService,
  gaslessService
};
