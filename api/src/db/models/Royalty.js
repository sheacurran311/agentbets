/**
 * Royalty Model
 * 
 * Database operations for agent royalties and points
 */

const { query, transaction } = require('../index');
const { v4: uuidv4 } = require('uuid');

const Royalty = {
  /**
   * Get or create royalty record for an agent
   */
  async getOrCreate(agentHandle) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    // First ensure agent exists
    await query(`
      INSERT INTO agents (handle, verification_method, is_verified)
      VALUES ($1, 'whitelisted', true)
      ON CONFLICT (handle) DO NOTHING
    `, [handle]);
    
    // Then get or create royalty record
    const result = await query(`
      INSERT INTO agent_royalties (agent_handle)
      VALUES ($1)
      ON CONFLICT (agent_handle) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [handle]);
    
    return this.toJS(result.rows[0]);
  },

  /**
   * Find royalty by agent handle
   */
  async findByHandle(handle) {
    const normalizedHandle = handle.toLowerCase().replace('@', '');
    const result = await query(
      'SELECT * FROM agent_royalties WHERE agent_handle = $1',
      [normalizedHandle]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Add earnings to an agent
   */
  async addEarnings(agentHandle, amount, marketId = null) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    return await transaction(async (client) => {
      // Update royalty balance
      await client.query(`
        UPDATE agent_royalties 
        SET earned = earned + $2, pending = pending + $2, updated_at = NOW()
        WHERE agent_handle = $1
      `, [handle, amount]);
      
      // Record transaction
      await client.query(`
        INSERT INTO royalty_transactions (agent_handle, type, amount, market_id)
        VALUES ($1, 'earning', $2, $3)
      `, [handle, amount, marketId]);
      
      // Return updated record
      const result = await client.query(
        'SELECT * FROM agent_royalties WHERE agent_handle = $1',
        [handle]
      );
      return this.toJS(result.rows[0]);
    });
  },

  /**
   * Process a withdrawal
   */
  async withdraw(agentHandle, amount, txSignature) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    return await transaction(async (client) => {
      // Check if enough pending balance
      const check = await client.query(
        'SELECT pending FROM agent_royalties WHERE agent_handle = $1',
        [handle]
      );
      
      if (!check.rows[0] || check.rows[0].pending < amount) {
        throw new Error('Insufficient pending balance');
      }
      
      // Update royalty balance
      await client.query(`
        UPDATE agent_royalties 
        SET pending = pending - $2, withdrawn = withdrawn + $2, updated_at = NOW()
        WHERE agent_handle = $1
      `, [handle, amount]);
      
      // Record transaction
      await client.query(`
        INSERT INTO royalty_transactions (agent_handle, type, amount, tx_signature)
        VALUES ($1, 'withdrawal', $2, $3)
      `, [handle, amount, txSignature]);
      
      // Return updated record
      const result = await client.query(
        'SELECT * FROM agent_royalties WHERE agent_handle = $1',
        [handle]
      );
      return this.toJS(result.rows[0]);
    });
  },

  /**
   * Get transaction history for an agent
   */
  async getTransactions(agentHandle, limit = 50) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    const result = await query(`
      SELECT * FROM royalty_transactions 
      WHERE agent_handle = $1 
      ORDER BY created_at DESC 
      LIMIT $2
    `, [handle, limit]);
    
    return result.rows.map(row => ({
      id: row.id,
      agentHandle: row.agent_handle,
      type: row.type,
      amount: parseInt(row.amount) || 0,
      txSignature: row.tx_signature,
      marketId: row.market_id,
      createdAt: row.created_at?.toISOString()
    }));
  },

  /**
   * Get leaderboard by earnings
   */
  async getLeaderboard(limit = 10) {
    const result = await query(`
      SELECT ar.*, a.wallet
      FROM agent_royalties ar
      JOIN agents a ON ar.agent_handle = a.handle
      ORDER BY ar.earned DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map(row => ({
      ...this.toJS(row),
      wallet: row.wallet
    }));
  },

  /**
   * Get platform treasury total
   */
  async getPlatformTreasury() {
    const result = await query(`
      SELECT SUM(amount) as total 
      FROM royalty_transactions 
      WHERE type = 'earning'
    `);
    // Platform gets 70% of fees (agents get 30%)
    const totalEarnings = parseInt(result.rows[0]?.total) || 0;
    return Math.floor(totalEarnings * 0.7 / 0.3); // Reverse the 30% to get platform's 70%
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      agentHandle: row.agent_handle,
      earned: parseInt(row.earned) || 0,
      withdrawn: parseInt(row.withdrawn) || 0,
      pending: parseInt(row.pending) || 0,
      createdAt: row.created_at?.toISOString(),
      updatedAt: row.updated_at?.toISOString(),
      // Computed fields for compatibility
      earnedSOL: (parseInt(row.earned) || 0) / 1e9,
      withdrawnSOL: (parseInt(row.withdrawn) || 0) / 1e9,
      pendingSOL: (parseInt(row.pending) || 0) / 1e9
    };
  }
};

/**
 * Agent Points Model
 */
const Points = {
  /**
   * Get or create points record for an agent
   */
  async getOrCreate(agentHandle) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    const result = await query(`
      INSERT INTO agent_points (agent_handle)
      VALUES ($1)
      ON CONFLICT (agent_handle) DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [handle]);
    
    return this.toJS(result.rows[0]);
  },

  /**
   * Find points by agent handle
   */
  async findByHandle(handle) {
    const normalizedHandle = handle.toLowerCase().replace('@', '');
    const result = await query(
      'SELECT * FROM agent_points WHERE agent_handle = $1',
      [normalizedHandle]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Add points to an agent
   */
  async addPoints(agentHandle, points, category = 'bonus') {
    const handle = agentHandle.toLowerCase().replace('@', '');
    const column = {
      'marketCreation': 'market_creation_points',
      'marketVolume': 'market_volume_points',
      'predictions': 'prediction_points',
      'bonus': 'bonus_points'
    }[category] || 'bonus_points';
    
    const result = await query(`
      UPDATE agent_points 
      SET 
        total_points = total_points + $2,
        ${column} = ${column} + $2,
        updated_at = NOW()
      WHERE agent_handle = $1
      RETURNING *
    `, [handle, points]);
    
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Get leaderboard by points
   */
  async getLeaderboard(limit = 10) {
    const result = await query(`
      SELECT * FROM agent_points
      ORDER BY total_points DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      agentHandle: row.agent_handle,
      totalPoints: parseInt(row.total_points) || 0,
      breakdown: {
        marketCreation: parseInt(row.market_creation_points) || 0,
        marketVolume: parseInt(row.market_volume_points) || 0,
        predictions: parseInt(row.prediction_points) || 0,
        bonuses: parseInt(row.bonus_points) || 0
      },
      updatedAt: row.updated_at?.toISOString()
    };
  }
};

module.exports = { Royalty, Points };
