/**
 * Bet Model
 * 
 * Database operations for individual bets
 */

const { query, transaction } = require('../index');
const { v4: uuidv4 } = require('uuid');

const Bet = {
  /**
   * Create a new bet
   */
  async create(data) {
    const id = data.id || uuidv4();
    const result = await query(`
      INSERT INTO bets (
        id, market_id, wallet, outcome, amount, amount_sol, amount_usdc,
        currency, status, source, tx_signature, bet_pda, on_chain,
        agent_handle, x402_signature, payment_network
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING *
    `, [
      id,
      data.marketId || data.market_id,
      data.wallet,
      data.outcome,
      data.amount,
      data.amountSOL || data.amount_sol || null,
      data.amountUSDC || data.amount_usdc || null,
      data.currency || 'SOL',
      data.status || 'active',
      data.source || 'api',
      data.txSignature || data.tx_signature || null,
      data.betPda || data.bet_pda || null,
      data.onChain || data.on_chain || false,
      data.agentHandle || data.agent_handle || null,
      data.x402Signature || data.x402_signature || null,
      data.paymentNetwork || data.payment_network || null
    ]);
    return this.toJS(result.rows[0]);
  },

  /**
   * Find bet by ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM bets WHERE id = $1', [id]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Find bets by market ID
   */
  async findByMarketId(marketId) {
    const result = await query(
      'SELECT * FROM bets WHERE market_id = $1 ORDER BY placed_at DESC',
      [marketId]
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Find bets by wallet
   */
  async findByWallet(wallet) {
    const result = await query(
      'SELECT * FROM bets WHERE wallet = $1 ORDER BY placed_at DESC',
      [wallet]
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Find bets by wallet and market
   */
  async findByWalletAndMarket(wallet, marketId) {
    const result = await query(
      'SELECT * FROM bets WHERE wallet = $1 AND market_id = $2 ORDER BY placed_at DESC',
      [wallet, marketId]
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Update a bet
   */
  async update(id, data) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const fieldMap = {
      status: 'status',
      txSignature: 'tx_signature',
      betPda: 'bet_pda'
    };

    for (const [camelKey, snakeKey] of Object.entries(fieldMap)) {
      if (data[camelKey] !== undefined) {
        fields.push(`${snakeKey} = $${paramIndex++}`);
        values.push(data[camelKey]);
      }
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const sql = `UPDATE bets SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await query(sql, values);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Update bet status by market resolution
   */
  async updateByMarketResolution(marketId, winningOutcome) {
    // Update winning bets
    await query(`
      UPDATE bets SET status = 'won' 
      WHERE market_id = $1 AND outcome = $2 AND status = 'active'
    `, [marketId, winningOutcome]);

    // Update losing bets
    const losingOutcome = winningOutcome === 'YES' ? 'NO' : 'YES';
    await query(`
      UPDATE bets SET status = 'lost' 
      WHERE market_id = $1 AND outcome = $2 AND status = 'active'
    `, [marketId, losingOutcome]);
  },

  /**
   * Get all bets (with optional filters)
   */
  async findAll(filters = {}) {
    let sql = 'SELECT * FROM bets WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (filters.marketId) {
      sql += ` AND market_id = $${paramIndex++}`;
      params.push(filters.marketId);
    }

    if (filters.wallet) {
      sql += ` AND wallet = $${paramIndex++}`;
      params.push(filters.wallet);
    }

    if (filters.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(filters.status);
    }

    if (filters.outcome) {
      sql += ` AND outcome = $${paramIndex++}`;
      params.push(filters.outcome);
    }

    sql += ' ORDER BY placed_at DESC';

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }

    const result = await query(sql, params);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get bet statistics
   */
  async getStats() {
    const result = await query(`
      SELECT 
        COUNT(*) as total,
        SUM(amount) as total_volume,
        COUNT(DISTINCT wallet) as unique_wallets,
        COUNT(DISTINCT market_id) as markets_with_bets
      FROM bets
    `);
    const row = result.rows[0];
    return {
      total: parseInt(row.total) || 0,
      totalVolume: parseInt(row.total_volume) || 0,
      uniqueWallets: parseInt(row.unique_wallets) || 0,
      marketsWithBets: parseInt(row.markets_with_bets) || 0
    };
  },

  /**
   * Get leaderboard data
   */
  async getLeaderboard(limit = 10) {
    const result = await query(`
      SELECT 
        wallet,
        COUNT(*) as total_bets,
        COUNT(*) FILTER (WHERE status = 'won') as wins,
        COUNT(*) FILTER (WHERE status = 'lost') as losses,
        SUM(amount) as total_wagered,
        SUM(CASE WHEN status = 'won' THEN amount * 2 ELSE 0 END) as total_won
      FROM bets
      GROUP BY wallet
      ORDER BY total_won DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map(row => ({
      wallet: row.wallet,
      totalBets: parseInt(row.total_bets) || 0,
      wins: parseInt(row.wins) || 0,
      losses: parseInt(row.losses) || 0,
      totalWagered: parseInt(row.total_wagered) || 0,
      totalWon: parseInt(row.total_won) || 0,
      profit: (parseInt(row.total_won) || 0) - (parseInt(row.total_wagered) || 0)
    }));
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      id: row.id,
      marketId: row.market_id,
      wallet: row.wallet,
      outcome: row.outcome,
      amount: parseInt(row.amount) || 0,
      amountSOL: parseFloat(row.amount_sol) || null,
      amountUSDC: parseFloat(row.amount_usdc) || null,
      currency: row.currency,
      status: row.status,
      source: row.source,
      txSignature: row.tx_signature,
      betPda: row.bet_pda,
      onChain: row.on_chain,
      agentHandle: row.agent_handle,
      placedAt: row.placed_at?.toISOString(),
      x402Signature: row.x402_signature,
      paymentNetwork: row.payment_network
    };
  }
};

module.exports = Bet;
