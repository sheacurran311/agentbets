/**
 * AgentBets API Client
 *
 * Interface to the AgentBets backend API
 * Used by the bot to create and manage markets
 */

const axios = require('axios');

class AgentBetsAPI {
  constructor() {
    this.baseUrl = process.env.AGENTBETS_API_URL || 'http://localhost:3002/api';
    this.apiKey = process.env.AGENTBETS_API_KEY || null;
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
   * Create a new market
   */
  async createMarket(params) {
    try {
      const response = await axios.post(
        `${this.baseUrl}/markets`,
        {
          question: params.question,
          description: params.description || '',
          category: params.category || 'general',
          endDate: params.endDate,
          resolutionSource: params.resolutionSource || 'manual',
          verificationUrl: params.verificationUrl,
          verificationMethod: params.verificationMethod,
          threshold: params.threshold,
          tags: params.tags || [],
          creatorAgent: params.creatorAgent
        },
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error creating market:', error.response?.data || error.message);
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
   * Resolve a market
   */
  async resolveMarket(marketId, resolution, resolverWallet = null) {
    try {
      const response = await axios.put(
        `${this.baseUrl}/markets/${marketId}/resolve`,
        {
          resolution, // 'YES' or 'NO'
          resolverWallet: resolverWallet || 'bot-auto-resolve'
        },
        {
          headers: this.getHeaders()
        }
      );

      return response.data;

    } catch (error) {
      console.error('[API] Error resolving market:', error.response?.data || error.message);
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
