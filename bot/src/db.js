/**
 * Standalone database module for the AgentBets Bot
 * Works on Railway without needing the shared monorepo database modules
 */

const { Pool } = require('pg');

let pool = null;

/**
 * Initialize database connection
 */
async function initDatabase() {
  // Prevent double initialization
  if (pool) {
    console.log('[DB] Already connected, reusing existing pool');
    return true;
  }
  
  if (!process.env.DATABASE_URL) {
    console.log('[DB] No DATABASE_URL set, skipping database initialization');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('neon.tech') || process.env.DATABASE_URL.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : false,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });

    // Test the connection
    const client = await pool.connect();
    console.log('[DB] PostgreSQL connected successfully');
    
    // Create processed_tweets table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS processed_tweets (
        tweet_id VARCHAR(64) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('[DB] processed_tweets table ready');
    
    // Create pending_resolutions table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS pending_resolutions (
        market_id VARCHAR(128) PRIMARY KEY,
        question TEXT,
        end_date TIMESTAMP,
        resolution_source VARCHAR(50),
        threshold VARCHAR(100),
        target_handle VARCHAR(100),
        target_token VARCHAR(100),
        resolution_timing VARCHAR(20) DEFAULT 'at_close',
        author_handle VARCHAR(100),
        verification_url TEXT,
        platform VARCHAR(50),
        proposal_status VARCHAR(20),
        proposed_at TIMESTAMP,
        proposed_resolution JSONB,
        data JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Ensure all required columns exist (table may have been created by an older migration)
    const columnsToAdd = [
      { name: 'verification_url', type: 'TEXT' },
      { name: 'platform', type: 'VARCHAR(50)' },
      { name: 'resolution_timing', type: "VARCHAR(20) DEFAULT 'at_close'" },
      { name: 'target_token', type: 'VARCHAR(100)' },
      { name: 'data', type: 'JSONB' },
      { name: 'updated_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' }
    ];
    for (const col of columnsToAdd) {
      await client.query(`ALTER TABLE pending_resolutions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`).catch(() => {});
    }
    console.log('[DB] pending_resolutions table ready');
    
    client.release();
    return true;
  } catch (error) {
    console.error('[DB] Failed to connect:', error.message);
    pool = null;
    return false;
  }
}

/**
 * ProcessedTweet model for tracking processed tweets in PostgreSQL
 */
const ProcessedTweet = {
  /**
   * Add a tweet ID to the processed list
   */
  async add(tweetId) {
    if (!pool) return false;
    try {
      await pool.query(
        'INSERT INTO processed_tweets (tweet_id) VALUES ($1) ON CONFLICT (tweet_id) DO NOTHING',
        [tweetId]
      );
      return true;
    } catch (error) {
      console.error('[DB] Error adding processed tweet:', error.message);
      return false;
    }
  },

  /**
   * Check if a tweet has been processed
   */
  async has(tweetId) {
    if (!pool) return false;
    try {
      const result = await pool.query(
        'SELECT 1 FROM processed_tweets WHERE tweet_id = $1',
        [tweetId]
      );
      return result.rows.length > 0;
    } catch (error) {
      console.error('[DB] Error checking processed tweet:', error.message);
      return false;
    }
  },

  /**
   * Get all processed tweet IDs (for loading into memory)
   */
  async getAll() {
    if (!pool) return [];
    try {
      const result = await pool.query('SELECT tweet_id FROM processed_tweets');
      return result.rows.map(row => row.tweet_id);
    } catch (error) {
      console.error('[DB] Error getting processed tweets:', error.message);
      return [];
    }
  },

  /**
   * Get all processed tweet IDs as a Set (compatible with shared db module)
   */
  async toSet() {
    const tweetIds = await this.getAll();
    return new Set(tweetIds);
  }
};

/**
 * Resolution model for tracking pending market resolutions in PostgreSQL
 */
const Resolution = {
  /**
   * Create or update a pending resolution
   * Compatible with monorepo Resolution.create(data) signature
   * data should include marketId (or market_id)
   */
  async create(data) {
    if (!pool) return null;
    const marketId = data.marketId || data.market_id;
    if (!marketId) {
      console.error('[DB] Resolution.create called without marketId');
      return null;
    }
    
    // Build insert dynamically to handle missing columns gracefully
    // Start with columns from the original migration 001 schema
    const columns = [
      'market_id', 'question', 'end_date', 'resolution_source', 'threshold',
      'target_handle', 'target_token', 'author_handle',
      'proposal_status', 'proposed_at', 'proposed_resolution', 'created_at'
    ];
    const values = [
      marketId,
      data.question || null,
      data.endDate || data.end_date || null,
      data.resolution || data.resolution_source || null,
      data.threshold || null,
      data.targetHandle || data.target_handle || null,
      data.targetToken || data.target_token || null,
      data.authorHandle || data.author_handle || null,
      data.proposalStatus || data.proposal_status || null,
      data.proposedAt || data.proposed_at || null,
      data.proposedResolution ? JSON.stringify(data.proposedResolution) : null,
      data.createdAt || data.created_at || new Date().toISOString()
    ];
    
    // Detect which optional columns exist and add them
    if (!this._checkedColumns) {
      try {
        const colResult = await pool.query(
          `SELECT column_name FROM information_schema.columns 
           WHERE table_name = 'pending_resolutions'`
        );
        this._availableColumns = new Set(colResult.rows.map(r => r.column_name));
        this._checkedColumns = true;
      } catch (e) {
        this._availableColumns = new Set();
        this._checkedColumns = true;
      }
    }
    
    if (this._availableColumns.has('resolution_timing')) {
      columns.push('resolution_timing');
      values.push(data.resolutionTiming || data.resolution_timing || 'at_close');
    }
    
    const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
    const updateCols = columns
      .filter(c => c !== 'market_id' && c !== 'created_at')
      .map(c => `${c} = EXCLUDED.${c}`)
      .join(', ');
    
    try {
      const result = await pool.query(
        `INSERT INTO pending_resolutions (${columns.join(', ')})
         VALUES (${placeholders})
         ON CONFLICT (market_id) DO UPDATE SET ${updateCols}
         RETURNING *`,
        values
      );
      return result.rows[0] || null;
    } catch (error) {
      console.error('[DB] Error saving resolution:', error.message);
      return null;
    }
  },

  /**
   * Get all pending resolutions
   */
  async getPending() {
    if (!pool) return [];
    try {
      const result = await pool.query(
        'SELECT * FROM pending_resolutions ORDER BY created_at ASC'
      );
      return result.rows.map(row => ({
        marketId: row.market_id,
        question: row.question,
        endDate: row.end_date,
        resolution: row.resolution_source,
        threshold: row.threshold,
        targetHandle: row.target_handle,
        targetToken: row.target_token,
        resolutionTiming: row.resolution_timing,
        authorHandle: row.author_handle,
        verificationUrl: row.verification_url,
        platform: row.platform,
        proposalStatus: row.proposal_status,
        proposedAt: row.proposed_at,
        proposedResolution: row.proposed_resolution,
        data: row.data,
        createdAt: row.created_at
      }));
    } catch (error) {
      console.error('[DB] Error getting pending resolutions:', error.message);
      return [];
    }
  },

  /**
   * Delete a pending resolution
   */
  async delete(marketId) {
    if (!pool) return false;
    try {
      await pool.query('DELETE FROM pending_resolutions WHERE market_id = $1', [marketId]);
      return true;
    } catch (error) {
      console.error('[DB] Error deleting resolution:', error.message);
      return false;
    }
  }
};

module.exports = {
  initDatabase,
  ProcessedTweet,
  Resolution,
  get pool() { return pool; }
};
