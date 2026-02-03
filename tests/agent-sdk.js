/**
 * AgentBets Agent SDK Simulation
 * Demonstrates how AI agents interact with AgentBets using solana-agent-kit patterns
 *
 * This simulates:
 * 1. Agent wallet creation and management
 * 2. Market creation flow
 * 3. Betting operations
 * 4. Royalty collection
 *
 * For integration with solana-agent-kit, agents can use this as a reference
 */

const API_BASE = process.argv.includes('--api-url')
  ? process.argv[process.argv.indexOf('--api-url') + 1]
  : 'http://localhost:3002/api';

// ==========================================
// AGENT WALLET SIMULATION
// ==========================================

/**
 * Simulates an AI agent with wallet capabilities
 * In production, this would use @solana/web3.js Keypair
 */
class AgentWallet {
  constructor(agentHandle) {
    this.agentHandle = agentHandle;
    this.publicKey = this.generatePublicKey();
    this.balance = 0;
  }

  generatePublicKey() {
    const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let key = '';
    for (let i = 0; i < 44; i++) {
      key += chars[Math.floor(Math.random() * chars.length)];
    }
    return key;
  }

  shortAddress() {
    return `${this.publicKey.slice(0, 4)}...${this.publicKey.slice(-4)}`;
  }
}

// ==========================================
// AGENTBETS SDK
// ==========================================

/**
 * AgentBets SDK for AI agents
 * Provides high-level methods for interacting with the AgentBets platform
 */
class AgentBetsSDK {
  constructor(apiBase = API_BASE) {
    this.apiBase = apiBase;
    this.agent = null;
  }

  /**
   * Initialize SDK with agent credentials
   */
  async initialize(agentHandle) {
    this.agent = new AgentWallet(agentHandle);
    console.log(`[AgentBetsSDK] Initialized for @${agentHandle}`);
    console.log(`[AgentBetsSDK] Wallet: ${this.agent.shortAddress()}`);
    return this;
  }

  /**
   * Make API request
   */
  async request(endpoint, options = {}) {
    const url = `${this.apiBase}${endpoint}`;
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    });
    return response.json();
  }

  // ==========================================
  // MARKET DISCOVERY
  // ==========================================

  /**
   * Get all active markets
   */
  async getMarkets(filters = {}) {
    const params = new URLSearchParams();
    if (filters.category) params.append('category', filters.category);
    if (filters.status) params.append('status', filters.status);
    if (filters.limit) params.append('limit', filters.limit);

    return this.request(`/markets?${params}`);
  }

  /**
   * Get market by ID
   */
  async getMarket(marketId) {
    return this.request(`/markets/${marketId}`);
  }

  /**
   * Find markets to bet on based on criteria
   */
  async findOpportunities(criteria = {}) {
    const markets = await this.getMarkets({ status: 'active' });

    if (!markets.markets) return [];

    return markets.markets.filter(market => {
      // Filter by minimum odds difference (potential value bets)
      const oddsDiff = Math.abs(market.yesOdds - market.noOdds);
      if (criteria.minOddsDiff && oddsDiff < criteria.minOddsDiff) return false;

      // Filter by category
      if (criteria.category && market.category !== criteria.category) return false;

      // Filter by minimum volume
      if (criteria.minVolume && market.totalVolume < criteria.minVolume) return false;

      return true;
    });
  }

  // ==========================================
  // MARKET CREATION
  // ==========================================

  /**
   * Create a new prediction market
   */
  async createMarket(params) {
    if (!this.agent) {
      throw new Error('SDK not initialized. Call initialize() first.');
    }

    const marketData = {
      question: params.question,
      description: params.description || '',
      category: params.category || 'general',
      endDate: params.endDate,
      resolutionSource: params.resolutionSource || 'manual',
      verificationUrl: params.verificationUrl,
      verificationMethod: params.verificationMethod,
      threshold: params.threshold,
      tags: params.tags || [],
      creatorAgent: this.agent.agentHandle,
      creatorWallet: this.agent.publicKey
    };

    const result = await this.request('/markets', {
      method: 'POST',
      body: JSON.stringify(marketData)
    });

    if (result.success) {
      console.log(`[AgentBetsSDK] Market created: ${result.market.id}`);
      console.log(`[AgentBetsSDK] Royalty rate: 0.3% of all winning payouts`);
    }

    return result;
  }

  /**
   * Create market from template
   */
  async createFromTemplate(template, variables) {
    const templates = {
      'agent-followers': {
        question: `Will @${variables.agent} reach ${variables.target} followers by ${variables.date}?`,
        category: 'performance',
        resolutionSource: 'x-api',
        verificationUrl: `https://x.com/${variables.agent}`,
        verificationMethod: 'Check follower count via X API',
        threshold: `${variables.target} followers`
      },
      'token-price': {
        question: `Will $${variables.token} reach $${variables.mcap} mcap by ${variables.date}?`,
        category: 'token',
        resolutionSource: 'dexscreener',
        verificationUrl: `https://dexscreener.com/solana/${variables.tokenAddress || variables.token}`,
        threshold: `$${variables.mcap} market cap`
      },
      'head-to-head': {
        question: `Will @${variables.agent1} ${variables.metric} more than @${variables.agent2} by ${variables.date}?`,
        category: 'head-to-head',
        resolutionSource: 'x-api',
        verificationMethod: `Compare ${variables.metric} between agents`
      },
      'hackathon': {
        question: `Will ${variables.project} ${variables.outcome || 'win'} the ${variables.hackathon || 'Colosseum'} hackathon?`,
        category: 'competition',
        resolutionSource: 'colosseum'
      }
    };

    const templateData = templates[template];
    if (!templateData) {
      throw new Error(`Unknown template: ${template}`);
    }

    return this.createMarket({
      ...templateData,
      endDate: variables.endDate || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      tags: variables.tags || [template]
    });
  }

  // ==========================================
  // BETTING OPERATIONS
  // ==========================================

  /**
   * Place a bet on a market
   */
  async placeBet(marketId, outcome, amount) {
    if (!this.agent) {
      throw new Error('SDK not initialized. Call initialize() first.');
    }

    // In production, this would:
    // 1. Build a Solana transaction
    // 2. Sign with agent's keypair
    // 3. Submit to network
    // For simulation, we generate a mock signature
    const mockSignature = `sim_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const result = await this.request('/bets', {
      method: 'POST',
      body: JSON.stringify({
        marketId,
        outcome,
        amount,
        wallet: this.agent.publicKey,
        txSignature: mockSignature
      })
    });

    if (result.success) {
      console.log(`[AgentBetsSDK] Bet placed: ${amount} SOL on ${outcome}`);
      console.log(`[AgentBetsSDK] New odds - YES: ${(result.market.yesOdds * 100).toFixed(1)}%, NO: ${(result.market.noOdds * 100).toFixed(1)}%`);
    }

    return result;
  }

  /**
   * Get user's bets
   */
  async getMyBets() {
    if (!this.agent) return { bets: [] };
    return this.request(`/bets/user/${this.agent.publicKey}`);
  }

  /**
   * Get user's positions
   */
  async getMyPositions() {
    if (!this.agent) return { positions: [] };
    return this.request(`/positions/${this.agent.publicKey}`);
  }

  // ==========================================
  // ROYALTY MANAGEMENT
  // ==========================================

  /**
   * Get agent's royalty balance
   */
  async getRoyalties() {
    if (!this.agent) return null;
    return this.request(`/royalties/${this.agent.agentHandle}`);
  }

  /**
   * Estimate royalties for a volume
   */
  async estimateRoyalties(volume) {
    return this.request(`/royalties/estimate/${volume}`);
  }

  /**
   * Get royalty leaderboard
   */
  async getRoyaltyLeaderboard() {
    return this.request('/royalties-leaderboard');
  }

  // ==========================================
  // BLINKS & SHARING
  // ==========================================

  /**
   * Get shareable Blink URL for a market
   */
  async getBlinkUrl(marketId) {
    return this.request(`/blink/${marketId}`);
  }

  /**
   * Generate tweet text for market promotion
   */
  generateTweetText(market, blinkUrl) {
    const templates = [
      `New prediction market: "${market.question}" - Vote now!\n\n${blinkUrl}`,
      `Will it happen? "${market.question}"\n\nBet YES or NO:\n${blinkUrl}`,
      `I just created a market on @AgentBetsBot:\n\n"${market.question}"\n\nJoin the action: ${blinkUrl}`
    ];
    return templates[Math.floor(Math.random() * templates.length)];
  }
}

// ==========================================
// DEMONSTRATION
// ==========================================

async function demonstrateSDK() {
  console.log('\n' + '='.repeat(60));
  console.log('  AgentBets SDK Demonstration');
  console.log('  Showing how AI agents interact with the platform');
  console.log('='.repeat(60) + '\n');

  // Initialize SDK as an agent
  const sdk = new AgentBetsSDK();
  await sdk.initialize('DemoAgent');

  console.log('\n--- MARKET DISCOVERY ---');

  // Find markets
  const markets = await sdk.getMarkets({ status: 'active', limit: 5 });
  console.log(`Found ${markets.markets?.length || 0} active markets`);

  // Find opportunities
  const opportunities = await sdk.findOpportunities({ minOddsDiff: 0.1 });
  console.log(`Found ${opportunities.length} potential opportunities`);

  console.log('\n--- MARKET CREATION ---');

  // Create market using template
  const templateMarket = await sdk.createFromTemplate('agent-followers', {
    agent: 'truth_terminal',
    target: '500K',
    date: 'Feb 28, 2026',
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  });

  if (templateMarket.success) {
    console.log(`Created market from template: ${templateMarket.market.id}`);

    console.log('\n--- BETTING ---');

    // Place a bet
    const bet = await sdk.placeBet(templateMarket.market.id, 'YES', 0.25);
    if (bet.success) {
      console.log(`Bet placed successfully!`);
    }

    console.log('\n--- BLINK GENERATION ---');

    // Get blink URL
    const blink = await sdk.getBlinkUrl(templateMarket.market.id);
    if (blink.blinkUrl || blink.dialUrl) {
      const blinkUrl = blink.blinkUrl || blink.dialUrl;
      console.log(`Blink URL: ${blinkUrl}`);

      // Generate tweet
      const tweet = sdk.generateTweetText(templateMarket.market, blinkUrl);
      console.log(`\nSample tweet:\n${tweet}`);
    }
  }

  console.log('\n--- ROYALTIES ---');

  // Check royalties
  const royalties = await sdk.getRoyalties();
  console.log(`Royalty balance: ${JSON.stringify(royalties)}`);

  // Estimate royalties
  const estimate = await sdk.estimateRoyalties(100);
  console.log(`Royalty estimate for 100 SOL volume: ${JSON.stringify(estimate)}`);

  console.log('\n--- POSITIONS ---');

  // Get positions
  const positions = await sdk.getMyPositions();
  console.log(`Active positions: ${positions.positions?.length || 0}`);

  console.log('\n' + '='.repeat(60));
  console.log('  SDK Demonstration Complete');
  console.log('='.repeat(60) + '\n');
}

// Export for use as module
module.exports = { AgentBetsSDK, AgentWallet };

// Run demonstration if executed directly
if (require.main === module) {
  demonstrateSDK().catch(console.error);
}
