/**
 * PlatformKey Model
 * 
 * Database operations for platform API keys
 * Enables partner platforms to access filtered market feeds and place bets
 * Platform keys are scoped (read/bet only) - market creation/resolution stays admin-only
 */

const { query } = require('../index');
const crypto = require('crypto');

const PlatformKey = {
  /**
   * Create a new platform API key
   * For admin-created keys: is_active=true, status='active'
   * For partner applications: is_active=false, status='pending'
   */
  async create(data) {
    const apiKey = crypto.randomBytes(32).toString('hex'); // 64-char key
    const result = await query(`
      INSERT INTO platform_keys (
        platform_name, api_key, contact_email, permissions,
        rate_limit_per_minute, tags_filter, categories_filter,
        wallet_address, status, platform_description, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [
      data.platformName || data.platform_name,
      apiKey,
      data.contactEmail || data.contact_email || null,
      data.permissions || ['read', 'bet'],
      data.rateLimitPerMinute || data.rate_limit_per_minute || 60,
      data.tagsFilter || data.tags_filter || null,
      data.categoriesFilter || data.categories_filter || null,
      data.walletAddress || data.wallet_address || null,
      data.status || 'active',
      data.platformDescription || data.platform_description || null,
      data.isActive !== undefined ? data.isActive : true
    ]);
    return this.toJS(result.rows[0]);
  },

  /**
   * Find platform key by API key value (used for authentication)
   */
  async findByKey(apiKey) {
    const result = await query(
      'SELECT * FROM platform_keys WHERE api_key = $1',
      [apiKey]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Find platform key by ID
   */
  async findById(id) {
    const result = await query(
      'SELECT * FROM platform_keys WHERE id = $1',
      [id]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * List all platform keys (for admin management)
   * @param {object} filters - { activeOnly, status }
   */
  async listAll(filters = {}) {
    let sql = 'SELECT * FROM platform_keys WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    // Legacy boolean filter
    if (filters === true || filters.activeOnly) {
      sql += ` AND is_active = true`;
    }

    // Status filter (pending, approved, rejected, active)
    if (filters.status) {
      sql += ` AND status = $${paramIndex++}`;
      params.push(filters.status);
    }

    sql += ' ORDER BY created_at DESC';
    const result = await query(sql, params);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Update a platform key's settings
   */
  async update(id, data) {
    const fields = [];
    const values = [];
    let paramIndex = 1;

    const fieldMap = {
      platformName: 'platform_name',
      contactEmail: 'contact_email',
      permissions: 'permissions',
      rateLimitPerMinute: 'rate_limit_per_minute',
      tagsFilter: 'tags_filter',
      categoriesFilter: 'categories_filter',
      isActive: 'is_active',
      walletAddress: 'wallet_address',
      status: 'status',
      platformDescription: 'platform_description',
      rejectionReason: 'rejection_reason'
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
    const sql = `UPDATE platform_keys SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
    const result = await query(sql, values);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Deactivate a platform key (soft delete)
   */
  async deactivate(id) {
    const result = await query(
      'UPDATE platform_keys SET is_active = false WHERE id = $1 RETURNING *',
      [id]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Find platform key by wallet address (for 1-key-per-wallet enforcement)
   */
  async findByWallet(walletAddress) {
    const result = await query(
      'SELECT * FROM platform_keys WHERE wallet_address = $1 ORDER BY created_at DESC LIMIT 1',
      [walletAddress]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * List pending partner applications
   */
  async listPending() {
    const result = await query(
      "SELECT * FROM platform_keys WHERE status = 'pending' ORDER BY created_at ASC"
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Approve a partner application
   * Activates the key and sets status to approved
   */
  async approve(id) {
    const result = await query(
      `UPDATE platform_keys 
       SET status = 'approved', is_active = true, reviewed_at = NOW() 
       WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Reject a partner application
   */
  async reject(id, reason) {
    const result = await query(
      `UPDATE platform_keys 
       SET status = 'rejected', is_active = false, reviewed_at = NOW(), rejection_reason = $2 
       WHERE id = $1 RETURNING *`,
      [id, reason || null]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Update usage stats (called on each authenticated request)
   */
  async updateUsage(id) {
    await query(
      'UPDATE platform_keys SET last_used_at = NOW(), request_count = request_count + 1 WHERE id = $1',
      [id]
    );
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      id: row.id,
      platformName: row.platform_name,
      apiKey: row.api_key,
      contactEmail: row.contact_email,
      permissions: row.permissions || ['read', 'bet'],
      rateLimitPerMinute: row.rate_limit_per_minute || 60,
      tagsFilter: row.tags_filter,
      categoriesFilter: row.categories_filter,
      isActive: row.is_active,
      createdAt: row.created_at?.toISOString(),
      lastUsedAt: row.last_used_at?.toISOString(),
      requestCount: parseInt(row.request_count) || 0,
      walletAddress: row.wallet_address,
      status: row.status || 'active',
      platformDescription: row.platform_description,
      reviewedAt: row.reviewed_at?.toISOString(),
      rejectionReason: row.rejection_reason
    };
  }
};

module.exports = PlatformKey;
