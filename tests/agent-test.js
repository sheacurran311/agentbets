/**
 * AgentBets Agent Test Suite
 * Comprehensive testing for AI agent interactions with the AgentBets API
 *
 * Tests the full agent workflow:
 * 1. Market Discovery - Finding markets to bet on
 * 2. Market Creation - Creating new prediction markets
 * 3. Betting Operations - Placing bets on markets
 * 4. Position Management - Checking positions and winnings
 * 5. Royalty Tracking - Verifying creator royalties
 *
 * Usage: node tests/agent-test.js [--api-url <url>]
 */

const API_BASE = process.argv.includes('--api-url')
  ? process.argv[process.argv.indexOf('--api-url') + 1]
  : 'http://localhost:3002/api';

// Test utilities
const log = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[PASS]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[FAIL]\x1b[0m ${msg}`),
  section: (msg) => console.log(`\n\x1b[35m=== ${msg} ===\x1b[0m`)
};

let testResults = { passed: 0, failed: 0 };

async function fetchAPI(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  try {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

function assert(condition, testName) {
  if (condition) {
    log.success(testName);
    testResults.passed++;
    return true;
  } else {
    log.error(testName);
    testResults.failed++;
    return false;
  }
}

// Generate test wallet address (mock)
function generateWallet() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let wallet = '';
  for (let i = 0; i < 44; i++) {
    wallet += chars[Math.floor(Math.random() * chars.length)];
  }
  return wallet;
}

// ==========================================
// TEST SUITES
// ==========================================

/**
 * Test 1: API Health Check
 */
async function testHealth() {
  log.section('API Health Check');

  const result = await fetchAPI('/health');
  assert(result.ok || result.status === 404, 'API is reachable');

  const statsResult = await fetchAPI('/stats');
  assert(statsResult.ok, 'Stats endpoint responds');

  if (statsResult.ok) {
    log.info(`Current stats: ${JSON.stringify(statsResult.data)}`);
  }
}

/**
 * Test 2: Market Discovery (Agent browsing markets)
 */
async function testMarketDiscovery() {
  log.section('Market Discovery');

  // Get all markets
  const allMarkets = await fetchAPI('/markets');
  assert(allMarkets.ok, 'Can fetch all markets');

  if (allMarkets.ok) {
    log.info(`Found ${allMarkets.data.markets?.length || 0} total markets`);
  }

  // Filter by category
  const categories = ['competition', 'performance', 'token', 'milestone', 'head-to-head', 'app', 'general'];
  for (const category of categories) {
    const result = await fetchAPI(`/markets?category=${category}`);
    assert(result.ok, `Can filter markets by category: ${category}`);
  }

  // Filter by status
  const activeMarkets = await fetchAPI('/markets?status=active');
  assert(activeMarkets.ok, 'Can filter active markets');

  // Test limit parameter
  const limitedMarkets = await fetchAPI('/markets?limit=5');
  assert(limitedMarkets.ok && (limitedMarkets.data.markets?.length || 0) <= 5, 'Limit parameter works');
}

/**
 * Test 3: Market Creation (Agent creating markets)
 */
async function testMarketCreation() {
  log.section('Market Creation');

  const testAgent = '@TestAgent_' + Date.now();
  const testWallet = generateWallet();

  // Test required fields validation
  const invalidMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({ question: 'Test?' }) // Missing endDate
  });
  assert(!invalidMarket.ok || invalidMarket.data.error, 'Validates required fields');

  // Create valid market - Performance category
  const performanceMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will @truth_terminal reach 500K followers by Feb 28, 2026?',
      description: 'Based on X/Twitter follower count at resolution date',
      category: 'performance',
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      resolutionSource: 'x-api',
      verificationUrl: 'https://x.com/truth_terminal',
      verificationMethod: 'Check follower count via X API',
      threshold: '500,000 followers',
      tags: ['ai', 'agent', 'followers'],
      creatorAgent: testAgent,
      creatorWallet: testWallet
    })
  });
  assert(performanceMarket.ok && performanceMarket.data.success, 'Can create performance market');

  if (performanceMarket.ok) {
    log.info(`Created market: ${performanceMarket.data.market?.id}`);
    log.info(`Royalty info: ${JSON.stringify(performanceMarket.data.royaltyInfo)}`);
  }

  // Create token market
  const tokenMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will $BUTTERS reach $100K mcap by Feb 15, 2026?',
      description: 'Based on DexScreener market cap data',
      category: 'token',
      endDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      resolutionSource: 'dexscreener',
      verificationUrl: 'https://dexscreener.com/solana/butters',
      threshold: '$100,000 market cap',
      creatorAgent: testAgent
    })
  });
  assert(tokenMarket.ok && tokenMarket.data.success, 'Can create token market');

  // Create head-to-head market
  const h2hMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will @AIButters gain more followers than @ClawdKrab this week?',
      description: 'Head-to-head comparison of follower growth',
      category: 'head-to-head',
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      resolutionSource: 'x-api',
      verificationMethod: 'Compare net follower change over 7 days',
      creatorAgent: testAgent
    })
  });
  assert(h2hMarket.ok && h2hMarket.data.success, 'Can create head-to-head market');

  // Create competition market
  const competitionMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will AgentBets finish top 3 in Colosseum Agent Hackathon?',
      category: 'competition',
      endDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      resolutionSource: 'colosseum',
      creatorAgent: testAgent
    })
  });
  assert(competitionMarket.ok && competitionMarket.data.success, 'Can create competition market');

  // Create milestone market
  const milestoneMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will Moltbook reach 3M registered agents by March 2026?',
      category: 'milestone',
      endDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      resolutionSource: 'moltbook',
      verificationUrl: 'https://moltbook.com/stats',
      threshold: '3,000,000 agents',
      creatorAgent: testAgent
    })
  });
  assert(milestoneMarket.ok && milestoneMarket.data.success, 'Can create milestone market');

  // Create app/platform market
  const appMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will AgentBets launch on mainnet by Feb 12, 2026?',
      category: 'app',
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      resolutionSource: 'manual',
      creatorAgent: testAgent
    })
  });
  assert(appMarket.ok && appMarket.data.success, 'Can create app market');

  // Create custom/general market
  const customMarket = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: 'Will AI agents be mainstream by 2027?',
      description: 'A custom market with no specific oracle',
      category: 'general',
      endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      resolutionSource: 'manual',
      creatorAgent: testAgent
    })
  });
  assert(customMarket.ok && customMarket.data.success, 'Can create custom/general market');

  return performanceMarket.data?.market?.id;
}

/**
 * Test 4: Betting Operations (Agent placing bets)
 */
async function testBetting(marketId) {
  log.section('Betting Operations');

  if (!marketId) {
    log.error('No market ID available for betting tests');
    return null;
  }

  const testWallet = generateWallet();
  const txSignature = 'test_' + Date.now(); // Mock transaction

  // Place YES bet
  const yesBet = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId,
      outcome: 'YES',
      amount: 0.5,
      wallet: testWallet,
      txSignature
    })
  });
  assert(yesBet.ok && yesBet.data.success, 'Can place YES bet');

  if (yesBet.ok) {
    log.info(`YES bet placed. New odds - YES: ${(yesBet.data.market?.yesOdds * 100).toFixed(1)}%, NO: ${(yesBet.data.market?.noOdds * 100).toFixed(1)}%`);
  }

  // Place NO bet with different wallet
  const testWallet2 = generateWallet();
  const noBet = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId,
      outcome: 'NO',
      amount: 0.3,
      wallet: testWallet2,
      txSignature: 'test_' + Date.now()
    })
  });
  assert(noBet.ok && noBet.data.success, 'Can place NO bet');

  if (noBet.ok) {
    log.info(`NO bet placed. New odds - YES: ${(noBet.data.market?.yesOdds * 100).toFixed(1)}%, NO: ${(noBet.data.market?.noOdds * 100).toFixed(1)}%`);
  }

  // Test invalid bet (market not found)
  const invalidBet = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId: 'invalid-market-id',
      outcome: 'YES',
      amount: 0.1,
      wallet: testWallet
    })
  });
  assert(!invalidBet.ok || invalidBet.data.error, 'Rejects bet on non-existent market');

  // Test invalid outcome
  const badOutcome = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId,
      outcome: 'MAYBE',
      amount: 0.1,
      wallet: testWallet
    })
  });
  assert(!badOutcome.ok || badOutcome.data.error, 'Rejects invalid outcome');

  // Get market bets
  const marketBets = await fetchAPI(`/bets/market/${marketId}`);
  assert(marketBets.ok && marketBets.data.bets?.length >= 2, 'Can retrieve market bets');

  // Get user bets
  const userBets = await fetchAPI(`/bets/user/${testWallet}`);
  assert(userBets.ok && userBets.data.bets?.length >= 1, 'Can retrieve user bets');

  return { testWallet, marketId };
}

/**
 * Test 5: Position Management
 */
async function testPositions(testWallet, marketId) {
  log.section('Position Management');

  if (!testWallet || !marketId) {
    log.error('No test data for position tests');
    return;
  }

  // Get user positions
  const positions = await fetchAPI(`/positions/${testWallet}`);
  assert(positions.ok, 'Can fetch user positions');

  if (positions.ok && positions.data.positions?.length > 0) {
    const pos = positions.data.positions[0];
    log.info(`Position: ${pos.outcome} - ${pos.totalBetSOL} SOL - Potential: ${pos.potentialWinningsSOL?.toFixed(4)} SOL`);
  }
}

/**
 * Test 6: Royalty System (Per-Market)
 */
async function testRoyalties() {
  log.section('Royalty System (Per-Market)');

  const testAgent = 'TestAgent_' + Date.now();

  // Check royalties for agent
  const royalties = await fetchAPI(`/royalties/${testAgent}`);
  assert(royalties.ok || royalties.status === 404, 'Royalty endpoint accessible');

  // Get royalty leaderboard
  const leaderboard = await fetchAPI('/royalties-leaderboard');
  assert(leaderboard.ok, 'Can fetch royalty leaderboard');

  // Estimate royalties
  const estimate = await fetchAPI('/royalties/estimate/100');
  assert(estimate.ok, 'Can estimate royalties');

  if (estimate.ok) {
    log.info(`Royalty estimate for 100 SOL: ${JSON.stringify(estimate.data)}`);
    log.info('Note: Royalties are per-market only - creators earn from the market they created');
  }
}

/**
 * Test 6b: Points System
 */
async function testPointsSystem() {
  log.section('Points System');

  const testAgent = 'PointsTestAgent_' + Date.now();

  // Get initial points (should be 0)
  const initialPoints = await fetchAPI(`/points/${testAgent}`);
  assert(initialPoints.ok, 'Can fetch agent points');
  assert(initialPoints.data?.totalPoints === 0, 'New agent starts with 0 points');

  // Get points leaderboard
  const leaderboard = await fetchAPI('/points-leaderboard');
  assert(leaderboard.ok, 'Can fetch points leaderboard');

  // Get participation info
  const participationInfo = await fetchAPI('/participation-info');
  assert(participationInfo.ok, 'Can fetch participation info');

  if (participationInfo.ok) {
    log.info(`Points system: ${participationInfo.data.pointsSystem.name}`);
    log.info('Points will convert to tokens at launch (no timeline)');
  }

  // Create a market and verify points are awarded
  const marketResult = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: `Will ${testAgent} reach 1K followers?`,
      category: 'performance',
      endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      creatorAgent: testAgent
    })
  });

  assert(marketResult.ok && marketResult.data.success, 'Can create market');
  assert(marketResult.data.pointsAwarded?.points === 100, 'Market creation awards 100 points');

  // Verify points were credited
  const afterPoints = await fetchAPI(`/points/${testAgent}`);
  assert(afterPoints.ok && afterPoints.data?.totalPoints === 100, 'Points credited after market creation');

  if (afterPoints.ok) {
    log.info(`Agent ${testAgent} now has ${afterPoints.data.totalPoints} points`);
  }
}

/**
 * Test 7: Oracle System
 */
async function testOracles() {
  log.section('Oracle System');

  // Get available oracle types
  const oracleTypes = await fetchAPI('/oracle/types');
  assert(oracleTypes.ok, 'Can fetch oracle types');

  if (oracleTypes.ok) {
    log.info(`Oracle types: ${JSON.stringify(oracleTypes.data.types || oracleTypes.data)}`);
  }

  // Test DexScreener oracle (real token)
  const dexResult = await fetchAPI('/oracle/dexscreener/So11111111111111111111111111111111111111112'); // SOL
  assert(dexResult.ok || dexResult.status === 404, 'DexScreener oracle accessible');
}

/**
 * Test 8: Agent Verification
 */
async function testVerification() {
  log.section('Agent Verification');

  // Check verification status
  const verifyResult = await fetchAPI('/verify/truth_terminal');
  assert(verifyResult.ok || verifyResult.status === 404, 'Verification endpoint accessible');

  // Get whitelist
  const whitelist = await fetchAPI('/verify/whitelist');
  assert(whitelist.ok || whitelist.status === 404, 'Whitelist endpoint accessible');

  if (whitelist.ok) {
    log.info(`Verified agents: ${JSON.stringify(whitelist.data.agents?.slice(0, 5) || [])}`);
  }
}

/**
 * Test 9: Blinks/Actions
 */
async function testBlinks(marketId) {
  log.section('Blinks/Actions');

  if (!marketId) {
    log.info('Skipping blink tests - no market ID');
    return;
  }

  // Get blink URL
  const blinkResult = await fetchAPI(`/blink/${marketId}`);
  assert(blinkResult.ok, 'Can generate Blink URL');

  if (blinkResult.ok) {
    log.info(`Blink URL: ${blinkResult.data.blinkUrl || blinkResult.data.dialUrl}`);
  }

  // Test Actions endpoint
  const actionsResult = await fetchAPI(`/actions/bet/${marketId}`);
  assert(actionsResult.ok || actionsResult.status === 404, 'Actions endpoint accessible');
}

/**
 * Test 10: Market Resolution
 */
async function testResolution(marketId) {
  log.section('Market Resolution');

  if (!marketId) {
    log.info('Skipping resolution tests - no market ID');
    return;
  }

  // Resolve market
  const resolveResult = await fetchAPI(`/markets/${marketId}/resolve`, {
    method: 'PUT',
    body: JSON.stringify({
      resolution: 'YES',
      resolverWallet: generateWallet()
    })
  });
  assert(resolveResult.ok, 'Can resolve market');

  if (resolveResult.ok) {
    log.info(`Market resolved: ${resolveResult.data.resolution}`);
    log.info(`Payouts: ${JSON.stringify(resolveResult.data.payouts?.slice(0, 3) || [])}`);
    log.info(`Royalties: ${JSON.stringify(resolveResult.data.royalties)}`);
  }

  // Verify market status changed
  const marketResult = await fetchAPI(`/markets/${marketId}`);
  assert(marketResult.ok && marketResult.data.status === 'resolved', 'Market status is resolved');
}

/**
 * Test 11: Platform Statistics
 */
async function testStats() {
  log.section('Platform Statistics');

  const stats = await fetchAPI('/stats');
  assert(stats.ok, 'Can fetch platform stats');

  if (stats.ok) {
    log.info(`Platform stats: ${JSON.stringify(stats.data)}`);
  }

  const leaderboard = await fetchAPI('/leaderboard');
  assert(leaderboard.ok, 'Can fetch leaderboard');
}

// ==========================================
// RUN ALL TESTS
// ==========================================

async function runAllTests() {
  console.log('\n' + '='.repeat(60));
  console.log('  AgentBets Agent Test Suite');
  console.log('  API URL: ' + API_BASE);
  console.log('='.repeat(60));

  try {
    await testHealth();
    await testMarketDiscovery();
    const marketId = await testMarketCreation();
    const betData = await testBetting(marketId);
    if (betData) {
      await testPositions(betData.testWallet, betData.marketId);
    }
    await testRoyalties();
    await testPointsSystem();
    await testOracles();
    await testVerification();
    await testBlinks(marketId);
    // Only test resolution if we have a market
    // await testResolution(marketId); // Commented out to preserve markets
    await testStats();
  } catch (error) {
    log.error(`Test suite error: ${error.message}`);
    console.error(error);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  TEST RESULTS');
  console.log('='.repeat(60));
  console.log(`  \x1b[32mPassed: ${testResults.passed}\x1b[0m`);
  console.log(`  \x1b[31mFailed: ${testResults.failed}\x1b[0m`);
  console.log(`  Total:  ${testResults.passed + testResults.failed}`);
  console.log('='.repeat(60) + '\n');

  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runAllTests();
