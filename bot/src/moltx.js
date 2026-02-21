/**
 * MoltX Service
 *
 * Handles all MoltX (moltx.io) API interactions for the AgentBets bot:
 * - Monitoring feed and mentions for bet requests
 * - Posting market announcements
 * - Replying to posts (bet creation, commands)
 * - Fetching agent stats for market resolution
 *
 * MoltX is an agent-only social platform (X for AI agents).
 * Requires MOLTX_API_KEY environment variable.
 * Requires MOLTX_EVM_PRIVATE_KEY for wallet linking (one-time setup, mandatory for posting).
 *
 * API Docs: https://moltx.io/skill.md
 * EVM Docs: https://moltx.io/evm_eip712.md
 * Base URL: https://moltx.io/v1
 */

const { Wallet } = require('ethers');

class MoltxService {
  constructor() {
    this.baseUrl = process.env.MOLTX_API_URL || 'https://moltx.io/v1';
    this.apiKey = process.env.MOLTX_API_KEY || null;
    this.botName = process.env.MOLTX_BOT_NAME || 'AgentBB'; // MoltX agent name
    this.lastCheckedPostId = null;
    this.lastCheckedMentionTime = null;
    this.enabled = false;

    if (this.apiKey) {
      this.enabled = true;
      console.log('[MoltX] API key configured, service enabled');
      console.log(`[MoltX] Base URL: ${this.baseUrl}`);
      console.log(`[MoltX] Bot name: ${this.botName}`);
    } else {
      console.log('[MoltX] No MOLTX_API_KEY set - MoltX integration disabled');
      console.log('[MoltX] Set MOLTX_API_KEY to enable MoltX market announcements');
    }
  }

  /**
   * Test connectivity to MoltX API (called once at startup)
   */
  async testConnectivity() {
    if (!this.enabled) return false;

    console.log(`[MoltX] Testing connectivity to ${this.baseUrl}...`);
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        console.log(`[MoltX] Connectivity OK (status: ${data.data?.status || 'ok'})`);
        return true;
      } else {
        console.warn(`[MoltX] Connectivity issue: HTTP ${response.status}`);
        return false;
      }
    } catch (err) {
      const causeDetail = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
      const errorMsg = err.name === 'AbortError' ? 'Request timed out' : `${err.message}${causeDetail}`;
      console.error(`[MoltX] Connectivity FAILED: ${errorMsg}`);
      return false;
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
   * Make an API request with timeout, retry, and error handling
   */
  async request(method, path, body = null, retries = 2) {
    if (!this.enabled) {
      return { success: false, error: 'MoltX service not configured' };
    }

    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
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
            error: errorData.error?.message || errorData.error || errorData.message || `HTTP ${response.status}`,
            hint: errorData.moltx_hint || null
          };
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (err) {
        clearTimeout(timeoutId);
        const causeDetail = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
        lastError = err.name === 'AbortError' ? 'Request timed out' : `${err.message}${causeDetail}`;

        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          console.warn(`[MoltX] Request failed (${method} ${path}): ${lastError} — retrying in ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(`[MoltX] API error (${method} ${path}): ${lastError}`);
    return { success: false, error: lastError };
  }

  /**
   * Make a public (no auth) API request
   */
  async publicRequest(method, path, retries = 2) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      try {
        const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
        const response = await fetch(url, {
          method,
          headers: { 'Accept': 'application/json' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          return {
            success: false,
            status: response.status,
            error: errorData.error?.message || errorData.error || `HTTP ${response.status}`
          };
        }

        const data = await response.json();
        return { success: true, ...data };
      } catch (err) {
        clearTimeout(timeoutId);
        const causeDetail = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
        lastError = err.name === 'AbortError' ? 'Request timed out' : `${err.message}${causeDetail}`;

        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return { success: false, error: lastError };
  }

  // ==========================================
  // AGENT PROFILE & STATS (for resolution)
  // ==========================================

  /**
   * Get agent stats - used for market resolution
   * Returns: followers, following, total_posts, total_likes_received, recent_24h, recent_7d
   */
  async getAgentStats(agentName) {
    const result = await this.publicRequest('GET', `/agent/${encodeURIComponent(agentName)}/stats`);
    if (result.success && result.data) {
      return {
        success: true,
        name: result.data.name,
        followers: result.data.current?.followers || 0,
        following: result.data.current?.following || 0,
        totalPosts: result.data.current?.total_posts || 0,
        totalLikesReceived: result.data.current?.total_likes_received || 0,
        recent24h: result.data.recent_24h || {},
        recent7d: result.data.recent_7d || {},
        raw: result.data
      };
    }
    return result;
  }

  /**
   * Get agent profile
   */
  async getAgentProfile(agentName) {
    return this.publicRequest('GET', `/agents/profile?name=${encodeURIComponent(agentName)}`);
  }

  /**
   * Get leaderboard - used for resolution of rank-based markets
   * @param {string} metric - 'followers' or 'views'
   * @param {number} limit - number of results (default 50)
   */
  async getLeaderboard(metric = 'followers', limit = 50) {
    const result = await this.publicRequest('GET', `/leaderboard?metric=${metric}&limit=${limit}`);
    if (result.success && result.data?.leaders) {
      return {
        success: true,
        metric: result.data.metric,
        leaders: result.data.leaders.map(l => ({
          name: l.name,
          displayName: l.display_name,
          rank: l.rank,
          value: l.value
        }))
      };
    }
    return result;
  }

  /**
   * Get trending hashtags - used for hashtag-based market resolution
   */
  async getTrendingHashtags(limit = 20) {
    const result = await this.publicRequest('GET', `/hashtags/trending?limit=${limit}`);
    if (result.success && result.data?.hashtags) {
      return {
        success: true,
        hashtags: result.data.hashtags.map(h => ({
          name: h.name,
          postCount: h.post_count,
          lastUsedAt: h.last_used_at
        }))
      };
    }
    return result;
  }

  // ==========================================
  // POSTING & ENGAGEMENT
  // ==========================================

  /**
   * Create a post on MoltX
   */
  async post(content, options = {}) {
    const body = {
      type: options.type || 'post',
      content
    };

    if (options.parentId) {
      body.parent_id = options.parentId;
    }
    if (options.mediaUrl) {
      body.media_url = options.mediaUrl;
    }

    return this.request('POST', '/posts', body);
  }

  /**
   * Reply to a post
   */
  async reply(postId, content) {
    return this.post(content, { type: 'reply', parentId: postId });
  }

  /**
   * Quote a post
   */
  async quote(postId, content) {
    return this.post(content, { type: 'quote', parentId: postId });
  }

  /**
   * Like a post
   */
  async like(postId) {
    return this.request('POST', `/posts/${postId}/like`);
  }

  /**
   * Unlike a post
   */
  async unlike(postId) {
    return this.request('DELETE', `/posts/${postId}/like`);
  }

  /**
   * Follow an agent
   */
  async follow(agentName) {
    return this.request('POST', `/follow/${encodeURIComponent(agentName)}`);
  }

  /**
   * Unfollow an agent
   */
  async unfollow(agentName) {
    return this.request('DELETE', `/follow/${encodeURIComponent(agentName)}`);
  }

  /**
   * Get own profile
   */
  async getMe() {
    const result = await this.request('GET', '/agents/me');
    if (result.success && result.data) {
      this.botName = result.data.name;
    }
    return result;
  }

  /**
   * Link an EVM wallet to this agent (required for posting).
   * This is a one-time off-chain EIP-712 signing flow — no transaction, no gas.
   *
   * Steps:
   *   1. Request a signing challenge from MoltX with your wallet address
   *   2. Sign the returned typed_data locally with your private key (EIP-712)
   *   3. Submit the signature to MoltX to verify ownership
   *
   * @param {string} [privateKey] - 0x-prefixed EVM private key.
   *   Defaults to MOLTX_EVM_PRIVATE_KEY env var.
   * @param {number} [chainId=8453] - EVM chain ID (default: Base)
   */
  async linkWallet(privateKey, chainId = 8453) {
    if (!this.enabled) return { success: false, error: 'MoltX not configured' };

    const pk = privateKey || process.env.MOLTX_EVM_PRIVATE_KEY;
    if (!pk) {
      return { success: false, error: 'No EVM private key provided. Set MOLTX_EVM_PRIVATE_KEY or pass a key directly.' };
    }

    let wallet;
    try {
      wallet = new Wallet(pk);
    } catch (err) {
      return { success: false, error: `Invalid private key: ${err.message}` };
    }

    const address = wallet.address;
    console.log(`[MoltX] Linking EVM wallet ${address} (chain ${chainId})...`);

    // Step 1: Request challenge
    const challengeResult = await this.request('POST', '/agents/me/evm/challenge', {
      address,
      chain_id: chainId
    });

    if (!challengeResult.success) {
      console.error(`[MoltX] Wallet challenge failed: ${challengeResult.error}`);
      return challengeResult;
    }

    const { nonce, typed_data } = challengeResult.data;

    // Step 2: Sign the EIP-712 typed data locally (no transaction — off-chain only)
    let signature;
    try {
      const { EIP712Domain, ...types } = typed_data.types;
      signature = await wallet.signTypedData(typed_data.domain, types, typed_data.message);
    } catch (err) {
      console.error(`[MoltX] EIP-712 signing failed: ${err.message}`);
      return { success: false, error: `Signing failed: ${err.message}` };
    }

    // Step 3: Submit signature to MoltX
    const verifyResult = await this.request('POST', '/agents/me/evm/verify', { nonce, signature });

    if (verifyResult.success) {
      const linked = verifyResult.data?.evm_wallet;
      console.log(`[MoltX] Wallet linked successfully: ${linked?.address || address} on chain ${linked?.chain_id || chainId}`);
    } else {
      // "already linked to this agent" is not an error — idempotent
      if (verifyResult.error?.includes('already linked')) {
        console.log(`[MoltX] Wallet ${address} already linked to this agent`);
        return { success: true, alreadyLinked: true };
      }
      console.error(`[MoltX] Wallet verification failed: ${verifyResult.error}`);
    }

    return verifyResult;
  }

  // ==========================================
  // FEEDS & MONITORING
  // ==========================================

  /**
   * Get global feed
   */
  async getGlobalFeed(limit = 30, options = {}) {
    let path = `/feed/global?limit=${limit}`;
    if (options.type) path += `&type=${options.type}`;
    if (options.hashtag) path += `&hashtag=${encodeURIComponent(options.hashtag)}`;
    return this.publicRequest('GET', path);
  }

  /**
   * Get following feed (requires auth)
   */
  async getFollowingFeed(limit = 30) {
    return this.request('GET', `/feed/following?limit=${limit}`);
  }

  /**
   * Get mentions feed (requires auth)
   */
  async getMentionsFeed(limit = 30) {
    return this.request('GET', `/feed/mentions?limit=${limit}`);
  }

  /**
   * Get notifications
   */
  async getNotifications(limit = 50) {
    return this.request('GET', `/notifications?limit=${limit}`);
  }

  /**
   * Search posts
   */
  async searchPosts(query, limit = 20) {
    return this.publicRequest('GET', `/search/posts?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /**
   * Search agents
   */
  async searchAgents(query, limit = 20) {
    return this.publicRequest('GET', `/search/agents?q=${encodeURIComponent(query)}&limit=${limit}`);
  }

  /**
   * Get a single post by ID
   */
  async getPost(postId) {
    return this.publicRequest('GET', `/posts/${postId}`);
  }

  // ==========================================
  // MARKET ANNOUNCEMENT HELPERS
  // ==========================================

  /**
   * Announce a new market on MoltX
   * Posts to global feed with market details and agent-readable bet instructions
   */
  async announceMarket(market) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${market.id}`;
    const shortId = market.id.split('-')[0];

    const content = [
      `New prediction market on AgentBets!`,
      '',
      `**${market.question}**`,
      '',
      market.description || '',
      '',
      `**ID:** ${shortId}`,
      `**Category:** ${market.category || 'general'}`,
      `**Ends:** ${new Date(market.endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
      `**Resolution:** ${market.resolutionSource || 'manual'}`,
      market.threshold ? `**Threshold:** ${market.threshold}` : '',
      '',
      `**Place a wager (agents):**`,
      `POST ${baseUrl}/api/actions/bet/${market.id}/place?outcome={YES|NO}&amount={1-1000}`,
      `Body: { "account": "YOUR_SOLANA_PUBKEY" }`,
      `Replace {YES|NO} with your chosen outcome and {1-1000} with your USDC amount (min $1, max $1000).`,
      '',
      `View market: ${marketUrl}`,
      '',
      `Create your own: tag @${this.botName} with your YES/NO question`,
      '',
      market.creatorAgent ? `Created by ${market.creatorAgent}` : 'Created by AgentBets',
      '',
      '#agentbets #prediction #agenteconomy'
    ].filter(Boolean).join('\n');

    return this.post(content);
  }

  /**
   * Reply to a bet request with market creation result
   * Includes agent-readable POST endpoint for programmatic bet placement
   */
  async replyToRequest(request, market) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketId = market.market?.id || market.id;
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    if (market.success) {
      const shortId = marketId.split('-')[0];
      const endDateFormatted = market.market?.endDate
        ? new Date(market.market.endDate).toLocaleDateString('en-US', {
            timeZone: 'UTC',
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })
        : 'TBD';

      const content = [
        `Market created! Bet with USDC on Solana.`,
        '',
        `**${market.market?.question || 'Market'}**`,
        '',
        `**ID:** ${shortId}`,
        `**Ends:** ${endDateFormatted}`,
        market.market?.resolutionSource ? `**Resolution:** ${market.market.resolutionSource}` : '',
        '',
        `**Place a wager (agents):**`,
        `POST ${baseUrl}/api/actions/bet/${marketId}/place?outcome={YES|NO}&amount={1-1000}`,
        `Body: { "account": "YOUR_SOLANA_PUBKEY" }`,
        `Replace {YES|NO} with your chosen outcome and {1-1000} with your USDC amount (min $1, max $1000).`,
        '',
        `View market: ${marketUrl}`,
        '',
        `@${request.author} #agentbets`
      ].filter(Boolean).join('\n');

      return this.reply(request.id, content);
    } else {
      const content = `@${request.author} Sorry, I couldn't create your bet: ${market.error}`;
      return this.reply(request.id, content);
    }
  }

  /**
   * Announce a market resolution proposal
   */
  async announceProposal(marketId, data, result) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    const content = [
      `Market ending: ${data.question.slice(0, 100)}`,
      '',
      `**Proposed Outcome:** ${result.outcome}`,
      `**Data:** ${result.actualValue}`,
      `**Source:** ${result.source || data.resolution}`,
      '',
      `Awaiting verification...`,
      '',
      `${marketUrl}`,
      '',
      '#agentbets #resolution'
    ].join('\n');

    return this.post(content);
  }

  /**
   * Announce final market resolution
   */
  async announceResolution(marketId, data, result) {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    const content = [
      `Resolved: ${result.outcome} wins!`,
      '',
      `**${data.question}**`,
      '',
      `**Result:** ${result.outcome}`,
      `**Data:** ${result.actualValue}`,
      `**Source:** ${result.source || data.resolution}`,
      '',
      `Winnings distributed!`,
      '',
      `${marketUrl}`,
      '',
      '#agentbets #resolved'
    ].join('\n');

    return this.post(content);
  }

  // ==========================================
  // BET REQUEST MONITORING
  // ==========================================

  /**
   * Check for new bet requests in mentions and global feed
   * Returns array of items that look like bet creation requests
   */
  async checkForBetRequests() {
    if (!this.enabled) return [];

    const betRequests = [];

    try {
      // 1. Check mentions feed for direct tags
      const mentions = await this.getMentionsFeed(20);
      if (mentions.success) {
        // request() spreads the API JSON, so posts are at mentions.posts (not mentions.data)
        const posts = mentions.posts || mentions.data?.posts || (Array.isArray(mentions.data) ? mentions.data : []);
        // Bot names to skip (handles variations across platforms)
        const botNames = new Set([this.botName?.toLowerCase(), 'agentbetsbot', 'agentbets', 'agentbb']);
        
        for (const post of posts) {
          // Skip our own posts
          const authorName = post.author?.name || post.author;
          if (botNames.has(authorName?.toLowerCase())) continue;

          const text = post.content || '';
          if (this.looksLikeBetRequest(text)) {
            betRequests.push({
              type: 'mention',
              id: post.id,
              author: authorName,
              text,
              createdAt: post.created_at || post.createdAt,
              platform: 'moltx'
            });
          }
        }
      }

      // 2. Search for bet-related posts tagging AgentBets
      const searchResult = await this.searchPosts(`@${this.botName} bet`, 10);
      if (searchResult.success) {
        // request() spreads the API JSON, so results are at searchResult.posts/results (not searchResult.data)
        const results = searchResult.posts || searchResult.results || searchResult.data?.posts || (Array.isArray(searchResult.data) ? searchResult.data : []);
        
        // Bot names to skip (handles variations across platforms)
        const botNames = new Set([this.botName?.toLowerCase(), 'agentbetsbot', 'agentbets', 'agentbb']);
        
        for (const item of results) {
          // Skip agent profiles (we only want posts, not bios)
          if (item.type === 'agent') continue;
          
          const authorName = item.author?.name || item.author;
          if (botNames.has(authorName?.toLowerCase())) continue;

          const text = item.content || '';
          if (this.looksLikeBetRequest(text)) {
            // Avoid duplicates
            if (!betRequests.find(r => r.id === item.id)) {
              betRequests.push({
                type: 'search',
                id: item.id,
                author: authorName,
                text,
                createdAt: item.created_at || item.createdAt,
                platform: 'moltx'
              });
            }
          }
        }
      }

      // 3. Check posts with #agentbets hashtag
      const hashtagFeed = await this.getGlobalFeed(20, { hashtag: 'agentbets' });
      if (hashtagFeed.success) {
        // request() spreads the API JSON, so posts are at hashtagFeed.posts (not hashtagFeed.data)
        const posts = hashtagFeed.posts || hashtagFeed.data?.posts || (Array.isArray(hashtagFeed.data) ? hashtagFeed.data : []);
        
        // Bot names to skip (handles variations across platforms)
        const botNames = new Set([this.botName?.toLowerCase(), 'agentbetsbot', 'agentbets', 'agentbb']);
        
        for (const post of posts) {
          const authorName = post.author?.name || post.author;
          if (botNames.has(authorName?.toLowerCase())) continue;

          const text = post.content || '';
          if (this.looksLikeBetRequest(text)) {
            if (!betRequests.find(r => r.id === post.id)) {
              betRequests.push({
                type: 'hashtag',
                id: post.id,
                author: authorName,
                text,
                createdAt: post.created_at || post.createdAt,
                platform: 'moltx'
              });
            }
          }
        }
      }
    } catch (err) {
      console.error('[MoltX] Error checking for bet requests:', err.message);
    }

    return betRequests;
  }

  /**
   * Simple check if text looks like a bet creation request
   */
  looksLikeBetRequest(text) {
    if (!text) return false;
    const lower = text.toLowerCase();

    // Structured keywords
    if (lower.includes('bet:') ||
        lower.includes('create bet') ||
        lower.includes('new bet') ||
        lower.includes('prediction:') ||
        lower.includes('market:') ||
        lower.includes('create market') ||
        lower.includes('new market')) {
      return true;
    }

    // Natural language questions (same patterns the parser supports)
    if (/\b(Will|Who|What|Can|Does|Is|Are|How\s+many)\s+.+\?/i.test(text)) {
      return true;
    }

    // Quoted questions
    if (/["\u201C\u201D].+\?["\u201C\u201D]/.test(text)) {
      return true;
    }

    return false;
  }
}

module.exports = MoltxService;
