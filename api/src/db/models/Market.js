/**
 * Market Model
 * 
 * Database operations for prediction markets
 */

const { query, transaction } = require('../index');
const { v4: uuidv4 } = require('uuid');

const Market = {
  /**
   * Create a new market
   */
  async create(data) {
    const id = data.id || uuidv4();
    const result = await query(`
      INSERT INTO markets (
        id, question, description, category, status, resolution_source,
        end_date, creator_wallet, creator_agent, threshold, token_id,
        token_symbol, verification_url, verification_method, bet_pda,
        on_chain, tx_signature, currency, tags, proposer_wallet
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
      ) RETURNING *
    `, [
      id,
      data.question,
      data.description || null,
      data.category || 'general',
      data.status || 'active',
      data.resolutionSource || data.resolution_source || 'manual',
      data.endDate || data.end_date,
      data.creatorWallet || data.creator_wallet || null,
      data.creatorAgent || data.creator_agent || null,
      data.threshold || null,
      data.tokenId || data.token_id || null,
      data.tokenSymbol || data.token_symbol || null,
      data.verificationUrl || data.verification_url || null,
      data.verificationMethod || data.verification_method || null,
      data.betPda || data.bet_pda || null,
      data.onChain || data.on_chain || false,
      data.txSignature || data.tx_signature || null,
      data.currency || 'SOL',
      data.tags || [],
      data.proposerWallet || data.proposer_wallet || null
    ]);
    return this.toJS(result.rows[0]);
  },

  /**
   * Find market by ID
   */
  async findById(id) {
    const result = await query('SELECT * FROM markets WHERE id = $1', [id]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Find all markets with optional filters
   */
  async findAll(filters = {}) {
    let sql = 'SELECT * FROM markets WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (filters.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(filters.status);
    }

    if (filters.category) {
      sql += ` AND category = $${paramIndex++}`;
      params.push(filters.category);
    }

    if (filters.creatorAgent) {
      sql += ` AND creator_agent = $${paramIndex++}`;
      params.push(filters.creatorAgent);
    }

    if (filters.onChain !== undefined) {
      sql += ` AND on_chain = $${paramIndex++}`;
      params.push(filters.onChain);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(filters.limit);
    }

    if (filters.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(filters.offset);
    }

    const result = await query(sql, params);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Update a market
   */
  async update(id, data) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    // Map camelCase to snake_case
    const fieldMap = {
      question: 'question',
      description: 'description',
      category: 'category',
      status: 'status',
      resolution: 'resolution',
      resolutionSource: 'resolution_source',
      endDate: 'end_date',
      resolvedAt: 'resolved_at',
      creatorWallet: 'creator_wallet',
      creatorAgent: 'creator_agent',
      resolverWallet: 'resolver_wallet',
      adminNotes: 'admin_notes',
      confirmedBy: 'confirmed_by',
      yesPool: 'yes_pool',
      noPool: 'no_pool',
      totalVolume: 'total_volume',
      totalBets: 'total_bets',
      yesOdds: 'yes_odds',
      noOdds: 'no_odds',
      threshold: 'threshold',
      tokenId: 'token_id',
      tokenSymbol: 'token_symbol',
      verificationUrl: 'verification_url',
      verificationMethod: 'verification_method',
      betPda: 'bet_pda',
      onChain: 'on_chain',
      txSignature: 'tx_signature',
      currency: 'currency',
      onChainResolutionTx: 'on_chain_resolution_tx',
      settlementStatus: 'settlement_status',
      settledAt: 'settled_at',
      proposedResolution: 'proposed_resolution',
      resolutionEvidence: 'resolution_evidence',
      tags: 'tags'
    };

    for (const [camelKey, snakeKey] of Object.entries(fieldMap)) {
      if (data[camelKey] !== undefined) {
        fields.push(`${snakeKey} = $${paramIndex++}`);
        // Convert objects to JSON for JSONB fields
        const value = (snakeKey === 'proposed_resolution' || snakeKey === 'resolution_evidence')
          ? JSON.stringify(data[camelKey])
          : data[camelKey];
        values.push(value);
      }
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const sql = `UPDATE markets SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await query(sql, values);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Delete a market
   */
  async delete(id) {
    const result = await query('DELETE FROM markets WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  },

  /**
   * Get active markets ending soon
   */
  async getEndingSoon(hoursAhead = 24) {
    const result = await query(`
      SELECT * FROM markets 
      WHERE status = 'active' 
        AND end_date > NOW() 
        AND end_date < NOW() + INTERVAL '${hoursAhead} hours'
      ORDER BY end_date ASC
    `);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get markets pending resolution
   */
  async getPendingResolution() {
    const result = await query(`
      SELECT * FROM markets 
      WHERE status = 'pending_confirmation'
      ORDER BY end_date ASC
    `);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get market statistics
   */
  async getStats() {
    const result = await query(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        SUM(total_volume) as total_volume,
        SUM(total_bets) as total_bets
      FROM markets
    `);
    const row = result.rows[0];
    return {
      total: parseInt(row.total) || 0,
      active: parseInt(row.active) || 0,
      resolved: parseInt(row.resolved) || 0,
      totalVolume: parseInt(row.total_volume) || 0,
      totalBets: parseInt(row.total_bets) || 0
    };
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      id: row.id,
      question: row.question,
      description: row.description,
      category: row.category,
      status: row.status,
      resolution: row.resolution,
      resolutionSource: row.resolution_source,
      endDate: row.end_date?.toISOString(),
      resolvedAt: row.resolved_at?.toISOString(),
      createdAt: row.created_at?.toISOString(),
      creatorWallet: row.creator_wallet,
      creatorAgent: row.creator_agent,
      resolverWallet: row.resolver_wallet,
      adminNotes: row.admin_notes,
      confirmedBy: row.confirmed_by,
      yesPool: parseInt(row.yes_pool) || 0,
      noPool: parseInt(row.no_pool) || 0,
      totalVolume: parseInt(row.total_volume) || 0,
      totalBets: parseInt(row.total_bets) || 0,
      yesOdds: parseFloat(row.yes_odds) || 2.0,
      noOdds: parseFloat(row.no_odds) || 2.0,
      threshold: row.threshold,
      tokenId: row.token_id,
      tokenSymbol: row.token_symbol,
      verificationUrl: row.verification_url,
      verificationMethod: row.verification_method,
      betPda: row.bet_pda,
      onChain: row.on_chain,
      txSignature: row.tx_signature,
      currency: row.currency,
      onChainResolutionTx: row.on_chain_resolution_tx,
      settlementStatus: row.settlement_status,
      settledAt: row.settled_at?.toISOString(),
      proposedResolution: row.proposed_resolution,
      resolutionEvidence: row.resolution_evidence,
      tags: row.tags || [],
      proposerWallet: row.proposer_wallet,
      // Computed fields for compatibility
      outcomes: ['YES', 'NO']
    };
  }
};

module.exports = Market;
