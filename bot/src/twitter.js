/**
 * Twitter/X Service
 *
 * Handles all X API interactions:
 * - Reading mentions
 * - Posting tweets
 * - Replying to tweets
 * - Getting user info
 *
 * Supports two backends:
 * 1. twitter-api-v2 (default) - Direct API access with OAuth
 * 2. inference.sh CLI (optional) - Via `infsh` command for enhanced features
 */

const { TwitterApi } = require('twitter-api-v2');
const { execSync, exec } = require('child_process');

class TwitterService {
  constructor() {
    // Track tweets we've replied to in this session (prevents duplicates)
    this._repliedToTweets = new Set();
    
    // Initialize OAuth 1.0a client (user context - supports BOTH reads and writes)
    // Under X's new pay-per-use model, user context auth is the primary auth method
    // that's tied to billing. Bearer token (app-only) may not be authorized for all endpoints.
    if (process.env.TWITTER_API_KEY &&
        process.env.TWITTER_API_SECRET &&
        process.env.TWITTER_ACCESS_TOKEN &&
        process.env.TWITTER_ACCESS_SECRET) {

      this.oauthClient = new TwitterApi({
        appKey: process.env.TWITTER_API_KEY,
        appSecret: process.env.TWITTER_API_SECRET,
        accessToken: process.env.TWITTER_ACCESS_TOKEN,
        accessSecret: process.env.TWITTER_ACCESS_SECRET,
      });

      // Use OAuth 1.0a as primary for BOTH reads and writes
      this.readClient = this.oauthClient;
      this.writeClient = this.oauthClient;
      console.log('[Twitter] Using OAuth 1.0a (user context) for reads and writes');
    }

    // Fallback: Bearer token for read-only if OAuth 1.0a not available
    if (!this.readClient && process.env.TWITTER_BEARER_TOKEN) {
      this.readClient = new TwitterApi(process.env.TWITTER_BEARER_TOKEN);
      console.log('[Twitter] Using Bearer Token (app-only) for reads - some endpoints may be restricted');
    }

    // Track last seen mention for pagination
    this.lastMentionId = null;

    // Bot's own user ID (set on first getMentions call)
    this.botUserId = null;

    // Check if inference.sh CLI is available (alternative posting method)
    this.infshAvailable = this.checkInfshAvailable();
    if (this.infshAvailable) {
      console.log('[Twitter] inference.sh CLI available - enhanced features enabled');
    }

    // Use inference.sh as primary if configured
    this.useInfsh = process.env.USE_INFSH === 'true' && this.infshAvailable;
    if (this.useInfsh) {
      console.log('[Twitter] Using inference.sh CLI as primary posting method');
    }

    // Log auth status
    const authStatus = this.isConfigured();
    console.log(`[Twitter] Auth status - Read: ${authStatus.read}, Write: ${authStatus.write}, OAuth: ${!!this.oauthClient}, infsh: ${authStatus.infsh}`);
  }

  /**
   * Check if inference.sh CLI (infsh) is available
   */
  checkInfshAvailable() {
    try {
      execSync('which infsh', { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get bot's own user info
   */
  async getMe() {
    if (!this.readClient) {
      throw new Error('Twitter read client not configured');
    }

    try {
      const me = await this.readClient.v2.me();
      this.botUserId = me.data.id;
      console.log(`[Twitter] Authenticated as user ID: ${this.botUserId}`);
      return me.data;
    } catch (error) {
      console.error('[Twitter] Error in getMe():', error.message);
      if (error.code === 403) {
        console.error('[Twitter] 403 Forbidden on getMe() - check your OAuth credentials and X Developer Console settings');
      }
      throw error;
    }
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
        'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets',
        'expansions': 'author_id,referenced_tweets.id',
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
      if (error.code === 403 || error.message?.includes('403')) {
        console.error('[Twitter] 403 on mentions - this may indicate:');
        console.error('[Twitter]   1. OAuth credentials not properly configured in X Developer Console');
        console.error('[Twitter]   2. App permissions need to be updated (requires Read access)');
        console.error('[Twitter]   3. Callback URI mismatch in Developer Console settings');
        console.error('[Twitter]   4. Bearer token being used instead of OAuth user context');
        console.error(`[Twitter]   Current auth: ${this.oauthClient ? 'OAuth 1.0a' : 'Bearer Token only'}`);
      }
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
   * Uses inference.sh CLI if USE_INFSH=true, otherwise twitter-api-v2
   * Falls back to alternative method on failure
   */
  async tweet(text) {
    // Safety check: warn if tweet text contains dev/replit URLs
    if (text?.includes('replit.dev') || text?.includes('localhost')) {
      console.error(`[Twitter] WARNING: tweet() text contains dev URL! Preview: "${text?.slice(0, 150)}"`);
    }
    // If configured to use inference.sh as primary
    if (this.useInfsh) {
      const infshResult = await this.tweetViaInfsh(text);
      if (infshResult.success) {
        return infshResult;
      }
      // Fall back to twitter-api-v2 on failure
      console.log('[Twitter] infsh failed, falling back to twitter-api-v2');
    }

    if (!this.writeClient) {
      // Try inference.sh as fallback if available
      if (this.infshAvailable) {
        console.log('[Twitter] Write client not configured, trying inference.sh');
        return this.tweetViaInfsh(text);
      }
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
      
      // Try inference.sh as fallback on API error
      if (this.infshAvailable && !this.useInfsh) {
        console.log('[Twitter] API error, trying inference.sh fallback');
        return this.tweetViaInfsh(text);
      }
      
      return { success: false, error: error.message };
    }
  }

  /**
   * Reply to a tweet
   */
  async reply(tweetId, text) {
    // Safety check: warn if reply text contains dev/replit URLs
    if (text?.includes('replit.dev') || text?.includes('localhost')) {
      console.error(`[Twitter] WARNING: reply() text contains dev URL! Tweet ${tweetId}, preview: "${text?.slice(0, 150)}"`);
    }
    if (!this.writeClient) {
      console.log('[Twitter] Write client not configured, would reply to', tweetId, ':', text);
      return { success: false, reason: 'Write client not configured' };
    }

    // Prevent duplicate replies to the same tweet in this session
    if (this._repliedToTweets.has(tweetId)) {
      console.log(`[Twitter] Already replied to ${tweetId} in this session, skipping duplicate`);
      return { success: false, reason: 'Already replied to this tweet', duplicate: true };
    }

    try {
      // Truncate if too long
      const truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;

      const result = await this.writeClient.v2.reply(truncated, tweetId);
      console.log('[Twitter] Posted reply:', result.data.id);
      
      // Mark as replied to prevent duplicates
      this._repliedToTweets.add(tweetId);
      
      return { success: true, id: result.data.id };

    } catch (error) {
      console.error('[Twitter] Error posting reply:', error.message);
      
      // If Twitter says we already replied (duplicate), mark it and don't retry
      if (error.message.includes('duplicate') || error.code === 403) {
        this._repliedToTweets.add(tweetId);
      }
      
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
      write: !!this.writeClient,
      oauth: !!this.oauthClient,
      infsh: this.infshAvailable
    };
  }

  // ==========================================
  // INFERENCE.SH CLI METHODS
  // Alternative posting methods with enhanced features
  // ==========================================

  /**
   * Post a tweet using inference.sh CLI
   * Supports media attachments via media_url
   * @param {string} text Tweet text
   * @param {string} mediaUrl Optional media URL to attach
   * @returns {Object} Result with success status
   */
  async tweetViaInfsh(text, mediaUrl = null) {
    if (!this.infshAvailable) {
      console.log('[Twitter/infsh] CLI not available');
      return { success: false, reason: 'infsh CLI not available' };
    }

    try {
      const truncated = text.length > 280 ? text.slice(0, 277) + '...' : text;
      
      let input;
      let appId;

      if (mediaUrl) {
        // Use post-create for media tweets
        appId = 'x/post-create';
        input = JSON.stringify({ text: truncated, media_url: mediaUrl });
      } else {
        // Use post-tweet for text-only
        appId = 'x/post-tweet';
        input = JSON.stringify({ text: truncated });
      }

      const command = `infsh app run ${appId} --input '${input.replace(/'/g, "\\'")}'`;
      
      const result = execSync(command, { 
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      console.log('[Twitter/infsh] Posted tweet:', result.trim().slice(0, 100));
      
      // Parse result to extract tweet ID if available
      let tweetId = null;
      try {
        const parsed = JSON.parse(result);
        tweetId = parsed.id || parsed.tweet_id || parsed.data?.id;
      } catch {
        // Result might not be JSON
      }

      return { success: true, id: tweetId, via: 'infsh' };

    } catch (error) {
      console.error('[Twitter/infsh] Error posting tweet:', error.message);
      return { success: false, error: error.message, via: 'infsh' };
    }
  }

  /**
   * Post a tweet with media using inference.sh CLI
   * @param {string} text Tweet text
   * @param {string} mediaUrl URL of media to attach
   * @returns {Object} Result with success status
   */
  async tweetWithMedia(text, mediaUrl) {
    // Try inference.sh first if available (has native media support)
    if (this.infshAvailable) {
      return this.tweetViaInfsh(text, mediaUrl);
    }

    // Fallback: post text-only tweet
    console.log('[Twitter] Media posting requires inference.sh CLI, posting text only');
    return this.tweet(text);
  }

  /**
   * Like a tweet using inference.sh CLI
   * @param {string} tweetId Tweet ID to like
   * @returns {Object} Result with success status
   */
  async likeViaInfsh(tweetId) {
    if (!this.infshAvailable) {
      return { success: false, reason: 'infsh CLI not available' };
    }

    try {
      const input = JSON.stringify({ tweet_id: tweetId });
      const command = `infsh app run x/post-like --input '${input}'`;
      
      execSync(command, { encoding: 'utf8', timeout: 30000 });
      console.log('[Twitter/infsh] Liked tweet:', tweetId);
      
      return { success: true, tweetId, via: 'infsh' };

    } catch (error) {
      console.error('[Twitter/infsh] Error liking tweet:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retweet a post using inference.sh CLI
   * @param {string} tweetId Tweet ID to retweet
   * @returns {Object} Result with success status
   */
  async retweetViaInfsh(tweetId) {
    if (!this.infshAvailable) {
      return { success: false, reason: 'infsh CLI not available' };
    }

    try {
      const input = JSON.stringify({ tweet_id: tweetId });
      const command = `infsh app run x/post-retweet --input '${input}'`;
      
      execSync(command, { encoding: 'utf8', timeout: 30000 });
      console.log('[Twitter/infsh] Retweeted:', tweetId);
      
      return { success: true, tweetId, via: 'infsh' };

    } catch (error) {
      console.error('[Twitter/infsh] Error retweeting:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send a DM using inference.sh CLI
   * @param {string} recipientId User ID to send DM to
   * @param {string} text DM text
   * @returns {Object} Result with success status
   */
  async sendDMViaInfsh(recipientId, text) {
    if (!this.infshAvailable) {
      return { success: false, reason: 'infsh CLI not available' };
    }

    try {
      const input = JSON.stringify({ recipient_id: recipientId, text });
      const command = `infsh app run x/dm-send --input '${input.replace(/'/g, "\\'")}'`;
      
      execSync(command, { encoding: 'utf8', timeout: 30000 });
      console.log('[Twitter/infsh] Sent DM to:', recipientId);
      
      return { success: true, recipientId, via: 'infsh' };

    } catch (error) {
      console.error('[Twitter/infsh] Error sending DM:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Follow a user using inference.sh CLI
   * @param {string} username Username to follow (without @)
   * @returns {Object} Result with success status
   */
  async followViaInfsh(username) {
    if (!this.infshAvailable) {
      return { success: false, reason: 'infsh CLI not available' };
    }

    try {
      const input = JSON.stringify({ username: username.replace('@', '') });
      const command = `infsh app run x/user-follow --input '${input}'`;
      
      execSync(command, { encoding: 'utf8', timeout: 30000 });
      console.log('[Twitter/infsh] Followed:', username);
      
      return { success: true, username, via: 'infsh' };

    } catch (error) {
      console.error('[Twitter/infsh] Error following:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==========================================
  // FILTERED STREAM METHODS
  // Real-time mention detection via Twitter API v2
  // ==========================================

  /**
   * Start a filtered stream for real-time mention detection
   * @param {Function} onTweet - Callback for each incoming tweet
   * @param {string} botUsername - The bot's username (without @) for stream rules
   * @returns {Object} Stream object (or null if not supported)
   */
  async startFilteredStream(onTweet, botUsername = 'AgentBetsBot') {
    if (!this.readClient) {
      console.log('[Twitter/Stream] Read client not configured, cannot start stream');
      return null;
    }

    // Track reconnection state
    this.streamReconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.streamActive = false;

    try {
      // Set up stream rules - match mentions of our bot
      await this.setupStreamRules(botUsername);

      // Start the stream
      await this.connectStream(onTweet);

      return { active: true };
    } catch (error) {
      console.error('[Twitter/Stream] Failed to start filtered stream:', error.message);
      return null;
    }
  }

  /**
   * Set up filtered stream rules to match @AgentBetsBot mentions
   */
  async setupStreamRules(botUsername) {
    try {
      // Get existing rules
      const existingRules = await this.readClient.v2.streamRules();
      const currentRules = existingRules.data || [];

      console.log(`[Twitter/Stream] Current rules: ${currentRules.length}`);

      // Delete existing rules if any
      if (currentRules.length > 0) {
        const ruleIds = currentRules.map(r => r.id);
        await this.readClient.v2.updateStreamRules({
          delete: { ids: ruleIds }
        });
        console.log(`[Twitter/Stream] Deleted ${ruleIds.length} existing rules`);
      }

      // Add our rule - match mentions of the bot
      const addResult = await this.readClient.v2.updateStreamRules({
        add: [
          { value: `@${botUsername}`, tag: 'bot-mention' }
        ]
      });

      console.log(`[Twitter/Stream] Added stream rule: @${botUsername}`);

      if (addResult.errors && addResult.errors.length > 0) {
        console.error('[Twitter/Stream] Rule errors:', addResult.errors);
      }
    } catch (error) {
      console.error('[Twitter/Stream] Error setting up rules:', error.message);
      throw error;
    }
  }

  /**
   * Connect to the filtered stream with auto-reconnect
   */
  async connectStream(onTweet) {
    try {
      console.log('[Twitter/Stream] Connecting to filtered stream...');

      const stream = await this.readClient.v2.searchStream({
        'tweet.fields': 'created_at,author_id,conversation_id,in_reply_to_user_id',
        'expansions': 'author_id',
        autoConnect: true
      });

      this.stream = stream;
      this.streamActive = true;
      this.streamReconnectAttempts = 0;

      console.log('[Twitter/Stream] Connected! Listening for mentions in real-time...');

      // Handle incoming tweets
      stream.on('data', (event) => {
        const tweet = event.data;
        if (tweet) {
          console.log(`[Twitter/Stream] Real-time mention received: ${tweet.id}`);
          onTweet(tweet);
        }
      });

      // Handle stream errors
      stream.on('error', (error) => {
        console.error('[Twitter/Stream] Stream error:', error.message);
        this.streamActive = false;
        this.handleStreamReconnect(onTweet);
      });

      // Handle stream close/end
      stream.on('connection error', (error) => {
        console.error('[Twitter/Stream] Connection error:', error.message);
        this.streamActive = false;
        this.handleStreamReconnect(onTweet);
      });

      // Keepalive handling - Twitter sends empty lines as keepalives
      stream.on('data heartbeat', () => {
        // Reset reconnect counter on successful heartbeat
        this.streamReconnectAttempts = 0;
      });

    } catch (error) {
      console.error('[Twitter/Stream] Connection failed:', error.message);
      this.streamActive = false;
      this.handleStreamReconnect(onTweet);
    }
  }

  /**
   * Handle stream reconnection with exponential backoff
   */
  handleStreamReconnect(onTweet) {
    if (this.streamReconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[Twitter/Stream] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Stream disabled.`);
      console.log('[Twitter/Stream] Polling fallback will continue to check mentions.');
      return;
    }

    this.streamReconnectAttempts++;
    // Exponential backoff: 5s, 10s, 20s, 40s, 80s... capped at 5 minutes
    const delay = Math.min(5000 * Math.pow(2, this.streamReconnectAttempts - 1), 300000);

    console.log(`[Twitter/Stream] Reconnecting in ${delay / 1000}s (attempt ${this.streamReconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(async () => {
      try {
        await this.connectStream(onTweet);
      } catch (error) {
        console.error('[Twitter/Stream] Reconnection failed:', error.message);
        this.handleStreamReconnect(onTweet);
      }
    }, delay);
  }

  /**
   * Stop the filtered stream
   */
  stopStream() {
    if (this.stream) {
      try {
        this.stream.close();
        console.log('[Twitter/Stream] Stream closed');
      } catch (error) {
        console.log('[Twitter/Stream] Error closing stream:', error.message);
      }
      this.stream = null;
      this.streamActive = false;
    }
  }

  /**
   * Check if the stream is currently active
   */
  isStreamActive() {
    return this.streamActive === true;
  }

  /**
   * Get user profile using inference.sh CLI
   * @param {string} username Username to look up
   * @returns {Object} User data or error
   */
  async getUserViaInfsh(username) {
    if (!this.infshAvailable) {
      return { success: false, reason: 'infsh CLI not available' };
    }

    try {
      const input = JSON.stringify({ username: username.replace('@', '') });
      const command = `infsh app run x/user-get --input '${input}'`;
      
      const result = execSync(command, { encoding: 'utf8', timeout: 30000 });
      const userData = JSON.parse(result);
      
      return { success: true, data: userData, via: 'infsh' };

    } catch (error) {
      console.error('[Twitter/infsh] Error getting user:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = TwitterService;
