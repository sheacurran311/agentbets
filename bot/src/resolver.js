/**
 * Auto-Resolution Engine
 *
 * Automatically resolves markets using API data
 * Supports multiple data sources:
 * - DexScreener (token prices, mcap)
 * - X API (followers, engagement)
 * - Moltbook (karma, agent stats)
 * - GitHub (commits, releases)
 * - Solana (balances, transactions)
 */

const axios = require('axios');

class ResolutionEngine {
  constructor() {
    this.dexscreenerApi = 'https://api.dexscreener.com/latest';
    this.moltbookApi = process.env.MOLTBOOK_API_URL || 'https://api.moltbook.com/v1';
  }

  /**
   * Resolve a market based on its resolution source
   */
  async resolve(data) {
    const { resolution, question, threshold, targetHandle, targetToken } = data;

    try {
      switch (resolution) {
        case 'dexscreener':
          return await this.resolveDexScreener(targetToken, threshold, question);

        case 'x-api':
          return await this.resolveXApi(targetHandle, threshold, question);

        case 'moltbook':
          return await this.resolveMoltbook(targetHandle, threshold, question);

        case 'github':
          return await this.resolveGitHub(data);

        case 'solana':
          return await this.resolveSolana(data);

        case 'manual':
        default:
          return {
            resolved: false,
            error: 'Manual resolution required'
          };
      }
    } catch (error) {
      return {
        resolved: false,
        error: error.message
      };
    }
  }

  /**
   * Resolve using DexScreener data
   */
  async resolveDexScreener(token, threshold, question) {
    if (!token) {
      // Try to extract token from question
      const match = question.match(/\$([A-Z]+)/);
      if (match) {
        token = match[1];
      } else {
        return { resolved: false, error: 'No token specified' };
      }
    }

    try {
      // Search for token on DexScreener
      const response = await axios.get(
        `${this.dexscreenerApi}/dex/search?q=${token}`,
        { timeout: 10000 }
      );

      const pairs = response.data?.pairs;

      if (!pairs || pairs.length === 0) {
        return { resolved: false, error: `Token ${token} not found on DexScreener` };
      }

      // Get the most liquid pair
      const pair = pairs[0];
      const mcap = pair.fdv || pair.marketCap || 0;
      const price = parseFloat(pair.priceUsd) || 0;

      // Parse threshold
      const thresholdNum = this.parseThreshold(threshold);

      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      // Determine if question is about mcap or price
      const isMcapQuestion = /mcap|market cap/i.test(question);
      const actualValue = isMcapQuestion ? mcap : price;
      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      return {
        resolved: true,
        outcome,
        actualValue: isMcapQuestion
          ? `$${this.formatNumber(mcap)} mcap`
          : `$${price.toFixed(6)} price`,
        threshold: `$${this.formatNumber(thresholdNum)}`,
        source: 'DexScreener',
        data: {
          token,
          pair: pair.pairAddress,
          mcap,
          price
        }
      };

    } catch (error) {
      return { resolved: false, error: `DexScreener API error: ${error.message}` };
    }
  }

  /**
   * Resolve using X API data
   */
  async resolveXApi(handle, threshold, question) {
    if (!process.env.TWITTER_BEARER_TOKEN) {
      return { resolved: false, error: 'X API not configured' };
    }

    if (!handle) {
      // Try to extract handle from question
      const match = question.match(/@(\w+)/);
      if (match) {
        handle = match[1];
      } else {
        return { resolved: false, error: 'No X handle specified' };
      }
    }

    try {
      const response = await axios.get(
        `https://api.twitter.com/2/users/by/username/${handle}`,
        {
          headers: {
            'Authorization': `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
          },
          params: {
            'user.fields': 'public_metrics'
          }
        }
      );

      const user = response.data?.data;

      if (!user) {
        return { resolved: false, error: `User @${handle} not found` };
      }

      const metrics = user.public_metrics || {};

      // Determine what metric we're checking
      let actualValue;
      let metricName;

      if (/followers/i.test(question)) {
        actualValue = metrics.followers_count || 0;
        metricName = 'followers';
      } else if (/following/i.test(question)) {
        actualValue = metrics.following_count || 0;
        metricName = 'following';
      } else if (/tweets|posts/i.test(question)) {
        actualValue = metrics.tweet_count || 0;
        metricName = 'tweets';
      } else {
        // Default to followers
        actualValue = metrics.followers_count || 0;
        metricName = 'followers';
      }

      // Parse threshold
      const thresholdNum = this.parseThreshold(threshold);

      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      return {
        resolved: true,
        outcome,
        actualValue: `${this.formatNumber(actualValue)} ${metricName}`,
        threshold: this.formatNumber(thresholdNum),
        source: 'X API',
        data: {
          handle,
          metrics
        }
      };

    } catch (error) {
      return { resolved: false, error: `X API error: ${error.message}` };
    }
  }

  /**
   * Resolve using Moltbook data
   */
  async resolveMoltbook(handle, threshold, question) {
    if (!handle) {
      // Try to extract handle from question
      const match = question.match(/@(\w+)/);
      if (match) {
        handle = match[1];
      } else {
        return { resolved: false, error: 'No Moltbook handle specified' };
      }
    }

    try {
      // Try API first if available
      if (process.env.MOLTBOOK_API_KEY) {
        const response = await axios.get(
          `${this.moltbookApi}/agents/by-handle/${handle}`,
          {
            headers: {
              'Authorization': `Bearer ${process.env.MOLTBOOK_API_KEY}`
            }
          }
        );

        const agent = response.data;

        if (!agent) {
          return { resolved: false, error: `Agent @${handle} not found on Moltbook` };
        }

        // Determine what metric we're checking
        let actualValue;
        let metricName;

        if (/karma/i.test(question)) {
          actualValue = agent.karma || 0;
          metricName = 'karma';
        } else if (/followers|submolters/i.test(question)) {
          actualValue = agent.followers || 0;
          metricName = 'submolters';
        } else {
          actualValue = agent.karma || 0;
          metricName = 'karma';
        }

        const thresholdNum = this.parseThreshold(threshold);

        if (!thresholdNum) {
          return { resolved: false, error: 'Could not parse threshold' };
        }

        const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

        return {
          resolved: true,
          outcome,
          actualValue: `${this.formatNumber(actualValue)} ${metricName}`,
          threshold: this.formatNumber(thresholdNum),
          source: 'Moltbook',
          data: agent
        };
      }

      return { resolved: false, error: 'Moltbook API not configured' };

    } catch (error) {
      return { resolved: false, error: `Moltbook API error: ${error.message}` };
    }
  }

  /**
   * Resolve using GitHub data
   */
  async resolveGitHub(data) {
    // Parse repo from question
    const repoMatch = data.question.match(/github\.com\/([^\/]+\/[^\s\/]+)/i) ||
                     data.question.match(/(\w+\/\w+)\s+(?:repo|repository)/i);

    if (!repoMatch) {
      return { resolved: false, error: 'No GitHub repo specified' };
    }

    const repo = repoMatch[1];

    try {
      const response = await axios.get(
        `https://api.github.com/repos/${repo}`,
        {
          headers: process.env.GITHUB_TOKEN
            ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
            : {}
        }
      );

      const repoData = response.data;

      // Check for releases/tags if that's what we're looking for
      if (/ship|release|launch/i.test(data.question)) {
        const releasesResponse = await axios.get(
          `https://api.github.com/repos/${repo}/releases/latest`,
          {
            headers: process.env.GITHUB_TOKEN
              ? { 'Authorization': `token ${process.env.GITHUB_TOKEN}` }
              : {}
          }
        );

        const hasRelease = releasesResponse.status === 200;
        return {
          resolved: true,
          outcome: hasRelease ? 'YES' : 'NO',
          actualValue: hasRelease ? 'Release found' : 'No release',
          source: 'GitHub'
        };
      }

      // Default: check if repo exists and is active
      return {
        resolved: true,
        outcome: repoData ? 'YES' : 'NO',
        actualValue: `${repoData.stargazers_count} stars`,
        source: 'GitHub'
      };

    } catch (error) {
      if (error.response?.status === 404) {
        return {
          resolved: true,
          outcome: 'NO',
          actualValue: 'Repo not found',
          source: 'GitHub'
        };
      }
      return { resolved: false, error: `GitHub API error: ${error.message}` };
    }
  }

  /**
   * Resolve using Solana on-chain data
   */
  async resolveSolana(data) {
    // This would check Solana RPC for wallet balances, transactions, etc.
    // For now, return manual resolution needed
    return {
      resolved: false,
      error: 'Solana on-chain resolution not yet implemented'
    };
  }

  /**
   * Parse threshold string into number
   */
  parseThreshold(threshold) {
    if (!threshold) return null;

    let str = String(threshold).toLowerCase().trim();

    // Remove $ and commas
    str = str.replace(/[$,]/g, '');

    // Handle K/M suffixes
    let multiplier = 1;
    if (str.endsWith('k')) {
      multiplier = 1000;
      str = str.slice(0, -1);
    } else if (str.endsWith('m')) {
      multiplier = 1000000;
      str = str.slice(0, -1);
    }

    // Remove any remaining non-numeric chars
    str = str.replace(/[^0-9.]/g, '');

    const num = parseFloat(str);
    return isNaN(num) ? null : num * multiplier;
  }

  /**
   * Format number with commas and K/M suffixes
   */
  formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(2) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toLocaleString();
  }
}

module.exports = ResolutionEngine;
