/**
 * AgentBets Escrow Module
 * Handles on-chain SOL escrow for bets
 *
 * For MVP: Centralized escrow wallet that holds bet funds
 * Production: Would use Program Derived Addresses (PDAs)
 */

const { Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

// Solana connection
const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_RPC, 'confirmed');

// Platform escrow wallet
const ESCROW_WALLET = process.env.ESCROW_WALLET || '48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM';

/**
 * Get escrow wallet keypair from environment
 */
function getEscrowKeypair() {
  const privateKey = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('SOLANA_PRIVATE_KEY not set - cannot access escrow wallet');
  }

  try {
    const decoded = bs58.decode(privateKey);
    return Keypair.fromSecretKey(decoded);
  } catch (error) {
    throw new Error(`Invalid private key format: ${error.message}`);
  }
}

/**
 * Verify a bet transaction on-chain
 * @param {string} txSignature - Transaction signature to verify
 * @param {string} fromWallet - Expected sender wallet
 * @param {number} amountLamports - Expected amount in lamports
 * @returns {Promise<{verified: boolean, error?: string}>}
 */
async function verifyBetTransaction(txSignature, fromWallet, amountLamports) {
  try {
    // Get transaction details
    const tx = await connection.getTransaction(txSignature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      return { verified: false, error: 'Transaction not found' };
    }

    // Check if transaction was successful
    if (tx.meta?.err) {
      return { verified: false, error: 'Transaction failed on-chain' };
    }

    // Verify the transfer details
    const accountKeys = tx.transaction.message.staticAccountKeys ||
                       tx.transaction.message.accountKeys;

    // Check pre/post balances to verify transfer amount
    const preBalances = tx.meta.preBalances;
    const postBalances = tx.meta.postBalances;

    // Find escrow wallet in account keys
    const escrowIndex = accountKeys.findIndex(
      key => key.toString() === ESCROW_WALLET
    );

    if (escrowIndex === -1) {
      return { verified: false, error: 'Escrow wallet not found in transaction' };
    }

    // Check that escrow received funds
    const escrowReceived = postBalances[escrowIndex] - preBalances[escrowIndex];

    // Allow small variance for fees
    if (escrowReceived < amountLamports * 0.99) {
      return {
        verified: false,
        error: `Amount mismatch: expected ${amountLamports}, received ${escrowReceived}`
      };
    }

    return { verified: true };
  } catch (error) {
    return { verified: false, error: error.message };
  }
}

/**
 * Create a bet deposit instruction
 * Returns transaction that user should sign and send
 * @param {string} betterWallet - Wallet placing the bet
 * @param {number} amountLamports - Bet amount in lamports
 * @returns {Promise<{transaction: string, escrowWallet: string}>}
 */
async function createBetDepositInstruction(betterWallet, amountLamports) {
  try {
    const fromPubkey = new PublicKey(betterWallet);
    const toPubkey = new PublicKey(ESCROW_WALLET);

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    // Create transfer instruction
    const transaction = new Transaction({
      feePayer: fromPubkey,
      blockhash,
      lastValidBlockHeight
    }).add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: amountLamports
      })
    );

    // Serialize for client signing
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });

    return {
      transaction: serialized.toString('base64'),
      escrowWallet: ESCROW_WALLET,
      amountLamports,
      amountSOL: amountLamports / LAMPORTS_PER_SOL,
      blockhash,
      message: `Send ${amountLamports / LAMPORTS_PER_SOL} SOL to escrow`
    };
  } catch (error) {
    throw new Error(`Failed to create deposit instruction: ${error.message}`);
  }
}

/**
 * Process a payout from escrow to winner
 * @param {string} winnerWallet - Wallet to receive payout
 * @param {number} amountLamports - Payout amount in lamports
 * @returns {Promise<{success: boolean, signature?: string, error?: string}>}
 */
async function processWinnerPayout(winnerWallet, amountLamports) {
  try {
    const escrowKeypair = getEscrowKeypair();
    const toPubkey = new PublicKey(winnerWallet);

    // Verify escrow has sufficient balance
    const escrowBalance = await connection.getBalance(escrowKeypair.publicKey);
    if (escrowBalance < amountLamports + 5000) { // 5000 lamports for tx fee
      return {
        success: false,
        error: `Insufficient escrow balance: ${escrowBalance / LAMPORTS_PER_SOL} SOL`
      };
    }

    // Get recent blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

    // Create transfer transaction
    const transaction = new Transaction({
      feePayer: escrowKeypair.publicKey,
      blockhash,
      lastValidBlockHeight
    }).add(
      SystemProgram.transfer({
        fromPubkey: escrowKeypair.publicKey,
        toPubkey,
        lamports: amountLamports
      })
    );

    // Sign and send
    transaction.sign(escrowKeypair);
    const signature = await connection.sendRawTransaction(transaction.serialize());

    // Wait for confirmation
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight
    }, 'confirmed');

    return {
      success: true,
      signature,
      amountSOL: amountLamports / LAMPORTS_PER_SOL,
      explorer: `https://solscan.io/tx/${signature}?cluster=devnet`
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Get escrow wallet balance
 * @returns {Promise<{balance: number, balanceSOL: number}>}
 */
async function getEscrowBalance() {
  try {
    const escrowPubkey = new PublicKey(ESCROW_WALLET);
    const balance = await connection.getBalance(escrowPubkey);

    return {
      wallet: ESCROW_WALLET,
      balance,
      balanceSOL: balance / LAMPORTS_PER_SOL
    };
  } catch (error) {
    throw new Error(`Failed to get escrow balance: ${error.message}`);
  }
}

/**
 * Batch process payouts for a resolved market
 * @param {Array<{wallet: string, amount: number}>} payouts - Array of payout details
 * @returns {Promise<{success: boolean, results: Array, totalPaid: number}>}
 */
async function batchProcessPayouts(payouts) {
  const results = [];
  let totalPaid = 0;

  for (const payout of payouts) {
    const result = await processWinnerPayout(payout.wallet, payout.amount);
    results.push({
      wallet: payout.wallet,
      amount: payout.amount,
      ...result
    });

    if (result.success) {
      totalPaid += payout.amount;
    }

    // Small delay between transactions to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return {
    success: results.every(r => r.success),
    results,
    totalPaid,
    totalPaidSOL: totalPaid / LAMPORTS_PER_SOL
  };
}

module.exports = {
  verifyBetTransaction,
  createBetDepositInstruction,
  processWinnerPayout,
  getEscrowBalance,
  batchProcessPayouts,
  ESCROW_WALLET,
  LAMPORTS_PER_SOL
};
