/**
 * Twitter/X Service
 *
 * Handles all X API interactions:
 * - Reading mentions
 * - Posting tweets
 * - Replying to tweets
 * - Getting user info
 */

const { TwitterApi } = require('twitter-api-v2');

class TwitterService {
  constructor() {
    // Initialize client with credentials
    if (process.env.TWITTER_BEARER_TOKEN) {
      this.readClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
    }

    // For posting, we need OAuth 1.0a credentials
    if (process.env.TWITTER_API_KEY &&
        process.env.TWITTER_API_SECRET &&
        process.env.TWITTER_ACCESS_TOKEN &&
        process.env.TWITTER_ACCESS_SECRET) {

      this.writeClient = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
      });
    }

    // Track last seen mention for pagination
    this.lastMentionId = null;

    // Bot's own user ID (set on first getMentions call)
    this.botUserId = null;
  }

  /**
   * Get bot's own user info
   */
  async getMe() {
    if (!this.readClient) {
      throw new Error('Twitter read client not configured');
    }

    const me = await this.readClient.v2.me();
    this.botUserId = me.data.id;
    return me.data;
  }

  /**
   * Get recent mentions of the bot
   */
  async getMentions(sinceId = null) {
    if (!this.readClient) {
      console.log('[Twitter] Read client not configured');
      return [];
    }

    try {
      // Get bot's user ID if not set
      if (!this.botUserId) {
        await this.getMe();
      }

      const params = {
        'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id',
        'expansions': 'author_id',
        'max_results': 20
      };

      // Use sinceId to get only new mentions
      if (sinceId || this.lastMentionId) {
        params.since_id = sinceId || this.lastMentionId;
      }

      const mentions = await this.readClient.v2.userMentionTimeline(
        this.botUserId,
        params
      );

      const tweets = mentions.data?.data || [];

      // Update last seen ID
      if (tweets.length > 0) {
        this.lastMentionId = tweets[0].id;
      }

      return tweets;

    } catch (error) {
      console.error('[Twitter] Error getting mentions:', error.message);
      return [];
    }
  }

  /**
   * Get user info by ID
   */
  async getUser(userId) {
    if (!this.readClient) {
      throw new Error('Twitter read client not configured');
    }

    try {
      const user = await this.readClient.v2.user(userId, {
        'user.fields': 'description,public_metrics,verified_type'
      });
      return user.data;
    } catch (error) {
      console.error('[Twitter] Error getting user:', error.message);
      throw error;
    }
  }

  /**
   * Get user info by username
   */
  async getUserByUsername(username) {
    if (!this.readClient) {
      throw new Error('Twitter read client not configured');
    }

    try {
      const user = await this.readClient.v2.userByUsername(username, {
        'user.fields': 'description,public_metrics,verified_type'
      });
      return user.data;
    } catch (error) {
      console.error('[Twitter] Error getting user by username:', error.message);
      throw error;
    }
  }

  /**
   * Post a new tweet
   */
  async tweet(text) {
    if (!this.writeClient) {
      console.log('[Twitter] Write client not configured, would tweet:', text);
      return { success: false, reason: 'Write client not configured' };
    }

    try {
      // Truncate if too long (280 chars max)
      const truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;

      const result = await this.writeClient.v2.tweet(truncated);
      console.log('[Twitter] Posted tweet:', result.data.id);
      return { success: true, id: result.data.id };

    } catch (error) {
      console.error('[Twitter] Error posting tweet:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Reply to a tweet
   */
  async reply(tweetId, text) {
    if (!this.writeClient) {
      console.log('[Twitter] Write client not configured, would reply to', tweetId, ':', text);
      return { success: false, reason: 'Write client not configured' };
    }

    try {
      // Truncate if too long
      const truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;

      const result = await this.writeClient.v2.reply(truncated, tweetId);
      console.log('[Twitter] Posted reply:', result.data.id);
      return { success: true, id: result.data.id };

    } catch (error) {
      console.error('[Twitter] Error posting reply:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Quote tweet
   */
  async quote(tweetId, text) {
    if (!this.writeClient) {
      console.log('[Twitter] Write client not configured');
      return { success: false, reason: 'Write client not configured' };
    }

    try {
      const truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;

      const result = await this.writeClient.v2.tweet(truncated, {
        quote_tweet_id: tweetId
      });
      console.log('[Twitter] Posted quote tweet:', result.data.id);
      return { success: true, id: result.data.id };

    } catch (error) {
      console.error('[Twitter] Error posting quote:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get a single tweet by ID
   */
  async getTweet(tweetId) {
    if (!this.readClient) {
      throw new Error('Twitter read client not configured');
    }

    try {
      const tweet = await this.readClient.v2.singleTweet(tweetId, {
        'tweet.fields': 'created_at,author_id,text,conversation_id',
        'expansions': 'author_id'
      });
      return tweet.data;
    } catch (error) {
      console.error('[Twitter] Error getting tweet:', error.message);
      throw error;
    }
  }

  /**
   * Search recent tweets
   */
  async search(query, maxResults = 10) {
    if (!this.readClient) {
      throw new Error('Twitter read client not configured');
    }

    try {
      const results = await this.readClient.v2.search(query, {
        'tweet.fields': 'created_at,author_id,public_metrics',
        'max_results': maxResults
      });
      return results.data?.data || [];
    } catch (error) {
      console.error('[Twitter] Error searching:', error.message);
      throw error;
    }
  }

  /**
   * Check if Twitter is configured
   */
  isConfigured() {
    return {
      read: !!this.readClient,
      write: !!this.writeClient
    };
  }
}

module.exports = TwitterService;
