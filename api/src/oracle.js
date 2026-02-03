/**
 * AgentBets Oracle System
 * Handles automatic and manual resolution of prediction markets
 */

const axios = require('axios');

/**
 * Oracle Types and their resolution methods
 */
const ORACLE_TYPES = {
  manual: {
    name: 'Manual Resolution',
    description: 'Market creator or admin resolves manually'
  },
  'x-api': {
    name: 'X/Twitter API',
    description: 'Resolved via X API data (followers, tweets, engagement)'
  },
  dexscreener: {
    name: 'DexScreener',
    description: 'Resolved via DexScreener token price/market cap data'
  },
  'solana-rpc': {
    name: 'Solana RPC',
    description: 'Resolved via on-chain Solana data'
  },
  colosseum: {
    name: 'Colosseum Hackathon',
    description: 'Resolved via official Colosseum announcements'
  },
  moltbook: {
    name: 'Moltbook',
    description: 'Resolved via Moltbook platform data (agents, submolts, karma)'
  },
  reddit: {
    name: 'Reddit API',
    description: 'Resolved via Reddit karma/stats data'
  }
};

/**
 * Fetch X/Twitter follower count for a user
 * Note: Requires X API Bearer Token in production
 */
async function getXFollowerCount(username) {
  // In production, use X API v2
  // For MVP, return mock data or use scraping
  console.log(`[Oracle] Fetching X follower count for @${username}`);

  // Mock implementation - would use X API in production
  // const response = await axios.get(`https://api.twitter.com/2/users/by/username/${username}`, {
  //   headers: { 'Authorization': `Bearer ${process.env.X_BEARER_TOKEN}` },
  //   params: { 'user.fields': 'public_metrics' }
  // });
  // return response.data.data.public_metrics.followers_count;

  return {
    username,
    followerCount: null,
    error: 'X API integration pending - manual resolution required',
    timestamp: new Date().toISOString()
  };
}

/**
 * Fetch token data from DexScreener
 */
async function getDexScreenerData(tokenAddress) {
  try {
    console.log(`[Oracle] Fetching DexScreener data for ${tokenAddress}`);

    const response = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, {
      timeout: 10000
    });

    if (response.data && response.data.pairs && response.data.pairs.length > 0) {
      const pair = response.data.pairs[0];
      return {
        tokenAddress,
        name: pair.baseToken.name,
        symbol: pair.baseToken.symbol,
        priceUsd: parseFloat(pair.priceUsd),
        marketCap: parseFloat(pair.fdv || pair.marketCap || 0),
        volume24h: parseFloat(pair.volume?.h24 || 0),
        priceChange24h: parseFloat(pair.priceChange?.h24 || 0),
        liquidity: parseFloat(pair.liquidity?.usd || 0),
        chain: pair.chainId,
        dexId: pair.dexId,
        url: pair.url,
        timestamp: new Date().toISOString()
      };
    }

    return {
      tokenAddress,
      error: 'Token not found on DexScreener',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      tokenAddress,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Fetch Solana account data
 */
async function getSolanaAccountData(address, rpcUrl = 'https://api.devnet.solana.com') {
  try {
    console.log(`[Oracle] Fetching Solana account data for ${address}`);

    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'jsonParsed' }]
    }, {
      timeout: 10000
    });

    if (response.data.result && response.data.result.value) {
      const account = response.data.result.value;
      return {
        address,
        exists: true,
        lamports: account.lamports,
        solBalance: account.lamports / 1e9,
        owner: account.owner,
        executable: account.executable,
        timestamp: new Date().toISOString()
      };
    }

    return {
      address,
      exists: false,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      address,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Fetch Moltbook user/agent data
 * @param {string} username - Moltbook username (e.g., 'crabkarmabot')
 */
async function getMoltbookUserData(username) {
  try {
    console.log(`[Oracle] Fetching Moltbook data for ${username}`);

    // Moltbook public profile page
    const profileUrl = `https://www.moltbook.com/u/${username}`;

    // Try to fetch the page and extract data
    // Note: In production, we'd use Moltbook's API if available
    const response = await axios.get(profileUrl, {
      timeout: 10000,
      headers: {
        'User-Agent': 'AgentBets/1.0 (Oracle Service)'
      }
    });

    // Parse karma and stats from the page
    // This is a basic implementation - would need to be updated based on actual page structure
    const html = response.data;

    // Look for karma value in the page
    const karmaMatch = html.match(/karma['":\s]+(\d+)/i) ||
                       html.match(/(\d+)\s*karma/i);

    return {
      username,
      profileUrl,
      karma: karmaMatch ? parseInt(karmaMatch[1]) : null,
      dataAvailable: !!karmaMatch,
      note: karmaMatch ? 'Karma data extracted' : 'Could not extract karma - manual verification required',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      username,
      profileUrl: `https://www.moltbook.com/u/${username}`,
      error: error.message,
      dataAvailable: false,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Fetch Moltbook platform stats
 */
async function getMoltbookStats() {
  try {
    console.log(`[Oracle] Fetching Moltbook platform stats`);

    const response = await axios.get('https://www.moltbook.com/', {
      timeout: 10000,
      headers: {
        'User-Agent': 'AgentBets/1.0 (Oracle Service)'
      }
    });

    const html = response.data;

    // Try to extract agent count and submolt count
    const agentMatch = html.match(/(\d+(?:,\d+)?(?:\.\d+)?[mk]?)\s*agents?/i);
    const submoltMatch = html.match(/(\d+(?:,\d+)?)\s*submolts?/i);

    return {
      platform: 'Moltbook',
      url: 'https://www.moltbook.com/',
      agentCount: agentMatch ? agentMatch[1] : null,
      submoltCount: submoltMatch ? submoltMatch[1] : null,
      dataAvailable: !!(agentMatch || submoltMatch),
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      platform: 'Moltbook',
      error: error.message,
      dataAvailable: false,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Get Solana transaction count for an address
 */
async function getSolanaTransactionCount(address, rpcUrl = 'https://api.devnet.solana.com') {
  try {
    console.log(`[Oracle] Fetching transaction count for ${address}`);

    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [address, { limit: 1000 }]
    }, {
      timeout: 15000
    });

    if (response.data.result) {
      return {
        address,
        transactionCount: response.data.result.length,
        recentSignatures: response.data.result.slice(0, 5).map(s => s.signature),
        timestamp: new Date().toISOString()
      };
    }

    return {
      address,
      transactionCount: 0,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    return {
      address,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Evaluate a market condition based on oracle data
 */
async function evaluateMarketCondition(market) {
  const { resolutionSource, question, id } = market;

  console.log(`[Oracle] Evaluating market: ${id}`);
  console.log(`[Oracle] Question: ${question}`);
  console.log(`[Oracle] Resolution source: ${resolutionSource}`);

  const result = {
    marketId: id,
    question,
    resolutionSource,
    evaluatedAt: new Date().toISOString(),
    canAutoResolve: false,
    suggestedResolution: null,
    oracleData: null,
    reason: null
  };

  switch (resolutionSource) {
    case 'dexscreener':
      // Extract token address from question or metadata
      // For MVP, check if question mentions market cap targets
      if (question.toLowerCase().includes('$100k market cap') ||
          question.toLowerCase().includes('mcap')) {
        result.reason = 'Token market cap condition detected - requires token address for verification';
        result.canAutoResolve = false;
      }
      break;

    case 'x-api':
      // Extract usernames from question
      const usernameMatch = question.match(/@(\w+)/g);
      if (usernameMatch) {
        result.oracleData = {
          detectedUsernames: usernameMatch.map(u => u.replace('@', '')),
          note: 'X API integration pending - manual resolution required'
        };
      }
      break;

    case 'solana-rpc':
      // For on-chain verifiable conditions
      result.reason = 'Solana RPC oracle - can verify on-chain activity';
      break;

    case 'colosseum':
      result.reason = 'Requires official Colosseum hackathon announcement';
      result.canAutoResolve = false;
      break;

    case 'manual':
    default:
      result.reason = 'Manual resolution required by market creator or admin';
      result.canAutoResolve = false;
      break;
  }

  return result;
}

/**
 * Check if a market should be resolved based on end date
 */
function isMarketExpired(market) {
  return new Date(market.endDate) < new Date();
}

/**
 * Get oracle info for display
 */
function getOracleInfo(source) {
  return ORACLE_TYPES[source] || {
    name: 'Custom',
    description: 'Custom resolution source'
  };
}

/**
 * Validate resolution data before committing
 */
function validateResolution(resolution, market) {
  if (!['YES', 'NO'].includes(resolution)) {
    return { valid: false, error: 'Resolution must be YES or NO' };
  }

  if (market.status !== 'active') {
    return { valid: false, error: 'Market is not active' };
  }

  return { valid: true };
}

module.exports = {
  ORACLE_TYPES,
  getXFollowerCount,
  getDexScreenerData,
  getSolanaAccountData,
  getSolanaTransactionCount,
  getMoltbookUserData,
  getMoltbookStats,
  evaluateMarketCondition,
  isMarketExpired,
  getOracleInfo,
  validateResolution
};
