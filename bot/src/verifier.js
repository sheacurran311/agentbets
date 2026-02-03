/**
 * Agent Verification System
 *
 * Verifies that X accounts are legitimate AI agents
 * Multiple verification methods:
 * 1. X "Automated" account label
 * 2. Moltbook registration
 * 3. Whitelist of known agents
 * 4. Account metadata analysis
 */

const axios = require('axios');

class AgentVerifier {
  constructor() {
    // Known agent handles (whitelist)
    this.knownAgents = new Set([
      'aibutters',
      'crabkarmabot',
      'clawdkrab',
      'bankr',
      'bankrbot',
      'truth_terminal',
      'aixbt_agent',
      'luna_virtuals',
      'zerebro',
      'aikitoken',
      // Add more known agents here
    ]);

    // Moltbook API endpoint
    this.moltbookApi = process.env.MOLTBOOK_API_URL || 'https://api.moltbook.com/v1';

    // Keywords in bio that suggest agent
    this.agentBioKeywords = [
      'ai agent', 'autonomous', 'bot', 'automated',
      'artificial intelligence', 'llm', 'gpt',
      'agent', 'built by', 'powered by ai'
    ];
  }

  /**
   * Verify if an X account is a legitimate agent
   * Returns verification status and agent type
   */
  async verifyAgent(handle, userId) {
    const lowerHandle = handle.toLowerCase();

    // Check 1: Known agent whitelist
    if (this.knownAgents.has(lowerHandle)) {
      return {
        isAgent: true,
        agentType: 'whitelisted',
        reason: 'Known verified agent'
      };
    }

    // Check 2: Moltbook registration
    try {
      const moltbookVerified = await this.checkMoltbook(handle);
      if (moltbookVerified.isAgent) {
        return {
          isAgent: true,
          agentType: 'moltbook',
          reason: 'Registered on Moltbook',
          moltbookData: moltbookVerified.data
        };
      }
    } catch (error) {
      console.log(`[Verifier] Moltbook check failed: ${error.message}`);
    }

    // Check 3: X Account metadata (automated label)
    try {
      const xVerified = await this.checkXAccount(handle);
      if (xVerified.isAgent) {
        return {
          isAgent: true,
          agentType: 'x-automated',
          reason: 'X Automated account label'
        };
      }
    } catch (error) {
      console.log(`[Verifier] X account check failed: ${error.message}`);
    }

    // Check 4: Bio analysis (fallback)
    try {
      const bioVerified = await this.analyzeBio(handle);
      if (bioVerified.isAgent) {
        return {
          isAgent: true,
          agentType: 'bio-detected',
          reason: 'Bio indicates AI agent',
          confidence: bioVerified.confidence
        };
      }
    } catch (error) {
      console.log(`[Verifier] Bio analysis failed: ${error.message}`);
    }

    // Not verified as agent
    return {
      isAgent: false,
      reason: 'Could not verify as AI agent. Must have X Automated label or Moltbook registration.'
    };
  }

  /**
   * Check if account is registered on Moltbook
   */
  async checkMoltbook(handle) {
    // If Moltbook API is available
    if (process.env.MOLTBOOK_API_KEY) {
      try {
        const response = await axios.get(
          `${this.moltbookApi}/agents/by-handle/${handle}`,
          {
            headers: {
              'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`
            }
          }
        );

        if (response.data && response.data.isVerified) {
          return {
            isAgent: true,
            data: {
              id: response.data.id,
              karma: response.data.karma,
              trustScore: response.data.trustScore
            }
          };
        }
      } catch (error) {
        // 404 means not found, not an error
        if (error.response?.status !== 404) {
          throw error;
        }
      }
    }

    // Fallback: Check public Moltbook profile page
    try {
      const response = await axios.get(
        `https://www.moltbook.com/u/${handle}`,
        { timeout: 5000 }
      );

      // If page exists and doesn't redirect, they have a profile
      if (response.status === 200 && response.data.includes('moltbook')) {
        return {
          isAgent: true,
          data: { source: 'public-profile' }
        };
      }
    } catch (error) {
      // Profile doesn't exist
    }

    return { isAgent: false };
  }

  /**
   * Check X account for automated label
   */
  async checkXAccount(handle) {
    if (!process.env.TWITTER_BEARER_TOKEN) {
      return { isAgent: false };
    }

    try {
      const response = await axios.get(
        `https://api.twitter.com/2/users/by/username/${handle}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
          },
          params: {
            'user.fields': 'description,verified_type,entities'
          }
        }
      );

      const user = response.data?.data;

      if (!user) {
        return { isAgent: false };
      }

      // Check for automated/bot label
      // X marks automated accounts with specific flags
      if (user.verified_type === 'automated' ||
          user.verified_type === 'bot') {
        return { isAgent: true };
      }

      return { isAgent: false };

    } catch (error) {
      throw error;
    }
  }

  /**
   * Analyze account bio for agent indicators
   */
  async analyzeBio(handle) {
    if (!process.env.TWITTER_BEARER_TOKEN) {
      return { isAgent: false, confidence: 0 };
    }

    try {
      const response = await axios.get(
        `https://api.twitter.com/2/users/by/username/${handle}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
          },
          params: {
            'user.fields': 'description,name'
          }
        }
      );

      const user = response.data?.data;

      if (!user) {
        return { isAgent: false, confidence: 0 };
      }

      const bio = (user.description || '').toLowerCase();
      const name = (user.name || '').toLowerCase();

      // Count matching keywords
      let matches = 0;
      for (const keyword of this.agentBioKeywords) {
        if (bio.includes(keyword) || name.includes(keyword)) {
          matches++;
        }
      }

      // Also check for common agent naming patterns
      if (/bot$|agent$|_ai$/i.test(handle)) {
        matches++;
      }

      const confidence = Math.min(matches / 3, 1); // Max 100% confidence

      return {
        isAgent: matches >= 2, // Require at least 2 indicators
        confidence
      };

    } catch (error) {
      throw error;
    }
  }

  /**
   * Add an agent to the whitelist
   */
  addToWhitelist(handle) {
    this.knownAgents.add(handle.toLowerCase());
  }

  /**
   * Remove an agent from the whitelist
   */
  removeFromWhitelist(handle) {
    this.knownAgents.delete(handle.toLowerCase());
  }

  /**
   * Check if handle is whitelisted
   */
  isWhitelisted(handle) {
    return this.knownAgents.has(handle.toLowerCase());
  }
}

module.exports = AgentVerifier;
