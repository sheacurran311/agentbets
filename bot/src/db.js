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

module.exports = {
  initDatabase,
  ProcessedTweet,
  get pool() { return pool; }
};
