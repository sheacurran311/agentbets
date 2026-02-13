/**
 * Auto-Resolution Engine
 *
 * Automatically resolves markets using API data
 * Supports multiple data sources:
 * - DexScreener (token prices, mcap)
 * - Pyth Network (on-chain price oracles)
 * - X API (followers, engagement)
 * - Moltbook (karma, agent stats)
 * - GitHub (commits, releases)
 * - Solana (balances, transactions)
 * - CoinGecko (backup price data)
 */

const axios = require('axios');

// CoinGecko API key from environment (Demo/Free tier)
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

// Extended token symbol to CoinGecko ID mapping
const COINGECKO_TOKEN_MAP = {
  'sol': 'solana',
  'solana': 'solana',
  'btc': 'bitcoin',
  'bitcoin': 'bitcoin',
  'eth': 'ethereum',
  'ethereum': 'ethereum',
  'usdc': 'usd-coin',
  'usdt': 'tether',
  'bonk': 'bonk',
  'jup': 'jupiter-exchange-solana',
  'jupiter': 'jupiter-exchange-solana',
  'wif': 'dogwifcoin',
  'dogwifhat': 'dogwifcoin',
  'jto': 'jito-governance-token',
  'jito': 'jito-governance-token',
  'pyth': 'pyth-network',
  'render': 'render-token',
  'rndr': 'render-token',
  'ray': 'raydium',
  'raydium': 'raydium',
  'orca': 'orca',
  'marinade': 'marinade-staked-sol',
  'msol': 'marinade-staked-sol',
  'fida': 'bonfida',
  'bonfida': 'bonfida',
  'step': 'step-finance',
  'atlas': 'star-atlas',
  'polis': 'star-atlas-dao',
  'samo': 'samoyedcoin',
  'grape': 'grape-2',
  'mango': 'mango-markets',
  'srm': 'serum',
  'serum': 'serum',
  'hnt': 'helium',
  'helium': 'helium',
  'iot': 'helium-iot',
  'mobile': 'helium-mobile',
  'drift': 'drift-protocol',
  'wen': 'wen-4',
  'popcat': 'popcat',
  'myro': 'myro',
  'bome': 'book-of-meme',
  'slerf': 'slerf',
  'mew': 'cat-in-a-dogs-world',
  'aixbt': 'aixbt',
  'virtual': 'virtual-protocol',
  'ai16z': 'ai16z',
  'luna': 'luna-virtuals',
  'zerebro': 'zerebro',
  'goat': 'goatseus-maximus',
  'fartcoin': 'fartcoin',
  'act': 'act-i-the-ai-prophecy',
  'griffain': 'griffain',
  'arc': 'ai-rig-complex'
};

// Pyth price feed IDs for common tokens (Solana mainnet)
const PYTH_PRICE_FEEDS = {
  'SOL': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  'BTC': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  'ETH': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  'USDC': '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  'BONK': '0x72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  'JUP': '0x0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
  'WIF': '0x4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
};

class ResolutionEngine {
  constructor() {
    this.dexscreenerApi = 'https://api.dexscreener.com/latest';
    this.pythApi = 'https://hermes.pyth.network/api';
    this.coingeckoApi = 'https://api.coingecko.com/api/v3';
    this.moltbookApi = process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1';
    this.solanaRpc = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
  }

  /**
   * Resolve a market based on its resolution source
   * 
   * IMPORTANT: Token Price Resolution Strategy
   * - 'coingecko': Uses CoinGecko for official TOKEN prices (recommended)
   *   This is the single source of truth for token prices, avoiding the
   *   issue of multiple DEX pools having different prices.
   * 
   * - 'dexscreener': Only for SPECIFIC POOL prices when a pool URL is provided
   *   This should only be used when betting on a specific liquidity pool's price,
   *   not for general token prices. Falls back to CoinGecko if no pool specified.
   */
  async resolve(data) {
    const { resolution, question, threshold, targetHandle, targetToken, verificationUrl } = data;

    // Check if targetToken looks like a contract address
    const isContractAddress = this.isSolanaAddress(targetToken);
    
    try {
      switch (resolution) {
        case 'coingecko':
          // If targetToken is a contract address, use DexScreener for lookup
          if (isContractAddress) {
            console.log(`[Resolver] Detected contract address, using DexScreener for lookup`);
            return await this.resolveByContractAddress(targetToken, threshold, question);
          }
          // Use CoinGecko for official TOKEN prices (single source of truth)
          console.log(`[Resolver] Using CoinGecko for token price verification`);
          return await this.resolveCoingecko(targetToken, threshold, question);

        case 'coingecko-onchain':
        case 'geckoterminal':
        case 'onchain':
        case 'contract':
          // Use DexScreener for contract address lookups (more reliable, no API key required)
          console.log(`[Resolver] Using DexScreener for contract address lookup`);
          return await this.resolveByContractAddress(targetToken, threshold, question);

        case 'dexscreener':
          // DexScreener should only be used for specific POOL prices
          // If a specific pool URL is provided, use DexScreener
          // Otherwise, use CoinGecko for the token price
          if (verificationUrl && verificationUrl.includes('dexscreener.com') && verificationUrl.includes('/')) {
            console.log(`[Resolver] Using DexScreener for specific pool: ${verificationUrl}`);
            return await this.resolveDexScreener(targetToken, threshold, question);
          }
          // No specific pool URL - use CoinGecko for token price
          console.log(`[Resolver] No specific pool URL, using CoinGecko for token price`);
          const cgResult = await this.resolveCoingecko(targetToken, threshold, question);
          if (cgResult.resolved) {
            return cgResult;
          }
          // Fallback to DexScreener only if CoinGecko fails
          console.log(`[Resolver] CoinGecko failed, falling back to DexScreener: ${cgResult.error}`);
          return await this.resolveDexScreener(targetToken, threshold, question);

        case 'pyth':
        case 'oracle':
          return await this.resolvePyth(targetToken, threshold, question);

        case 'x-api':
          return await this.resolveXApi(targetHandle, threshold, question);

        case 'moltbook':
          return await this.resolveMoltbook(targetHandle, threshold, question);

        case 'moltx':
          return await this.resolveMoltx(targetHandle, threshold, question);

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
   * Resolve using Pyth Network on-chain oracle
   * More reliable and manipulation-resistant than DEX APIs
   */
  async resolvePyth(token, threshold, question) {
    if (!token) {
      const match = question.match(/\$([A-Z]+)/);
      if (match) {
        token = match[1].toUpperCase();
      } else {
        return { resolved: false, error: 'No token specified' };
      }
    }

    token = token.toUpperCase();
    const priceFeedId = PYTH_PRICE_FEEDS[token];

    if (!priceFeedId) {
      // Fallback to DexScreener if Pyth doesn't have this token
      console.log(`[Resolver] Pyth doesn't have ${token}, falling back to DexScreener`);
      return await this.resolveDexScreener(token, threshold, question);
    }

    try {
      const response = await axios.get(
        `${this.pythApi}/latest_price_feeds`,
        {
          params: { ids: [priceFeedId] },
          timeout: 10000
        }
      );

      const priceData = response.data?.[0];
      if (!priceData || !priceData.price) {
        return { resolved: false, error: `No Pyth price data for ${token}` };
      }

      // Pyth returns price with exponent
      const price = parseFloat(priceData.price.price) * Math.pow(10, priceData.price.expo);
      const confidence = parseFloat(priceData.price.conf) * Math.pow(10, priceData.price.expo);

      const thresholdNum = this.parseThreshold(threshold);
      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const outcome = price >= thresholdNum ? 'YES' : 'NO';

      return {
        resolved: true,
        outcome,
        actualValue: `$${price.toFixed(price < 1 ? 6 : 2)} (±${confidence.toFixed(2)})`,
        threshold: `$${this.formatNumber(thresholdNum)}`,
        source: 'Pyth Oracle',
        data: {
          token,
          price,
          confidence,
          publishTime: priceData.price.publish_time
        }
      };
    } catch (error) {
      console.log(`[Resolver] Pyth error, falling back to DexScreener: ${error.message}`);
      return await this.resolveDexScreener(token, threshold, question);
    }
  }

  /**
   * Resolve using CoinGecko API (PRIMARY source for token verification)
   * Uses authenticated API with demo key for reliable access
   */
  async resolveCoingecko(token, threshold, question) {
    if (!token) {
      const match = question.match(/\$([A-Za-z0-9]+)/i);
      if (match) {
        token = match[1].toLowerCase();
      } else {
        return { resolved: false, error: 'No token specified' };
      }
    }

    // Use the extended token mapping
    const coinId = COINGECKO_TOKEN_MAP[token.toLowerCase()] || token.toLowerCase();
    console.log(`[Resolver] CoinGecko lookup: ${token} -> ${coinId}`);

    try {
      const response = await axios.get(
        `${this.coingeckoApi}/simple/price`,
        {
          params: {
            ids: coinId,
            vs_currencies: 'usd',
            include_market_cap: true,
            include_24hr_change: true,
            x_cg_demo_api_key: COINGECKO_API_KEY
          },
          timeout: 10000
        }
      );

      const data = response.data?.[coinId];
      if (!data) {
        return { resolved: false, error: `Token ${token} not found on CoinGecko` };
      }

      const price = data.usd;
      const mcap = data.usd_market_cap;

      const thresholdNum = this.parseThreshold(threshold);
      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const isMcapQuestion = /mcap|market cap/i.test(question);
      const actualValue = isMcapQuestion ? mcap : price;
      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] CoinGecko result: ${token} ${isMcapQuestion ? 'mcap' : 'price'} = $${isMcapQuestion ? this.formatNumber(mcap) : price.toFixed(price < 1 ? 6 : 2)}, threshold = $${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: isMcapQuestion
          ? `$${this.formatNumber(mcap)} mcap`
          : `$${price.toFixed(price < 1 ? 6 : 2)}`,
        threshold: `$${this.formatNumber(thresholdNum)}`,
        source: 'CoinGecko',
        verificationUrl: `https://www.coingecko.com/en/coins/${coinId}`,
        data: {
          token,
          coinId,
          price,
          mcap,
          change24h: data.usd_24h_change,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error(`[Resolver] CoinGecko error for ${token}:`, error.message);
      return { resolved: false, error: `CoinGecko API error: ${error.message}` };
    }
  }

  /**
   * Resolve using DexScreener API for contract address lookups
   * This is the primary method for new/low-cap tokens by contract address
   * DexScreener has comprehensive coverage of Solana DEX pools
   * 
   * @param {string} contractAddress - Token contract address (e.g., Solana mint address)
   * @param {number|string} threshold - Price or mcap threshold
   * @param {string} question - Market question for context
   */
  async resolveByContractAddress(contractAddress, threshold, question) {
    if (!contractAddress) {
      return { resolved: false, error: 'No contract address specified' };
    }

    // Clean up the address (remove any whitespace)
    const cleanAddress = contractAddress.trim();
    
    console.log(`[Resolver] DexScreener lookup by contract: ${cleanAddress}`);

    try {
      // DexScreener has a direct token lookup endpoint
      const response = await axios.get(
        `${this.dexscreenerApi}/dex/tokens/${cleanAddress}`,
        { timeout: 15000 }
      );

      const pairs = response.data?.pairs;
      
      if (!pairs || pairs.length === 0) {
        return { resolved: false, error: `Token ${cleanAddress} not found on DexScreener. Ensure it has active liquidity pools.` };
      }

      // Filter for Solana pairs and sort by liquidity
      const solanaPairs = pairs
        .filter(p => p.chainId === 'solana')
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      
      // Use most liquid Solana pair, or fall back to most liquid any-chain pair
      const pair = solanaPairs[0] || pairs[0];
      
      const price = parseFloat(pair.priceUsd) || 0;
      const mcap = pair.marketCap || pair.fdv || 0;
      const volume24h = pair.volume?.h24 || 0;
      const change24h = pair.priceChange?.h24 || 0;

      const thresholdNum = this.parseThreshold(threshold);
      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const isMcapQuestion = /mcap|market cap|fdv/i.test(question);
      const actualValue = isMcapQuestion ? mcap : price;
      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] DexScreener contract result: ${pair.baseToken?.symbol || cleanAddress} ${isMcapQuestion ? 'mcap' : 'price'} = $${isMcapQuestion ? this.formatNumber(mcap) : price.toFixed(price < 1 ? 8 : 4)}, threshold = $${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: isMcapQuestion
          ? `$${this.formatNumber(mcap)} mcap`
          : `$${price.toFixed(price < 1 ? 8 : 4)}`,
        threshold: `$${this.formatNumber(thresholdNum)}`,
        source: 'DexScreener',
        verificationUrl: pair.url || `https://dexscreener.com/solana/${cleanAddress}`,
        data: {
          contractAddress: cleanAddress,
          symbol: pair.baseToken?.symbol,
          name: pair.baseToken?.name,
          chain: pair.chainId,
          dex: pair.dexId,
          pairAddress: pair.pairAddress,
          price,
          mcap,
          fdv: pair.fdv,
          volume24h,
          change24h,
          liquidity: pair.liquidity?.usd,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error(`[Resolver] DexScreener contract lookup error for ${contractAddress}:`, error.message);
      return { resolved: false, error: `DexScreener API error: ${error.message}` };
    }
  }

  /**
   * Resolve using CoinGecko Onchain/DEX API (for tokens by contract address)
   * Note: This may require a paid CoinGecko API plan
   * Falls back to DexScreener if unavailable
   * 
   * @param {string} contractAddress - Token contract address (e.g., Solana mint address)
   * @param {string} network - Network ID (default: 'solana')
   * @param {number|string} threshold - Price or mcap threshold
   * @param {string} question - Market question for context
   */
  async resolveCoingeckoOnchain(contractAddress, network = 'solana', threshold, question) {
    if (!contractAddress) {
      return { resolved: false, error: 'No contract address specified' };
    }

    // Clean up the address (remove any whitespace)
    const cleanAddress = contractAddress.trim();
    
    console.log(`[Resolver] CoinGecko Onchain lookup: ${cleanAddress} on ${network}`);

    try {
      const response = await axios.get(
        `${this.coingeckoApi}/onchain/simple/networks/${network}/token_price/${cleanAddress}`,
        {
          params: {
            include_market_cap: true,
            mcap_fdv_fallback: true,  // Use FDV if mcap unavailable (common for new tokens)
            include_24hr_vol: true,
            include_24hr_price_change: true,
            include_inactive_source: true,  // Include recently active pools
            ...(COINGECKO_API_KEY ? { x_cg_demo_api_key: COINGECKO_API_KEY } : {})
          },
          timeout: 15000
        }
      );

      const data = response.data?.data?.attributes;
      if (!data || !data.token_prices) {
        // Fall back to DexScreener
        console.log(`[Resolver] CoinGecko Onchain returned no data, falling back to DexScreener`);
        return await this.resolveByContractAddress(cleanAddress, threshold, question);
      }

      // Get price data (addresses are lowercase in response)
      const addressKey = cleanAddress.toLowerCase();
      const priceStr = data.token_prices?.[addressKey];
      
      if (!priceStr) {
        // Fall back to DexScreener
        console.log(`[Resolver] No price in CoinGecko response, falling back to DexScreener`);
        return await this.resolveByContractAddress(cleanAddress, threshold, question);
      }

      const price = parseFloat(priceStr);
      const mcapStr = data.market_cap_usd?.[addressKey];
      const mcap = mcapStr ? parseFloat(mcapStr) : null;
      const vol24h = data.h24_volume_usd?.[addressKey] ? parseFloat(data.h24_volume_usd[addressKey]) : null;
      const change24h = data.h24_price_change_percentage?.[addressKey] ? parseFloat(data.h24_price_change_percentage[addressKey]) : null;

      const thresholdNum = this.parseThreshold(threshold);
      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const isMcapQuestion = /mcap|market cap|fdv/i.test(question);
      const actualValue = isMcapQuestion ? (mcap || 0) : price;
      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] CoinGecko Onchain result: ${cleanAddress} ${isMcapQuestion ? 'mcap' : 'price'} = $${isMcapQuestion ? this.formatNumber(mcap) : price.toFixed(price < 1 ? 8 : 4)}, threshold = $${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: isMcapQuestion
          ? `$${this.formatNumber(mcap || 0)} mcap`
          : `$${price.toFixed(price < 1 ? 8 : 4)}`,
        threshold: `$${this.formatNumber(thresholdNum)}`,
        source: 'CoinGecko Onchain (GeckoTerminal)',
        verificationUrl: `https://www.geckoterminal.com/${network}/tokens/${cleanAddress}`,
        data: {
          contractAddress: cleanAddress,
          network,
          price,
          mcap,
          volume24h: vol24h,
          change24h,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error(`[Resolver] CoinGecko Onchain error for ${contractAddress}:`, error.message);
      
      // Fall back to DexScreener for any error (including 401/403 for API access)
      console.log(`[Resolver] Falling back to DexScreener due to CoinGecko error`);
      return await this.resolveByContractAddress(contractAddress, threshold, question);
    }
  }

  /**
   * Check if a string looks like a Solana address (base58, 32-44 chars)
   */
  isSolanaAddress(str) {
    if (!str || typeof str !== 'string') return false;
    // Solana addresses are base58 encoded, typically 32-44 characters
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(str.trim());
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
   * Supports both:
   * - Per-agent metrics (karma, followers) via Moltbook API when handle is present
   * - Platform-level agent count via scraping https://www.moltbook.com/ when question is about total agents
   */
  async resolveMoltbook(handle, threshold, question) {
    // Try to extract handle from question if not provided
    if (!handle) {
      const match = question.match(/@(\w+)/);
      if (match) {
        handle = match[1];
      }
    }

    // @moltbook is the platform itself, not an individual agent
    const isMoltbookPlatformHandle = /^moltbook$/i.test(handle);

    // Platform-level: handle is @moltbook (or no handle) and question is about total agents
    // e.g. "Will @moltbook have over 2.5M registered agents by end of February?"
    // Simple check: question mentions both a number and "agents"
    const hasNumber = /\d+(?:\.\d+)?\s*[mk]?/i.test(question);
    const hasAgents = /agents?/i.test(question);
    const isPlatformAgentQuestion = (!handle || isMoltbookPlatformHandle) && hasNumber && hasAgents;
    if (isPlatformAgentQuestion) {
      console.log(`[Resolver] Moltbook platform-level question detected (handle=${handle || 'none'})`);
      return await this.resolveMoltbookPlatformStats(threshold, question);
    }

    if (!handle) {
      return { resolved: false, error: 'No Moltbook handle specified' };
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
   * Resolve platform-level Moltbook agent count (e.g. "Will Moltbook reach 2.5M agents?")
   * Uses the Moltbook public stats API: https://www.moltbook.com/api/v1/stats
   */
  async resolveMoltbookPlatformStats(threshold, question) {
    try {
      console.log(`[Resolver] Fetching Moltbook platform stats from API`);
      console.log(`[Resolver] Threshold from market: "${threshold}", question: "${question}"`);

      const response = await axios.get('https://www.moltbook.com/api/v1/stats', {
        timeout: 10000,
        headers: { 'User-Agent': 'AgentBets/1.0 (Resolution Service)' }
      });

      const stats = response.data;

      if (!stats.success || typeof stats.agents !== 'number') {
        console.log(`[Resolver] Unexpected stats response:`, JSON.stringify(stats).slice(0, 500));
        return { resolved: false, error: 'Moltbook stats API returned unexpected format' };
      }

      const actualValue = stats.agents;
      console.log(`[Resolver] Moltbook stats API: ${this.formatNumber(actualValue)} agents (updated: ${stats.last_updated})`);
      
      // Try to parse threshold from provided value, or extract from question text as fallback
      let thresholdNum = this.parseThreshold(threshold);
      if (!thresholdNum && question) {
        const qMatch = question.match(/(\d+(?:\.\d+)?\s*(?:thousand|million|billion|mil|mm|[KkMmBb]))\s*(?:\w+)/i) ||
                       question.match(/(\d+(?:\.\d+)?\s*[KkMmBb])\s*agents?/i) ||
                       question.match(/(\d{1,3}(?:,\d{3})+)\s*agents?/i);
        if (qMatch) {
          thresholdNum = this.parseThreshold(qMatch[1]);
          console.log(`[Resolver] Extracted threshold from question: "${qMatch[1]}" -> ${thresholdNum}`);
        }
      }

      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] Moltbook platform: ${this.formatNumber(actualValue)} agents, threshold = ${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: `${this.formatNumber(actualValue)} agents`,
        threshold: this.formatNumber(thresholdNum),
        source: 'Moltbook (platform stats)',
        verificationUrl: 'https://www.moltbook.com/',
        data: {
          url: 'https://www.moltbook.com/api/v1/stats',
          agentCount: actualValue,
          submolts: stats.submolts,
          posts: stats.posts,
          comments: stats.comments,
          lastUpdated: stats.last_updated,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      return { resolved: false, error: `Moltbook platform stats error: ${error.message}` };
    }
  }

  /**
   * Resolve using MoltX data (agent-only X for AI agents)
   * Supports: followers, views, posts, likes, engagement rate
   * API: https://moltx.io/v1
   */
  async resolveMoltx(handle, threshold, question) {
    // Try to extract handle from question if not provided
    if (!handle) {
      const match = question.match(/@(\w+)/);
      if (match) {
        handle = match[1];
      }
    }

    // Check if this is a hashtag-based market
    const hashtagMatch = question.match(/#(\w+)/);
    if (hashtagMatch && /posts?|count/i.test(question)) {
      return await this.resolveMoltxHashtag(hashtagMatch[1], threshold, question);
    }

    // Check if this is a leaderboard rank market
    if (/top\s*\d+|rank/i.test(question) && handle) {
      return await this.resolveMoltxRank(handle, threshold, question);
    }

    if (!handle) {
      return { resolved: false, error: 'No MoltX agent handle specified' };
    }

    try {
      const response = await axios.get(
        `https://moltx.io/v1/agent/${encodeURIComponent(handle)}/stats`,
        { timeout: 10000, headers: { 'User-Agent': 'AgentBets/1.0 (Resolution Service)' } }
      );

      if (!response.data.success || !response.data.data) {
        return { resolved: false, error: `Agent @${handle} not found on MoltX` };
      }

      const stats = response.data.data;
      const current = stats.current || {};
      const recent7d = stats.recent_7d || {};

      // Determine what metric we're checking based on question
      let actualValue;
      let metricName;
      const lower = (question || '').toLowerCase();

      if (/views?|impressions?/i.test(lower)) {
        // Views require leaderboard lookup (not in agent stats)
        return await this.resolveMoltxViews(handle, threshold, question);
      } else if (/posts?|total_posts/i.test(lower)) {
        actualValue = current.total_posts || 0;
        metricName = 'posts';
      } else if (/likes?|total_likes/i.test(lower)) {
        actualValue = current.total_likes_received || 0;
        metricName = 'likes received';
      } else if (/engagement|engagement_rate/i.test(lower)) {
        actualValue = recent7d.avg_engagement_rate || 0;
        metricName = '7-day engagement rate';
      } else if (/following/i.test(lower)) {
        actualValue = current.following || 0;
        metricName = 'following';
      } else {
        // Default to followers
        actualValue = current.followers || 0;
        metricName = 'followers';
      }

      const thresholdNum = this.parseThreshold(threshold);
      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      // For engagement rate, handle as percentage
      const compareValue = metricName.includes('engagement') ? actualValue : actualValue;
      const outcome = compareValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] MoltX @${handle}: ${this.formatNumber(actualValue)} ${metricName}, threshold = ${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: metricName.includes('engagement') 
          ? `${actualValue.toFixed(2)}% ${metricName}`
          : `${this.formatNumber(actualValue)} ${metricName}`,
        threshold: this.formatNumber(thresholdNum),
        source: 'MoltX',
        verificationUrl: `https://moltx.io/${handle}`,
        data: {
          handle,
          ...current,
          recent7d,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      return { resolved: false, error: `MoltX API error: ${error.message}` };
    }
  }

  /**
   * Resolve MoltX views via leaderboard (views not in agent stats endpoint)
   */
  async resolveMoltxViews(handle, threshold, question) {
    try {
      const response = await axios.get(
        `https://moltx.io/v1/leaderboard?metric=views&limit=100`,
        { timeout: 10000, headers: { 'User-Agent': 'AgentBets/1.0 (Resolution Service)' } }
      );

      if (!response.data.success || !response.data.data?.leaders) {
        return { resolved: false, error: 'Could not fetch MoltX views leaderboard' };
      }

      const leaders = response.data.data.leaders;
      const agent = leaders.find(l => l.name.toLowerCase() === handle.toLowerCase());

      if (!agent) {
        return { resolved: false, error: `Agent @${handle} not found in MoltX views leaderboard (top 100)` };
      }

      const actualValue = agent.value;
      const thresholdNum = this.parseThreshold(threshold);

      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] MoltX @${handle} views: ${this.formatNumber(actualValue)}, threshold = ${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: `${this.formatNumber(actualValue)} views`,
        threshold: this.formatNumber(thresholdNum),
        source: 'MoltX (views leaderboard)',
        verificationUrl: `https://moltx.io/${handle}`,
        data: { handle, views: actualValue, rank: agent.rank, timestamp: new Date().toISOString() }
      };
    } catch (error) {
      return { resolved: false, error: `MoltX views lookup error: ${error.message}` };
    }
  }

  /**
   * Resolve MoltX leaderboard rank market
   * e.g., "Will @AlleyBot be top 3 on MoltX by followers?"
   */
  async resolveMoltxRank(handle, threshold, question) {
    try {
      // Determine metric from question
      const metric = /views?|impressions?/i.test(question) ? 'views' : 'followers';

      const response = await axios.get(
        `https://moltx.io/v1/leaderboard?metric=${metric}&limit=100`,
        { timeout: 10000, headers: { 'User-Agent': 'AgentBets/1.0 (Resolution Service)' } }
      );

      if (!response.data.success || !response.data.data?.leaders) {
        return { resolved: false, error: `Could not fetch MoltX ${metric} leaderboard` };
      }

      const leaders = response.data.data.leaders;
      const agent = leaders.find(l => l.name.toLowerCase() === handle.toLowerCase());

      if (!agent) {
        return { resolved: false, error: `Agent @${handle} not found in MoltX ${metric} leaderboard (top 100)` };
      }

      // Extract target rank from question or threshold
      const rankMatch = question.match(/top\s*(\d+)/i);
      const targetRank = rankMatch ? parseInt(rankMatch[1]) : this.parseThreshold(threshold);

      if (!targetRank) {
        return { resolved: false, error: 'Could not determine target rank' };
      }

      const outcome = agent.rank <= targetRank ? 'YES' : 'NO';

      console.log(`[Resolver] MoltX @${handle} rank: #${agent.rank} (${metric}), target top ${targetRank}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: `Rank #${agent.rank} by ${metric}`,
        threshold: `Top ${targetRank}`,
        source: `MoltX (${metric} leaderboard)`,
        verificationUrl: `https://moltx.io/leaderboard`,
        data: { handle, rank: agent.rank, value: agent.value, metric, timestamp: new Date().toISOString() }
      };
    } catch (error) {
      return { resolved: false, error: `MoltX rank lookup error: ${error.message}` };
    }
  }

  /**
   * Resolve MoltX hashtag post count market
   * e.g., "Will #agenteconomy reach 20,000 posts on MoltX?"
   */
  async resolveMoltxHashtag(hashtag, threshold, question) {
    try {
      const response = await axios.get(
        `https://moltx.io/v1/hashtags/trending?limit=50`,
        { timeout: 10000, headers: { 'User-Agent': 'AgentBets/1.0 (Resolution Service)' } }
      );

      if (!response.data.success || !response.data.data?.hashtags) {
        return { resolved: false, error: 'Could not fetch MoltX trending hashtags' };
      }

      const hashtags = response.data.data.hashtags;
      const tag = hashtags.find(h => h.name.toLowerCase() === hashtag.toLowerCase());

      if (!tag) {
        return { resolved: false, error: `Hashtag #${hashtag} not found in MoltX trending (top 50)` };
      }

      const actualValue = tag.post_count;
      const thresholdNum = this.parseThreshold(threshold);

      if (!thresholdNum) {
        return { resolved: false, error: 'Could not parse threshold' };
      }

      const outcome = actualValue >= thresholdNum ? 'YES' : 'NO';

      console.log(`[Resolver] MoltX #${hashtag}: ${this.formatNumber(actualValue)} posts, threshold = ${this.formatNumber(thresholdNum)}, outcome = ${outcome}`);

      return {
        resolved: true,
        outcome,
        actualValue: `${this.formatNumber(actualValue)} posts`,
        threshold: this.formatNumber(thresholdNum),
        source: 'MoltX (trending hashtags)',
        verificationUrl: `https://moltx.io/hashtag/${hashtag}`,
        data: { hashtag, postCount: actualValue, lastUsedAt: tag.last_used_at, timestamp: new Date().toISOString() }
      };
    } catch (error) {
      return { resolved: false, error: `MoltX hashtag lookup error: ${error.message}` };
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
   * Supports: wallet balances, token holdings, transaction counts
   */
  async resolveSolana(data) {
    const { question, threshold } = data;

    // Extract wallet address from question
    const walletMatch = question.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (!walletMatch) {
      return { resolved: false, error: 'No Solana wallet address found in question' };
    }

    const walletAddress = walletMatch[1];

    try {
      // Determine what we're checking
      const isBalanceQuestion = /balance|hold|has|sol\b/i.test(question);
      const isTokenQuestion = /token|usdc|bonk/i.test(question);

      if (isBalanceQuestion && !isTokenQuestion) {
        // Check SOL balance
        const response = await axios.post(this.solanaRpc, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [walletAddress]
        }, { timeout: 10000 });

        const lamports = response.data?.result?.value || 0;
        const solBalance = lamports / 1e9; // Convert lamports to SOL

        const thresholdNum = this.parseThreshold(threshold);
        if (!thresholdNum) {
          return { resolved: false, error: 'Could not parse threshold' };
        }

        const outcome = solBalance >= thresholdNum ? 'YES' : 'NO';

        return {
          resolved: true,
          outcome,
          actualValue: `${solBalance.toFixed(4)} SOL`,
          threshold: `${thresholdNum} SOL`,
          source: 'Solana RPC',
          data: {
            wallet: walletAddress,
            balanceLamports: lamports,
            balanceSOL: solBalance
          }
        };
      }

      if (isTokenQuestion) {
        // Check token accounts
        const response = await axios.post(this.solanaRpc, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            walletAddress,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' }
          ]
        }, { timeout: 10000 });

        const accounts = response.data?.result?.value || [];
        const totalTokens = accounts.length;

        // For USDC specifically
        const usdcMint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // Devnet
        const usdcAccount = accounts.find(a =>
          a.account?.data?.parsed?.info?.mint === usdcMint
        );
        const usdcBalance = usdcAccount?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;

        const thresholdNum = this.parseThreshold(threshold);

        if (/usdc/i.test(question) && thresholdNum) {
          const outcome = usdcBalance >= thresholdNum ? 'YES' : 'NO';
          return {
            resolved: true,
            outcome,
            actualValue: `${usdcBalance.toFixed(2)} USDC`,
            threshold: `${thresholdNum} USDC`,
            source: 'Solana RPC',
            data: { wallet: walletAddress, usdcBalance }
          };
        }

        // Generic token count
        return {
          resolved: true,
          outcome: totalTokens > 0 ? 'YES' : 'NO',
          actualValue: `${totalTokens} token accounts`,
          source: 'Solana RPC',
          data: { wallet: walletAddress, tokenAccounts: totalTokens }
        };
      }

      return { resolved: false, error: 'Could not determine what to check on Solana' };

    } catch (error) {
      return { resolved: false, error: `Solana RPC error: ${error.message}` };
    }
  }

  /**
   * Parse threshold string into number
   */
  parseThreshold(threshold) {
    if (!threshold) return null;

    let str = String(threshold).toLowerCase().trim();

    // Remove $ and commas
    str = str.replace(/[$,]/g, '');

    // Handle word suffixes (million, thousand, billion) BEFORE single-letter suffixes
    let multiplier = 1;
    if (/million|mil\b|mm\b/i.test(str)) {
      multiplier = 1000000;
      str = str.replace(/million|mil\b|mm\b/gi, '').trim();
    } else if (/billion|bil\b/i.test(str)) {
      multiplier = 1000000000;
      str = str.replace(/billion|bil\b/gi, '').trim();
    } else if (/thousand/i.test(str)) {
      multiplier = 1000;
      str = str.replace(/thousand/gi, '').trim();
    } else if (str.endsWith('k')) {
      multiplier = 1000;
      str = str.slice(0, -1);
    } else if (str.endsWith('m')) {
      multiplier = 1000000;
      str = str.slice(0, -1);
    } else if (str.endsWith('b')) {
      multiplier = 1000000000;
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
