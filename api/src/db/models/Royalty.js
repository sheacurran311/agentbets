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
      'bonus': 'bonus_points',
      'wager': 'wager_points',
      'referral': 'referral_points'
    }[category] || 'bonus_points';
    
    const result = await query(`
      UPDATE agent_points 
      SET 
        total_points = total_points + $2,
        ${column} = COALESCE(${column}, 0) + $2,
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
   * Add wager points to an agent (1 point per $1 wagered)
   */
  async addWagerPoints(agentHandle, points) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    // Ensure record exists
    await this.getOrCreate(handle);
    
    const result = await query(`
      UPDATE agent_points 
      SET 
        total_points = total_points + $2,
        wager_points = COALESCE(wager_points, 0) + $2,
        updated_at = NOW()
      WHERE agent_handle = $1
      RETURNING *
    `, [handle, points]);
    
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Add referral points to an agent (earned from referred agents' wagers)
   */
  async addReferralPoints(agentHandle, points) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    // Ensure record exists
    await this.getOrCreate(handle);
    
    const result = await query(`
      UPDATE agent_points 
      SET 
        total_points = total_points + $2,
        referral_points = COALESCE(referral_points, 0) + $2,
        updated_at = NOW()
      WHERE agent_handle = $1
      RETURNING *
    `, [handle, points]);
    
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
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
        bonuses: parseInt(row.bonus_points) || 0,
        wager: parseInt(row.wager_points) || 0,
        referral: parseInt(row.referral_points) || 0
      },
      updatedAt: row.updated_at?.toISOString()
    };
  }
};

/**
 * Agent Referral Model
 */
const Referral = {
  /**
   * Generate a unique referral code for an agent
   */
  async generateCode(agentHandle) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    // Check if agent already has a code
    const existing = await query(
      'SELECT referral_code FROM agents WHERE handle = $1',
      [handle]
    );
    
    if (existing.rows[0]?.referral_code) {
      return existing.rows[0].referral_code;
    }
    
    // Generate 8-char alphanumeric code
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
    let code;
    let attempts = 0;
    
    while (attempts < 10) {
      code = '';
      for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      
      // Check uniqueness
      const check = await query(
        'SELECT 1 FROM agents WHERE referral_code = $1',
        [code]
      );
      
      if (check.rows.length === 0) break;
      attempts++;
    }
    
    // Ensure agent exists, then set code
    await query(`
      INSERT INTO agents (handle, verification_method, is_verified)
      VALUES ($1, 'whitelisted', true)
      ON CONFLICT (handle) DO NOTHING
    `, [handle]);
    
    await query(
      'UPDATE agents SET referral_code = $1 WHERE handle = $2',
      [code, handle]
    );
    
    return code;
  },

  /**
   * Get an agent's referral code (without generating one)
   */
  async getCode(agentHandle) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    const result = await query(
      'SELECT referral_code FROM agents WHERE handle = $1',
      [handle]
    );
    return result.rows[0]?.referral_code || null;
  },

  /**
   * Register a referral relationship
   * @param {string} referralCode - The referrer's code
   * @param {string} referredHandle - The agent being referred
   */
  async registerReferral(referralCode, referredHandle) {
    const referred = referredHandle.toLowerCase().replace('@', '');
    
    // Look up referrer by code
    const referrerResult = await query(
      'SELECT handle FROM agents WHERE referral_code = $1',
      [referralCode.toUpperCase()]
    );
    
    if (!referrerResult.rows[0]) {
      throw new Error('Invalid referral code');
    }
    
    const referrer = referrerResult.rows[0].handle;
    
    // Can't refer yourself
    if (referrer === referred) {
      throw new Error('Cannot refer yourself');
    }
    
    // Check if already referred
    const existingCheck = await query(
      'SELECT 1 FROM agent_referrals WHERE referred_handle = $1',
      [referred]
    );
    
    if (existingCheck.rows.length > 0) {
      throw new Error('Agent already has a referrer');
    }
    
    // Ensure referred agent exists
    await query(`
      INSERT INTO agents (handle, verification_method, is_verified)
      VALUES ($1, 'whitelisted', true)
      ON CONFLICT (handle) DO NOTHING
    `, [referred]);
    
    // Create referral record
    const result = await query(`
      INSERT INTO agent_referrals (referrer_handle, referred_handle, referral_code)
      VALUES ($1, $2, $3)
      RETURNING *
    `, [referrer, referred, referralCode.toUpperCase()]);
    
    return {
      id: result.rows[0].id,
      referrerHandle: result.rows[0].referrer_handle,
      referredHandle: result.rows[0].referred_handle,
      referralCode: result.rows[0].referral_code,
      bonusPct: parseFloat(result.rows[0].referral_bonus_pct),
      createdAt: result.rows[0].created_at?.toISOString()
    };
  },

  /**
   * Get who referred this agent (if anyone)
   */
  async getReferrer(agentHandle) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    const result = await query(
      'SELECT referrer_handle, referral_bonus_pct FROM agent_referrals WHERE referred_handle = $1',
      [handle]
    );
    
    if (!result.rows[0]) return null;
    
    return {
      referrerHandle: result.rows[0].referrer_handle,
      bonusPct: parseFloat(result.rows[0].referral_bonus_pct)
    };
  },

  /**
   * Get referral stats for an agent (as a referrer)
   */
  async getReferralStats(agentHandle) {
    const handle = agentHandle.toLowerCase().replace('@', '');
    
    // Count referrals
    const countResult = await query(
      'SELECT COUNT(*) as count FROM agent_referrals WHERE referrer_handle = $1',
      [handle]
    );
    
    // Get referred agents list
    const referredResult = await query(`
      SELECT ar.referred_handle, ar.created_at, COALESCE(ap.total_points, 0) as referred_points
      FROM agent_referrals ar
      LEFT JOIN agent_points ap ON ar.referred_handle = ap.agent_handle
      WHERE ar.referrer_handle = $1
      ORDER BY ar.created_at DESC
    `, [handle]);
    
    // Get referral points earned
    const pointsResult = await query(
      'SELECT COALESCE(referral_points, 0) as referral_points FROM agent_points WHERE agent_handle = $1',
      [handle]
    );
    
    return {
      referralCount: parseInt(countResult.rows[0]?.count) || 0,
      referralPointsEarned: parseInt(pointsResult.rows[0]?.referral_points) || 0,
      referredAgents: referredResult.rows.map(r => ({
        handle: r.referred_handle,
        totalPoints: parseInt(r.referred_points) || 0,
        referredAt: r.created_at?.toISOString()
      }))
    };
  },

  /**
   * Get top referrers leaderboard
   */
  async getLeaderboard(limit = 20) {
    const result = await query(`
      SELECT 
        ar.referrer_handle,
        COUNT(ar.referred_handle) as referral_count,
        COALESCE(ap.referral_points, 0) as referral_points,
        COALESCE(ap.total_points, 0) as total_points
      FROM agent_referrals ar
      LEFT JOIN agent_points ap ON ar.referrer_handle = ap.agent_handle
      GROUP BY ar.referrer_handle, ap.referral_points, ap.total_points
      ORDER BY COALESCE(ap.referral_points, 0) DESC
      LIMIT $1
    `, [limit]);
    
    return result.rows.map((row, i) => ({
      rank: i + 1,
      handle: row.referrer_handle,
      referralCount: parseInt(row.referral_count) || 0,
      referralPoints: parseInt(row.referral_points) || 0,
      totalPoints: parseInt(row.total_points) || 0
    }));
  }
};

module.exports = { Royalty, Points, Referral };
