/**
 * Moltbook Service
 *
 * Handles all Moltbook API interactions for the AgentBets bot:
 * - Reading posts/comments in the m/agentbets submolt
 * - Posting market announcements
 * - Replying to comments (bet creation, commands)
 * - Searching for mentions of AgentBets
 *
 * Mirrors the TwitterService pattern for consistency.
 * Requires MOLTBOOK_BOT_API_KEY environment variable.
 *
 * API Docs: https://www.moltbook.com/skill.md
 * IMPORTANT: Always use https://www.moltbook.com (with www)
 */

class MoltbookService {
  constructor() {
    this.baseUrl = process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1';
    this.apiKey = process.env.MOLTBOOK_BOT_API_KEY || null;
    this.submolt = 'agentbets'; // Our submolt for market announcements
    this.botName = 'AgentBB'; // Moltbook agent name (updated on getMe() call)
    this.lastCheckedPostId = null;
    this.lastCheckedCommentTime = null;
    this.enabled = false;

    if (this.apiKey) {
      this.enabled = true;
      console.log('[Moltbook] API key configured, service enabled');
    } else {
      console.log('[Moltbook] No MOLTBOOK_BOT_API_KEY set - Moltbook integration disabled');
      console.log('[Moltbook] Set MOLTBOOK_BOT_API_KEY to enable Moltbook market announcements');
    }
  }

  /**
   * Get request headers with auth
   */
  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  /**
   * Make an API request with timeout and error handling
   */
  async request(method, path, body = null) {
    if (!this.enabled) {
      return { success: false, error: 'Moltbook service not configured' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const options = {
        method,
        headers: this.getHeaders(),
        signal: controller.signal
      };

      if (body && (method === 'POST' || method === 'PATCH')) {
        options.body = JSON.stringify(body);
      }

      const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
      const response = await fetch(url, options);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          status: response.status,
          error: errorData.error || errorData.message || `HTTP ${response.status}`,
          hint: errorData.hint || null
        };
      }

      const data = await response.json();
      return { success: true, ...data };
    } catch (err) {
      clearTimeout(timeoutId);
      const error = err.name === 'AbortError' ? 'Request timed out' : err.message;
      console.error(`[Moltbook] API error (${method} ${path}):`, error);
      return { success: false, error };
    }
  }

  // ==========================================
  // AGENT IDENTITY
  // ==========================================

  /**
   * Get bot's own profile info
   */
  async getMe() {
    const result = await this.request('GET', '/agents/me');
    if (result.success && (result.name || result.data?.name)) {
      this.botName = result.name || result.data?.name;
      console.log(`[Moltbook] Bot identity: ${this.botName}`);
    }
    return result;
  }

  /**
   * Get another agent's profile
   */
  async getAgentProfile(name) {
    return this.request('GET', `/agents/profile?name=${encodeURIComponent(name)}`);
  }

  /**
   * Check if an agent exists on Moltbook
   */
  async checkAgent(handle) {
    return this.request('GET', `/agents/${encodeURIComponent(handle)}`);
  }

  // ==========================================
  // SUBMOLT MANAGEMENT
  // ==========================================

  /**
   * Ensure our submolt exists, create if not
   */
  async ensureSubmolt() {
    // Check if it exists
    const existing = await this.request('GET', `/submolts/${this.submolt}`);
    if (existing.success) {
      console.log(`[Moltbook] Submolt m/${this.submolt} exists`);
      return existing;
    }

    // Create it
    console.log(`[Moltbook] Creating submolt m/${this.submolt}...`);
    const result = await this.request('POST', '/submolts', {
      name: this.submolt,
      description: 'AgentBets - Prediction Markets for AI Agents on Solana. Create bets, place wagers, and earn USDC.',
      rules: 'Post market announcements, create bets with "bet:" prefix, discuss predictions. Powered by Poll.fun SDK on Solana mainnet.'
    });

    if (result.success) {
      console.log(`[Moltbook] Created submolt m/${this.submolt}`);
    } else {
      console.warn(`[Moltbook] Could not create submolt: ${result.error}`);
    }

    return result;
  }

  /**
   * Subscribe to a submolt
   */
  async subscribeToSubmolt(name) {
    return this.request('POST', `/submolts/${name}/subscribe`);
  }

  // ==========================================
  // POSTING
  // ==========================================

  /**
   * Create a post in the agentbets submolt
   * Used for market announcements
   */
  async post(title, content, options = {}) {
    if (!this.enabled) {
      console.log('[Moltbook] Would post:', title);
      return { success: false, reason: 'Moltbook not configured' };
    }

    const body = {
      submolt: options.submolt || this.submolt,
      title: title.slice(0, 300), // Title max length
      content: content.slice(0, 10000) // Content max length
    };

    if (options.url) {
      body.url = options.url;
    }

    const result = await this.request('POST', '/posts', body);

    if (result.success) {
      console.log(`[Moltbook] Posted: "${title.slice(0, 50)}..." (ID: ${result.id || result.data?.id})`);
    } else {
      console.error(`[Moltbook] Failed to post: ${result.error}`);
    }

    return result;
  }

  /**
   * Reply to a post with a comment
   */
  async comment(postId, content, parentCommentId = null) {
    if (!this.enabled) {
      console.log('[Moltbook] Would comment on', postId, ':', content.slice(0, 50));
      return { success: false, reason: 'Moltbook not configured' };
    }

    const body = {
      content: content.slice(0, 10000)
    };

    if (parentCommentId) {
      body.parent_id = parentCommentId;
    }

    const result = await this.request('POST', `/posts/${postId}/comments`, body);

    if (result.success) {
      console.log(`[Moltbook] Commented on post ${postId}`);
    } else {
      console.error(`[Moltbook] Failed to comment: ${result.error}`);
    }

    return result;
  }

  // ==========================================
  // READING / POLLING
  // ==========================================

  /**
   * Get recent posts from the agentbets submolt
   * Used to find new bet requests from other agents
   */
  async getSubmoltPosts(submoltName = null, sort = 'new', limit = 25) {
    const name = submoltName || this.submolt;
    return this.request('GET', `/submolts/${name}/feed?sort=${sort}&limit=${limit}`);
  }

  /**
   * Get comments on a specific post
   */
  async getPostComments(postId, sort = 'new') {
    return this.request('GET', `/posts/${postId}/comments?sort=${sort}`);
  }

  /**
   * Get a single post by ID
   */
  async getPost(postId) {
    return this.request('GET', `/posts/${postId}`);
  }

  /**
   * Search for posts/comments mentioning specific terms
   * Useful for finding bet requests outside our submolt
   */
  async search(query, type = 'all', limit = 20) {
    return this.request('GET', `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`);
  }

  /**
   * Get the personalized feed (posts from followed agents)
   */
  async getFeed(sort = 'hot', limit = 25) {
    return this.request('GET', `/feed?sort=${sort}&limit=${limit}`);
  }

  /**
   * Check for DMs
   */
  async checkDMs() {
    return this.request('GET', '/agents/dm/check');
  }

  // ==========================================
  // SOCIAL ACTIONS
  // ==========================================

  /**
   * Follow another agent
   */
  async follow(agentName) {
    return this.request('POST', `/agents/${encodeURIComponent(agentName)}/follow`);
  }

  /**
   * Upvote a post
   */
  async upvote(postId) {
    return this.request('POST', `/posts/${postId}/upvote`);
  }

  // ==========================================
  // MARKET ANNOUNCEMENT HELPERS
  // ==========================================

  /**
   * Announce a new market on Moltbook
   * Posts to m/agentbets with market details and betting link
   */
  async announceMarket(market) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${market.id}`;
    const actionUrl = `solana-action:${baseUrl}/api/actions/bet/${market.id}`;
    const blinkUrl = `https://dial.to/?action=${encodeURIComponent(actionUrl)}`;

    const title = `New Market: ${market.question}`;

    const content = [
      `**${market.question}**`,
      '',
      market.description || '',
      '',
      `**Category:** ${market.category || 'general'}`,
      `**Ends:** ${new Date(market.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      `**Resolution:** ${market.resolutionSource || 'manual'}`,
      market.threshold ? `**Threshold:** ${market.threshold}` : '',
      '',
      `**Bet with USDC on Solana:**`,
      `[View Market](${marketUrl}) | [Bet via Blink](${blinkUrl})`,
      '',
      `To create your own bet, reply with:`,
      `\`bet: "Your question here?" ends: YYYY-MM-DD resolution: dexscreener|x-api|moltbook|manual\``,
      '',
      market.creatorAgent ? `Created by ${market.creatorAgent}` : 'Created by AgentBets Bot'
    ].filter(Boolean).join('\n');

    return this.post(title, content, { url: marketUrl });
  }

  /**
   * Announce a market resolution proposal
   */
  async announceProposal(marketId, data, result) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    const title = `Market Ending: ${data.question.slice(0, 100)}`;

    const content = [
      `**${data.question}**`,
      '',
      `**Proposed Outcome:** ${result.outcome}`,
      `**Data:** ${result.actualValue}`,
      `**Source:** ${result.source || data.resolution}`,
      '',
      `Awaiting admin verification...`,
      '',
      `[View Market](${marketUrl})`
    ].join('\n');

    return this.post(title, content, { url: marketUrl });
  }

  /**
   * Announce final market resolution
   */
  async announceResolution(marketId, data, result) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    const title = `Resolved: ${result.outcome} wins! - ${data.question.slice(0, 80)}`;

    const content = [
      `**${data.question}**`,
      '',
      `**Result:** ${result.outcome} wins!`,
      `**Data:** ${result.actualValue}`,
      `**Source:** ${result.source || data.resolution}`,
      '',
      `Winnings distributed to winners!`,
      '',
      `[View Results](${marketUrl})`
    ].join('\n');

    return this.post(title, content, { url: marketUrl });
  }

  /**
   * Check for new bet requests in submolt posts and comments
   * Returns array of items that look like bet creation requests
   */
  async checkForBetRequests() {
    if (!this.enabled) return [];

    const betRequests = [];

    try {
      // 1. Check new posts in m/agentbets
      const posts = await this.getSubmoltPosts(this.submolt, 'new', 10);
      if (posts.success && posts.data) {
        const postList = Array.isArray(posts.data) ? posts.data : (posts.data.posts || []);
        for (const post of postList) {
          // Skip our own posts
          if (post.author === this.botName) continue;

          const text = `${post.title || ''} ${post.content || ''}`;
          if (this.looksLikeBetRequest(text)) {
            betRequests.push({
              type: 'post',
              id: post.id,
              author: post.author,
              text,
              createdAt: post.created_at || post.createdAt,
              platform: 'moltbook'
            });
          }
        }
      }

      // 2. Search for "bet:" or "create bet" mentions across Moltbook
      const searchResult = await this.search('agentbets bet:', 'all', 10);
      if (searchResult.success && searchResult.data) {
        const results = Array.isArray(searchResult.data) ? searchResult.data : (searchResult.data.results || []);
        for (const item of results) {
          if (item.author === this.botName) continue;

          const text = item.content || item.title || '';
          if (this.looksLikeBetRequest(text)) {
            betRequests.push({
              type: item.type || 'search_result',
              id: item.id,
              postId: item.post_id || item.postId,
              author: item.author,
              text,
              createdAt: item.created_at || item.createdAt,
              platform: 'moltbook'
            });
          }
        }
      }
    } catch (err) {
      console.error('[Moltbook] Error checking for bet requests:', err.message);
    }

    return betRequests;
  }

  /**
   * Simple check if text looks like a bet creation request
   * Full parsing is handled by the BetParser
   */
  looksLikeBetRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return lower.includes('bet:') ||
           lower.includes('create bet') ||
           lower.includes('new bet') ||
           lower.includes('prediction:') ||
           lower.includes('market:');
  }

  /**
   * Reply to a bet request with market creation result
   */
  async replyToRequest(request, market) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${market.market?.id || market.id}`;

    if (market.success) {
      const content = [
        `Market created! Bet with USDC on Solana.`,
        '',
        `**${market.market?.question || 'Market'}**`,
        `**Market ID:** ${market.market?.id || market.id}`,
        `**Ends:** ${market.market?.endDate ? new Date(market.market.endDate).toLocaleDateString() : 'TBD'}`,
        '',
        `[Place Your Bet](${marketUrl})`,
        '',
        `Created by @${request.author} via AgentBets`
      ].join('\n');

      // If it was a post, comment on it; if a comment, reply to it
      if (request.type === 'post') {
        return this.comment(request.id, content);
      } else if (request.postId) {
        return this.comment(request.postId, content, request.id);
      }
    } else {
      const content = `Sorry @${request.author}, I couldn't create your bet: ${market.error}`;

      if (request.type === 'post') {
        return this.comment(request.id, content);
      } else if (request.postId) {
        return this.comment(request.postId, content, request.id);
      }
    }

    return { success: false, error: 'Could not determine how to reply' };
  }
}

module.exports = MoltbookService;
