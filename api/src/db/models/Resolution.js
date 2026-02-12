/**
 * Resolution Model
 * 
 * Database operations for pending resolutions (bot tracking)
 */

const { query } = require('../index');

const Resolution = {
  /**
   * Create a pending resolution
   */
  async create(data) {
    const result = await query(`
      INSERT INTO pending_resolutions (
        market_id, tweet_id, author_handle, question, end_date,
        resolution_source, threshold, target_handle, target_token, resolution_timing
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (market_id) DO UPDATE SET
        tweet_id = EXCLUDED.tweet_id,
        author_handle = EXCLUDED.author_handle,
        question = EXCLUDED.question,
        end_date = EXCLUDED.end_date,
        resolution_source = EXCLUDED.resolution_source,
        threshold = EXCLUDED.threshold,
        target_handle = EXCLUDED.target_handle,
        target_token = EXCLUDED.target_token,
        resolution_timing = EXCLUDED.resolution_timing
      RETURNING *
    `, [
      data.marketId || data.market_id,
      data.tweetId || data.tweet_id || null,
      data.authorHandle || data.author_handle || null,
      data.question,
      data.endDate || data.end_date,
      data.resolution || data.resolution_source || 'manual',
      data.threshold || null,
      data.targetHandle || data.target_handle || null,
      data.targetToken || data.target_token || null,
      data.resolutionTiming || data.resolution_timing || 'at_close'
    ]);
    return this.toJS(result.rows[0]);
  },

  /**
   * Find pending resolution by market ID
   */
  async findByMarketId(marketId) {
    const result = await query(
      'SELECT * FROM pending_resolutions WHERE market_id = $1',
      [marketId]
    );
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Get all pending resolutions (not yet proposed)
   */
  async getPending() {
    const result = await query(`
      SELECT * FROM pending_resolutions 
      WHERE proposal_status IS NULL OR proposal_status != 'proposed'
      ORDER BY end_date ASC
    `);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get resolutions that have ended but not proposed
   */
  async getEndedNotProposed() {
    const result = await query(`
      SELECT * FROM pending_resolutions 
      WHERE end_date <= NOW() 
        AND (proposal_status IS NULL OR proposal_status != 'proposed')
      ORDER BY end_date ASC
    `);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get resolutions ending within a time window
   */
  async getEndingSoon(hoursAhead = 24) {
    const result = await query(`
      SELECT * FROM pending_resolutions 
      WHERE end_date > NOW() 
        AND end_date < NOW() + INTERVAL '${hoursAhead} hours'
        AND (proposal_status IS NULL OR proposal_status != 'proposed')
      ORDER BY end_date ASC
    `);
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Update proposal status
   */
  async setProposed(marketId, resolution) {
    const result = await query(`
      UPDATE pending_resolutions 
      SET 
        proposal_status = 'proposed',
        proposed_at = NOW(),
        proposed_resolution = $2
      WHERE market_id = $1
      RETURNING *
    `, [marketId, JSON.stringify(resolution)]);
    return result.rows[0] ? this.toJS(result.rows[0]) : null;
  },

  /**
   * Delete a pending resolution
   */
  async delete(marketId) {
    const result = await query(
      'DELETE FROM pending_resolutions WHERE market_id = $1 RETURNING market_id',
      [marketId]
    );
    return result.rowCount > 0;
  },

  /**
   * Convert to Map format (for backward compatibility with bot)
   */
  async toMap() {
    const all = await this.getPending();
    const map = new Map();
    for (const item of all) {
      map.set(item.marketId, item);
    }
    return map;
  },

  /**
   * Convert database row to JavaScript object (camelCase)
   */
  toJS(row) {
    if (!row) return null;
    return {
      marketId: row.market_id,
      tweetId: row.tweet_id,
      authorHandle: row.author_handle,
      question: row.question,
      endDate: row.end_date?.toISOString(),
      resolution: row.resolution_source,
      threshold: row.threshold,
      targetHandle: row.target_handle,
      targetToken: row.target_token,
      proposalStatus: row.proposal_status,
      proposedAt: row.proposed_at?.toISOString(),
      proposedResolution: row.proposed_resolution,
      createdAt: row.created_at?.toISOString(),
      resolutionTiming: row.resolution_timing || 'at_close'
    };
  }
};

/**
 * Processed Tweets Model
 */
const ProcessedTweet = {
  /**
   * Mark a tweet as processed
   */
  async add(tweetId) {
    await query(`
      INSERT INTO processed_tweets (tweet_id) VALUES ($1)
      ON CONFLICT (tweet_id) DO NOTHING
    `, [tweetId]);
  },

  /**
   * Check if a tweet has been processed
   */
  async has(tweetId) {
    const result = await query(
      'SELECT 1 FROM processed_tweets WHERE tweet_id = $1',
      [tweetId]
    );
    return result.rowCount > 0;
  },

  /**
   * Get all processed tweet IDs (for backward compatibility)
   */
  async toSet() {
    const result = await query('SELECT tweet_id FROM processed_tweets');
    return new Set(result.rows.map(r => r.tweet_id));
  },

  /**
   * Clean up old tweets (older than 7 days)
   */
  async cleanup(daysOld = 7) {
    const result = await query(`
      DELETE FROM processed_tweets 
      WHERE processed_at < NOW() - INTERVAL '${daysOld} days'
    `);
    return result.rowCount;
  }
};

/**
 * Odds History Model
 */
const OddsHistory = {
  /**
   * Record odds snapshot
   */
  async record(marketId, data) {
    await query(`
      INSERT INTO odds_history (
        market_id, yes_odds, no_odds, yes_pool, no_pool, total_volume
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      marketId,
      data.yesOdds || data.yes_odds,
      data.noOdds || data.no_odds,
      data.yesPool || data.yes_pool,
      data.noPool || data.no_pool,
      data.totalVolume || data.total_volume || 0
    ]);
  },

  /**
   * Get odds history for a market
   */
  async getByMarketId(marketId, limit = 100) {
    const result = await query(`
      SELECT * FROM odds_history 
      WHERE market_id = $1 
      ORDER BY recorded_at DESC 
      LIMIT $2
    `, [marketId, limit]);
    
    return result.rows.map(row => ({
      timestamp: row.recorded_at?.toISOString(),
      yesOdds: parseFloat(row.yes_odds) || 0,
      noOdds: parseFloat(row.no_odds) || 0,
      yesPool: parseInt(row.yes_pool) || 0,
      noPool: parseInt(row.no_pool) || 0,
      totalVolume: parseInt(row.total_volume) || 0
    }));
  }
};

/**
 * Positions Model
 */
const Position = {
  /**
   * Update or create a position
   */
  async upsert(wallet, marketId, outcome, amount) {
    const result = await query(`
      INSERT INTO positions (wallet, market_id, outcome, total_amount, bet_count)
      VALUES ($1, $2, $3, $4, 1)
      ON CONFLICT (wallet, market_id, outcome) DO UPDATE SET
        total_amount = positions.total_amount + EXCLUDED.total_amount,
        bet_count = positions.bet_count + 1,
        updated_at = NOW()
      RETURNING *
    `, [wallet, marketId, outcome, amount]);
    
    return this.toJS(result.rows[0]);
  },

  /**
   * Get positions by wallet
   */
  async findByWallet(wallet) {
    const result = await query(
      'SELECT * FROM positions WHERE wallet = $1',
      [wallet]
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Get positions by market
   */
  async findByMarketId(marketId) {
    const result = await query(
      'SELECT * FROM positions WHERE market_id = $1',
      [marketId]
    );
    return result.rows.map(row => this.toJS(row));
  },

  /**
   * Convert database row to JavaScript object
   */
  toJS(row) {
    if (!row) return null;
    return {
      id: row.id,
      wallet: row.wallet,
      marketId: row.market_id,
      outcome: row.outcome,
      totalAmount: parseInt(row.total_amount) || 0,
      betCount: parseInt(row.bet_count) || 0,
      createdAt: row.created_at?.toISOString(),
      updatedAt: row.updated_at?.toISOString()
    };
  }
};

module.exports = { Resolution, ProcessedTweet, OddsHistory, Position };
