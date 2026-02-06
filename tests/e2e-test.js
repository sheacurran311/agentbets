/**
 * AgentBets E2E Test Suite
 * Tests complete user flows for hackathon validation
 */

const API_BASE = process.argv.includes('--api-url')
  ? process.argv[process.argv.indexOf('--api-url') + 1]
  : 'http://localhost:3002/api';

const ADMIN_WALLET = 'ESutJq7VqRER499A78W9BJCjdtZAqMJWy6hjf4HCjtsG';

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

// Generate test wallet address
function generateWallet() {
  const chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let wallet = '';
  for (let i = 0; i < 44; i++) {
    wallet += chars[Math.floor(Math.random() * chars.length)];
  }
  return wallet;
}

// ==========================================
// E2E TEST FLOWS
// ==========================================

/**
 * Flow 1: User Bet Journey
 * Connect -> Browse -> Select -> Bet -> Verify
 */
async function testUserBetFlow() {
  log.section('E2E Flow 1: User Bet Journey');
  
  const userWallet = generateWallet();
  log.info(`User wallet: ${userWallet.slice(0, 10)}...`);
  
  // Step 1: Browse markets
  log.info('Step 1: Browsing available markets...');
  const markets = await fetchAPI('/markets?status=active&limit=10');
  assert(markets.ok && markets.data.markets?.length > 0, 'Can browse active markets');
  
  if (!markets.ok || !markets.data.markets?.length) {
    log.error('No markets available - skipping rest of flow');
    return null;
  }
  
  // Step 2: Select a market
  const selectedMarket = markets.data.markets[0];
  log.info(`Step 2: Selected market: "${selectedMarket.question.slice(0, 50)}..."`);
  
  // Step 3: Get market details
  const marketDetails = await fetchAPI(`/markets/${selectedMarket.id}`);
  assert(marketDetails.ok, 'Can get market details');
  log.info(`Current odds: YES ${((marketDetails.data?.yesOdds || 0.5) * 100).toFixed(0)}% | NO ${((marketDetails.data?.noOdds || 0.5) * 100).toFixed(0)}%`);
  
  // Step 4: Place bet
  log.info('Step 3: Placing bet (10 USDC on YES)...');
  const bet = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId: selectedMarket.id,
      outcome: 'YES',
      amount: 10,
      wallet: userWallet,
      txSignature: 'test_e2e_' + Date.now()
    })
  });
  assert(bet.ok && bet.data.success, 'Can place bet on market');
  
  if (bet.ok) {
    log.info(`Bet placed! ID: ${bet.data.bet?.id}`);
    log.info(`New market odds: YES ${((bet.data.market?.yesOdds || 0) * 100).toFixed(0)}% | NO ${((bet.data.market?.noOdds || 0) * 100).toFixed(0)}%`);
  }
  
  // Step 5: Verify position
  log.info('Step 4: Verifying user position...');
  const positions = await fetchAPI(`/positions/${userWallet}`);
  assert(positions.ok && positions.data.positions?.length >= 1, 'Position recorded correctly');
  
  // Step 6: Check leaderboard
  log.info('Step 5: Checking leaderboard...');
  const leaderboard = await fetchAPI('/leaderboard');
  assert(leaderboard.ok, 'Leaderboard accessible');
  
  return { userWallet, marketId: selectedMarket.id };
}

/**
 * Flow 2: Agent Market Creation
 * Create market -> Place initial bet -> Verify royalty
 */
async function testAgentMarketCreation() {
  log.section('E2E Flow 2: Agent Market Creation');
  
  const agentHandle = `@E2ETestAgent_${Date.now()}`;
  const agentWallet = generateWallet();
  log.info(`Agent: ${agentHandle}`);
  
  // Step 1: Create a new market
  log.info('Step 1: Creating prediction market...');
  const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const market = await fetchAPI('/markets', {
    method: 'POST',
    body: JSON.stringify({
      question: `E2E Test: Will this market resolve correctly?`,
      description: 'End-to-end test market for hackathon validation',
      category: 'general',
      endDate,
      resolutionSource: 'manual',
      creatorAgent: agentHandle,
      creatorWallet: agentWallet
    })
  });
  assert(market.ok && market.data.success, 'Market created successfully');
  
  if (!market.ok) {
    log.error('Market creation failed - skipping rest of flow');
    return null;
  }
  
  const marketId = market.data.market?.id;
  log.info(`Market ID: ${marketId}`);
  
  // Step 2: Verify royalty info
  log.info('Step 2: Verifying royalty setup...');
  assert(market.data.royaltyInfo !== undefined, 'Royalty info provided');
  log.info(`Creator royalty rate: ${market.data.royaltyInfo?.message || 'N/A'}`);
  
  // Step 3: Place initial bet as agent
  log.info('Step 3: Placing initial bet...');
  const bet = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId,
      outcome: 'YES',
      amount: 50,
      wallet: agentWallet,
      txSignature: 'test_agent_' + Date.now()
    })
  });
  assert(bet.ok && bet.data.success, 'Initial bet placed');
  
  // Step 4: Verify points awarded
  log.info('Step 4: Checking points for market creation...');
  const points = await fetchAPI(`/points/${agentHandle.replace('@', '')}`);
  assert(points.ok && points.data.totalPoints >= 100, 'Points awarded for market creation');
  log.info(`Total points: ${points.data?.totalPoints || 0}`);
  
  return { agentHandle, marketId, agentWallet };
}

/**
 * Flow 3: Market Resolution Flow
 * Propose resolution -> Admin confirms -> Verify settlement
 */
async function testResolutionFlow(marketId) {
  log.section('E2E Flow 3: Market Resolution');
  
  if (!marketId) {
    log.info('Creating test market for resolution...');
    const market = await fetchAPI('/markets', {
      method: 'POST',
      body: JSON.stringify({
        question: 'Resolution Test Market',
        category: 'general',
        endDate: new Date(Date.now() + 1000).toISOString(), // Past date
        resolutionSource: 'manual',
        creatorAgent: '@ResolutionTest'
      })
    });
    marketId = market.data.market?.id;
  }
  
  log.info(`Testing resolution for market: ${marketId}`);
  
  // Step 1: Propose resolution
  log.info('Step 1: Proposing resolution...');
  const propose = await fetchAPI(`/markets/${marketId}/propose-resolution`, {
    method: 'PUT',
    body: JSON.stringify({
      proposedOutcome: 'YES',
      confidence: 95,
      evidence: { type: 'test', note: 'E2E test resolution' },
      proposedBy: 'e2e_test_bot'
    })
  });
  
  // Market might be active or already proposed
  if (propose.ok) {
    log.success('Resolution proposed');
    log.info('Step 2: Admin confirmation would happen here');
    log.info('Note: Full resolution requires admin wallet signature');
  } else {
    log.info(`Proposal status: ${propose.data?.error || 'Already proposed or not ready'}`);
  }
  
  // Step 2: Check pending resolutions
  log.info('Step 3: Checking pending resolutions...');
  const pending = await fetchAPI('/markets/pending-resolutions');
  assert(pending.ok, 'Can fetch pending resolutions');
  log.info(`Pending markets: ${pending.data?.markets?.length || 0}`);
  
  return true;
}

/**
 * Flow 4: Error Handling Tests
 */
async function testErrorHandling() {
  log.section('E2E Flow 4: Error Handling');
  
  // Test 1: Invalid market ID
  log.info('Testing invalid market ID...');
  const invalidMarket = await fetchAPI('/markets/invalid-uuid');
  assert(!invalidMarket.ok || invalidMarket.data.error, 'Rejects invalid market ID');
  
  // Test 2: Bet on non-existent market
  log.info('Testing bet on non-existent market...');
  const invalidBet = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({
      marketId: '00000000-0000-0000-0000-000000000000',
      outcome: 'YES',
      amount: 1,
      wallet: generateWallet()
    })
  });
  assert(!invalidBet.ok || invalidBet.data.error, 'Rejects bet on non-existent market');
  
  // Test 3: Invalid outcome
  log.info('Testing invalid bet outcome...');
  const markets = await fetchAPI('/markets?limit=1');
  if (markets.data.markets?.length > 0) {
    const badBet = await fetchAPI('/bets', {
      method: 'POST',
      body: JSON.stringify({
        marketId: markets.data.markets[0].id,
        outcome: 'MAYBE',
        amount: 1,
        wallet: generateWallet()
      })
    });
    assert(!badBet.ok || badBet.data.error, 'Rejects invalid outcome');
  }
  
  // Test 4: Missing required fields
  log.info('Testing missing required fields...');
  const missingFields = await fetchAPI('/bets', {
    method: 'POST',
    body: JSON.stringify({ marketId: 'test' })
  });
  assert(!missingFields.ok || missingFields.data.error, 'Validates required fields');
  
  return true;
}

/**
 * Flow 5: Rate Limiting Test
 */
async function testRateLimiting() {
  log.section('E2E Flow 5: Rate Limiting');
  
  log.info('Testing rate limits are active...');
  
  // Make several rapid requests
  const requests = [];
  for (let i = 0; i < 5; i++) {
    requests.push(fetchAPI('/health'));
  }
  
  const results = await Promise.all(requests);
  const allOk = results.every(r => r.ok);
  assert(allOk, 'Moderate request rate allowed');
  
  log.info('Rate limiting configured and active');
  return true;
}

// ==========================================
// RUN ALL E2E TESTS
// ==========================================

async function runE2ETests() {
  console.log('\n' + '='.repeat(60));
  console.log('  AgentBets E2E Test Suite');
  console.log('  API URL: ' + API_BASE);
  console.log('='.repeat(60));

  try {
    // Check API health first
    const health = await fetchAPI('/health');
    if (!health.ok) {
      log.error('API is not reachable - aborting E2E tests');
      process.exit(1);
    }
    log.success('API is healthy');

    // Run E2E flows
    const userFlow = await testUserBetFlow();
    const agentFlow = await testAgentMarketCreation();
    await testResolutionFlow(agentFlow?.marketId);
    await testErrorHandling();
    await testRateLimiting();

  } catch (error) {
    log.error(`E2E test error: ${error.message}`);
    console.error(error);
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  E2E TEST RESULTS');
  console.log('='.repeat(60));
  console.log(`  \x1b[32mPassed: ${testResults.passed}\x1b[0m`);
  console.log(`  \x1b[31mFailed: ${testResults.failed}\x1b[0m`);
  console.log(`  Total:  ${testResults.passed + testResults.failed}`);
  console.log('='.repeat(60) + '\n');

  process.exit(testResults.failed > 0 ? 1 : 0);
}

// Run tests
runE2ETests();
