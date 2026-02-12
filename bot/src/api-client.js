/**
 * AgentBets API Client
 *
 * Interface to the AgentBets backend API
 * Used by the bot to create and manage markets
 */

const axios = require('axios');

class AgentBetsAPI {
  constructor() {
    let url = process.env.AGENTBETS_API_URL || 'http://localhost:3002/api';

    // Ensure HTTPS for production URLs (HTTP→HTTPS redirects convert POST to GET, causing 404s)
    if (url.startsWith('http://') && !url.includes('localhost') && !url.includes('127.0.0.1')) {
      console.warn(`[API] WARNING: AGENTBETS_API_URL uses http:// — upgrading to https:// to prevent redirect issues`);
      url = url.replace('http://', 'https://');
    }

    // Remove trailing slash
    this.baseUrl = url.replace(/\/+$/, '');
    this.apiKey = process.env.AGENTBETS_API_KEY || null;

    console.log(`[API] Base URL: ${this.baseUrl}`);
  }

  /**
   * Get request headers
   */
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json'
    };

    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }

    return headers;
  }

  /**
   * Create a new on-chain market via Poll.fun
   * Bot's keypair creates the PDA (isCreatorResolver=true)
   */
  async createMarket(params) {
    try {
      // Use on-chain endpoint - bot creates PDA with its keypair
      const body = {
        question: params.question,
        description: params.description || '',
        category: params.category || 'general',
        endDate: params.endDate,
        creatorAgent: params.creatorAgent // For royalty tracking
      };

      // Pass optional fields if provided
      if (params.resolutionSource) body.resolutionSource = params.resolutionSource;
      if (params.threshold) body.threshold = params.threshold;
      if (params.verificationMethod) body.verificationMethod = params.verificationMethod;
      if (params.verificationUrl) body.verificationUrl = params.verificationUrl;
      if (params.tags) body.tags = params.tags;
      if (params.expectedUserCount) body.expectedUserCount = params.expectedUserCount;
      if (params.proposerWallet) body.proposerWallet = params.proposerWallet;
      if (params.resolutionTiming) body.resolutionTiming = params.resolutionTiming;

      console.log(`[API] Creating market: "${params.question?.slice(0, 60)}..." → ${this.baseUrl}/onchain/markets`);

      const response = await axios.post(
        `${this.baseUrl}/onchain/markets`,
        body,
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      const errorDetail = error.response?.data || error.message;
      const status = error.response?.status;
      console.error(`[API] Error creating on-chain market (HTTP ${status || 'N/A'}):`, 
        typeof errorDetail === 'string' ? errorDetail.slice(0, 200) : errorDetail);
      
      // Special handling for 409 Conflict (duplicate market)
      if (status === 409 && error.response?.data?.existingMarket) {
        return {
          success: false,
          isDuplicate: true,
          existingMarket: error.response.data.existingMarket,
          error: error.response.data.error || 'Market already exists'
        };
      }
      
      // Special handling for 429 Too Many Requests (rate limit)
      if (status === 429) {
        return {
          success: false,
          isRateLimited: true,
          limit: error.response?.data?.limit,
          used: error.response?.data?.used,
          resetsAt: error.response?.data?.resetsAt,
          error: error.response?.data?.error || 'Rate limit exceeded'
        };
      }
      
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  }

  /**
   * Get market by ID
   */
  async getMarket(marketId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/markets/${marketId}`,
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error getting market:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Get all markets
   */
  async getMarkets(filters = {}) {
    try {
      const params = new URLSearchParams();

      if (filters.status) params.append('status', filters.status);
      if (filters.category) params.append('category', filters.category);
      if (filters.limit) params.append('limit', filters.limit);

      const response = await axios.get(
        `${this.baseUrl}/markets?${params.toString()}`,
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error getting markets:', error.response?.data || error.message);
      return { markets: [] };
    }
  }

  /**
   * Propose a resolution for a market (two-phase resolution)
   * Bot proposes outcome but does NOT finalize - admin must confirm
   */
  async proposeResolution(marketId, proposedOutcome, confidence = 90, evidence = {}) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/markets/${marketId}/propose-resolution`,
        {
          proposedOutcome, // 'YES' or 'NO'
          confidence, // 0-100
          evidence, // { source, actualValue, threshold, data }
          proposedBy: 'bot-auto-resolver'
        },
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error proposing resolution:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.error || error.message
      };
    }
  }

  /**
   * Get platform stats
   */
  async getStats() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/stats`,
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error getting stats:', error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Get leaderboard
   */
  async getLeaderboard() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/leaderboard`,
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error getting leaderboard:', error.response?.data || error.message);
      return { leaderboard: [] };
    }
  }

  /**
   * Get markets created by a specific agent
   */
  async getAgentMarkets(agentHandle) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/markets`,
        {
          headers: this.getHeaders()
        }
      );

      // Filter by creator agent
      const markets = response.data.markets || [];
      return markets.filter(m =>
        m.creatorAgent?.toLowerCase() === `@${agentHandle.toLowerCase()}`
      );

    } catch (error) {
      console.error('[API] Error getting agent markets:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Get markets pending resolution
   */
  async getPendingResolutions() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/markets?status=active`,
        {
          headers: this.getHeaders()
        }
      );

      const markets = response.data.markets || [];
      const now = new Date();

      // Filter to only ended markets
      return markets.filter(m => new Date(m.endDate) < now);

    } catch (error) {
      console.error('[API] Error getting pending resolutions:', error.response?.data || error.message);
      return [];
    }
  }

  /**
   * Check API health
   */
  async checkHealth() {
    try {
      const response = await axios.get(
        `${this.baseUrl.replace('/api', '')}/health`,
        { timeout: 5000 }
      );

      return {
        healthy: true,
        data: response.data
      };

    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  // ==========================================
  // ROYALTY METHODS
  // ==========================================

  /**
   * Get agent's royalty balance
   */
  async getRoyalties(agentHandle) {
    try {
      const handle = agentHandle.replace('@', '');
      const response = await axios.get(
        `${this.baseUrl}/royalties/${handle}`,
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error) {
      console.error('[API] Error getting royalties:', error.response?.data || error.message);
      return { found: false, error: error.message };
    }
  }

  /**
   * Register wallet for royalty withdrawals
   */
  async registerRoyaltyWallet(agentHandle, wallet) {
    try {
      const handle = agentHandle.replace('@', '');
      const response = await axios.post(
        `${this.baseUrl}/royalties/register`,
        { agentHandle: handle, wallet },
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error) {
      console.error('[API] Error registering wallet:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }

  /**
   * Withdraw pending royalties
   */
  async withdrawRoyalties(agentHandle) {
    try {
      const handle = agentHandle.replace('@', '');
      const response = await axios.post(
        `${this.baseUrl}/royalties/withdraw`,
        { agentHandle: handle },
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error) {
      console.error('[API] Error withdrawing:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.error || error.message };
    }
  }

  /**
   * Get royalty leaderboard
   */
  async getRoyaltyLeaderboard() {
    try {
      const response = await axios.get(
        `${this.baseUrl}/royalties-leaderboard`,
        { headers: this.getHeaders() }
      );
      return response.data;
    } catch (error) {
      console.error('[API] Error getting leaderboard:', error.response?.data || error.message);
      return { topCreators: [] };
    }
  }
}

module.exports = AgentBetsAPI;
