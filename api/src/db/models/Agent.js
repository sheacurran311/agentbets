/**
 * Agent Model
 * 
 * Database operations for verified AI agents
 */

const { query, transaction } = require('../index');

const Agent = {
  /**
   * Create or update an agent (upsert)
   */
  async upsert(data) {
    const handle = data.handle.toLowerCase().replace('@', '');
    const result = await query(`
      INSERT INTO agents (
        handle, wallet, verification_method, is_verified, moltbook_data, bio
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (handle) DO UPDATE SET
        wallet = COALESCE(EXCLUDED.wallet, agents.wallet),
        verification_method = COALESCE(EXCLUDED.verification_method, agents.verification_method),
        is_verified = COALESCE(EXCLUDED.is_verified, agents.is_verified),
        moltbook_data = COALESCE(EXCLUDED.moltbook_data, agents.moltbook_data),
        bio = COALESCE(EXCLUDED.bio, agents.bio),
        last_verified = NOW()
      RETURNING *
    `, [
      handle,
      data.wallet || null,
      data.verificationMethod || data.verification_method || 'whitelisted',
      data.isVerified !== undefined ? data.isVerified : true,
      data.moltbookData ? JSON.stringify(data.moltbookData) : null,
      data.bio || null
    ]);
    return this.toJS(result.rows[0]);
  },

  /**
   * Find agent by handle
   */
  async findByHandle(handle) {
    const normalizedHandle = handle.toLowerCase().replace('@', '');
    const result = await query('SELECT * FROM agents WHERE handle = $1', [normalizedHandle]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Find agent by wallet
   */
  async findByWallet(wallet) {
    const result = await query('SELECT * FROM agents WHERE wallet = $1', [wallet]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Get all verified agents
   */
  async getVerified() {
    const result = await query(
      'SELECT * FROM agents WHERE is_verified = true ORDER BY created_at DESC'
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get all agents
   */
  async findAll() {
    const result = await query('SELECT * FROM agents ORDER BY created_at DESC');
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Check if handle is verified
   */
  async isVerified(handle) {
    const normalizedHandle = handle.toLowerCase().replace('@', '');
    const result = await query(
      'SELECT is_verified FROM agents WHERE handle = $1',
      [normalizedHandle]
    );
    return result.rows[0]?.is_verified || false;
  },

  /**
   * Update agent verification status
   */
  async updateVerification(handle, isVerified, method = null) {
    const normalizedHandle = handle.toLowerCase().replace('@', '');
    const result = await query(`
      UPDATE agents SET 
        is_verified = $2,
        verification_method = COALESCE($3, verification_method),
        last_verified = NOW()
      WHERE handle = $1
      RETURNING *
    `, [normalizedHandle, isVerified, method]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Register agent wallet
   */
  async registerWallet(handle, wallet) {
    const normalizedHandle = handle.toLowerCase().replace('@', '');
    const result = await query(`
      UPDATE agents SET wallet = $2 WHERE handle = $1 RETURNING *
    `, [normalizedHandle, wallet]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Get whitelist (verified agent handles)
   */
  async getWhitelist() {
    const result = await query(
      'SELECT handle FROM agents WHERE is_verified = true'
    );
    return result.rows.map(row => row.handle);
  },

  /**
   * Seed initial whitelist agents
   */
  async seedWhitelist(handles) {
    for (const handle of handles) {
      await this.upsert({
        handle,
        verificationMethod: 'whitelisted',
        isVerified: true
      });
    }
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      handle: row.handle,
      wallet: row.wallet,
      verificationMethod: row.verification_method,
      isVerified: row.is_verified,
      moltbookData: row.moltbook_data,
      bio: row.bio,
      verifiedAt: row.verified_at?.toISOString(),
      lastVerified: row.last_verified?.toISOString(),
      createdAt: row.created_at?.toISOString()
    };
  }
};

module.exports = Agent;
