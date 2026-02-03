/**
 * AgentBets X Bot - Test Suite
 *
 * Tests the bot components without requiring live X API
 */

const BetParser = require('./parser');
const ResolutionEngine = require('./resolver');
const AgentVerifier = require('./verifier');
const AgentBetsAPI = require('./api-client');

console.log('=== AgentBets X Bot Test Suite ===\n');

// Test 1: Parser
console.log('1. Testing Bet Parser...\n');

const parser = new BetParser();

const testTweets = [
  // Structured format
  `@AgentBetsBot bet: "Will $BUTTERS hit $1M mcap by Feb 28?" ends: 2026-02-28 resolution: dexscreener threshold: 1000000`,

  // Natural language
  `@AgentBetsBot Will @AIButters reach 50K followers by March 1, 2026?`,

  // Simple format
  `@AgentBetsBot "Will Butters win the hackathon?" ends: 2026-02-12`,

  // Head-to-head
  `@AgentBetsBot bet: "Who gains more followers: @AIButters vs @ClawdKrab?" ends: 2026-02-15 resolution: x-api`,

  // Moltbook
  `@AgentBetsBot Will CrabKarmaBot reach 100K karma on Moltbook by Feb 20?`,

  // Invalid (no question)
  `@AgentBetsBot hello there`,

  // Token price
  `@AgentBetsBot prediction: "Will $SOL hit $300 by end of month?" resolution: dexscreener threshold: 300`,
];

for (const tweet of testTweets) {
  console.log(`Input: "${tweet.slice(0, 60)}..."`);
  const result = parser.parseBet(tweet);

  if (result.valid) {
    console.log(`  Valid: YES`);
    console.log(`  Question: ${result.question}`);
    console.log(`  End Date: ${new Date(result.endDate).toLocaleDateString()}`);
    console.log(`  Resolution: ${result.resolution}`);
    console.log(`  Threshold: ${result.threshold || 'N/A'}`);
    console.log(`  Category: ${result.category}`);
    if (result.targetHandle) console.log(`  Target Handle: @${result.targetHandle}`);
    if (result.targetToken) console.log(`  Target Token: $${result.targetToken}`);
  } else {
    console.log(`  Valid: NO`);
    console.log(`  Error: ${result.error}`);
  }
  console.log();
}

// Test 2: Resolution Engine (offline)
console.log('\n2. Testing Resolution Engine (offline)...\n');

const resolver = new ResolutionEngine();

console.log('Threshold Parsing:');
const thresholds = ['1000000', '1M', '50K', '$100,000', '100k followers'];
for (const t of thresholds) {
  console.log(`  "${t}" -> ${resolver.parseThreshold(t)}`);
}

console.log('\nNumber Formatting:');
const numbers = [1234, 50000, 1500000, 123456789];
for (const n of numbers) {
  console.log(`  ${n} -> ${resolver.formatNumber(n)}`);
}

// Test 3: Verifier (whitelist only)
console.log('\n3. Testing Agent Verifier (whitelist)...\n');

const verifier = new AgentVerifier();

const testHandles = ['AIButters', 'CrabKarmaBot', 'RandomHuman', 'truth_terminal'];
for (const handle of testHandles) {
  const isWhitelisted = verifier.isWhitelisted(handle);
  console.log(`  @${handle}: ${isWhitelisted ? 'WHITELISTED' : 'Not whitelisted'}`);
}

// Test 4: API Client (health check)
console.log('\n4. Testing API Client...\n');

const api = new AgentBetsAPI();
console.log(`API Base URL: ${api.baseUrl}`);

// Check if API is running
api.checkHealth().then(health => {
  console.log(`API Health: ${health.healthy ? 'Healthy' : 'Not reachable'}`);
  if (health.data) {
    console.log(`  Service: ${health.data.service}`);
    console.log(`  Markets: ${health.data.marketsCount}`);
  }
}).catch(err => {
  console.log(`API Health check failed: ${err.message}`);
});

// Test 5: Full flow simulation
console.log('\n5. Simulating Full Bot Flow...\n');

const simulatedTweet = {
  id: '12345',
  author_id: '67890',
  text: '@AgentBetsBot bet: "Will $BUTTERS hit $100K mcap?" ends: 2026-02-28 resolution: dexscreener threshold: 100000'
};

console.log('Simulated Tweet:', simulatedTweet.text);

// Parse
const parsedBet = parser.parseBet(simulatedTweet.text);
console.log('\nParsed Result:', JSON.stringify(parsedBet, null, 2));

// Check verification (whitelist)
const authorHandle = 'AIButters'; // Simulated
const isAgent = verifier.isWhitelisted(authorHandle);
console.log(`\nAgent Verification (@${authorHandle}): ${isAgent ? 'PASS' : 'FAIL'}`);

if (parsedBet.valid && isAgent) {
  console.log('\nWould create market with:');
  console.log(`  Question: ${parsedBet.question}`);
  console.log(`  End Date: ${parsedBet.endDate}`);
  console.log(`  Resolution: ${parsedBet.resolution}`);
  console.log(`  Category: ${parsedBet.category}`);
  console.log(`  Created by: @${authorHandle}`);
}

console.log('\n=== Test Suite Complete ===');
console.log('\nTo run with live APIs:');
console.log('1. Copy .env.example to .env');
console.log('2. Fill in your API credentials');
console.log('3. Run: npm start');
