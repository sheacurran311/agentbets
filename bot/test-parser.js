/**
 * Local Parser Test Suite
 * Tests the BetParser without any API calls, Twitter, or on-chain transactions.
 * Run: node test-parser.js
 */

const BetParser = require('./src/parser');
const p = new BetParser();

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

// ═══════════════════════════════════════════════════
// 1. ROUTING: isBetRequest vs isCommand
// ═══════════════════════════════════════════════════
console.log('\n=== Routing (isBetRequest vs isCommand) ===\n');

test('Structured bet request is detected', () => {
  assert(p.isBetRequest('@AgentBetsBot bet: "Will $SOL hit $200?"'), 'Should detect structured bet');
});

test('Natural language question is NOT detected as bet request (no keyword)', () => {
  // isBetRequest requires one of the keywords: bet:, create bet, new bet, prediction:, market:
  const result = p.isBetRequest('@AgentBetsBot Will $SOL hit $200 by March?');
  // This is expected to be false since there's no keyword
  assert(!result, 'Natural language without keyword should not be isBetRequest');
});

test('"balance" is a command, not a bet', () => {
  assert(p.isCommand('@AgentBetsBot balance'), 'balance should be command');
  assert(!p.isBetRequest('@AgentBetsBot balance'), 'balance should not be bet request');
});

test('"help" is a command', () => {
  assert(p.isCommand('@AgentBetsBot help'), 'help should be command');
});

test('"withdraw" is a command', () => {
  assert(p.isCommand('@AgentBetsBot withdraw 48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM'), 'withdraw should be command');
});

test('"bet on" is a command (bet placement on existing market)', () => {
  assert(p.isCommand('@AgentBetsBot bet on market abc123 10 USDC YES'), 'bet on should be command');
});

test('"stats" is a command', () => {
  assert(p.isCommand('@AgentBetsBot stats'), 'stats should be command');
});

test('"status market123" is a command', () => {
  assert(p.isCommand('@AgentBetsBot status market123'), 'status should be command');
});

// ═══════════════════════════════════════════════════
// 2. MARKET CREATION PARSING
// ═══════════════════════════════════════════════════
console.log('\n=== Market Creation Parsing ===\n');

test('Structured format with all fields', () => {
  const r = p.parseBet('bet: "Will $BUTTERS hit $1M mcap?" ends: 2026-03-15 resolution: dexscreener threshold: 1000000');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.question === 'Will $BUTTERS hit $1M mcap?', `Question: ${r.question}`);
  assert(r.resolution === 'dexscreener', `Resolution: ${r.resolution}`);
  assert(r.threshold === '1000000', `Threshold: ${r.threshold}`);
  assert(r.category === 'token', `Category: ${r.category}`);
});

test('Natural language with question mark', () => {
  const r = p.parseBet('@AgentBetsBot bet: Will $SOL hit $200 by March 2026?');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.question.includes('SOL'), `Question should mention SOL: ${r.question}`);
});

test('Default end date is 7 days from now', () => {
  const r = p.parseBet('bet: "Will it rain tomorrow?"');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  const endDate = new Date(r.endDate);
  const sixDays = Date.now() + 6 * 24 * 60 * 60 * 1000;
  const eightDays = Date.now() + 8 * 24 * 60 * 60 * 1000;
  assert(endDate.getTime() > sixDays && endDate.getTime() < eightDays, 'Default end date should be ~7 days out');
});

test('Explicit end date is parsed', () => {
  const r = p.parseBet('bet: "Test?" ends: 2026-06-01');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.endDate.includes('2026-06-01'), `End date: ${r.endDate}`);
});

test('Past end date is rejected', () => {
  const r = p.parseBet('bet: "Test?" ends: 2020-01-01');
  assert(!r.valid, 'Past date should be rejected');
  assert(r.error.includes('past') || r.error.includes('future'), `Error: ${r.error}`);
});

test('Missing question is rejected', () => {
  const r = p.parseBet('ends: 2026-06-01 resolution: manual');
  assert(!r.valid, 'Missing question should be rejected');
  assert(r.error.includes('question'), `Error: ${r.error}`);
});

// ═══════════════════════════════════════════════════
// 3. RESOLUTION SOURCE AUTO-DETECTION
// ═══════════════════════════════════════════════════
console.log('\n=== Resolution Source Detection ===\n');

test('Token symbol ($SOL) -> dexscreener', () => {
  const r = p.parseBet('bet: "Will $SOL hit $200?"');
  assert(r.resolution === 'dexscreener', `Got: ${r.resolution}`);
});

test('Followers mention -> x-api', () => {
  const r = p.parseBet('bet: "Will @AIButters reach 50K followers?"');
  assert(r.resolution === 'x-api', `Got: ${r.resolution}`);
});

test('Karma mention -> moltbook', () => {
  const r = p.parseBet('bet: "Will AgentBB hit 1000 karma?"');
  assert(r.resolution === 'moltbook', `Got: ${r.resolution}`);
});

test('Deploy/ship mention -> github', () => {
  const r = p.parseBet('bet: "Will the team ship v2 by March?"');
  assert(r.resolution === 'github', `Got: ${r.resolution}`);
});

test('Generic question -> manual', () => {
  const r = p.parseBet('bet: "Will it rain in NYC tomorrow?"');
  assert(r.resolution === 'manual', `Got: ${r.resolution}`);
});

test('Explicit resolution override', () => {
  const r = p.parseBet('bet: "Will it rain?" resolution: manual');
  assert(r.resolution === 'manual', `Got: ${r.resolution}`);
});

// ═══════════════════════════════════════════════════
// 4. CATEGORY DETECTION
// ═══════════════════════════════════════════════════
console.log('\n=== Category Detection ===\n');

test('Token question -> token category', () => {
  const r = p.parseBet('bet: "Will $BONK hit $1M mcap?"');
  assert(r.category === 'token', `Got: ${r.category}`);
});

test('Followers question -> performance category', () => {
  const r = p.parseBet('bet: "Will @AIButters reach 100K followers?"');
  assert(r.category === 'performance', `Got: ${r.category}`);
});

test('Hackathon question -> competition category', () => {
  const r = p.parseBet('bet: "Will team Alpha win the hackathon?"');
  assert(r.category === 'competition', `Got: ${r.category}`);
});

test('Generic question -> general category', () => {
  const r = p.parseBet('bet: "Will it rain tomorrow?"');
  assert(r.category === 'general', `Got: ${r.category}`);
});

// ═══════════════════════════════════════════════════
// 5. INITIAL BET PARSING (create + bet in one tweet)
// ═══════════════════════════════════════════════════
console.log('\n=== Initial Bet Parsing ===\n');

test('Betting X USDC YES format', () => {
  const r = p.parseBet('bet: "Will $SOL hit $300?" ends: 2026-03-01 betting 10 USDC YES');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.initialBet === 10, `Initial bet: ${r.initialBet}`);
  assert(r.initialOutcome === 'YES', `Outcome: ${r.initialOutcome}`);
  assert(r.initialCurrency === 'USDC', `Currency: ${r.initialCurrency}`);
});

test('Amount USDC on YES format', () => {
  const r = p.parseBet('bet: "Will $SOL hit $300?" 5 USDC on YES');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.initialBet === 5, `Initial bet: ${r.initialBet}`);
});

test('Non-USDC currency is rejected', () => {
  const r = p.parseBet('bet: "Will $SOL moon?" betting 10 SOL YES');
  assert(!r.valid, 'SOL currency should be rejected');
  assert(r.error.includes('USDC only'), `Error: ${r.error}`);
});

test('No initial bet -> initialBet is null', () => {
  const r = p.parseBet('bet: "Will it rain?" ends: 2026-06-01');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.initialBet === null, `initialBet should be null: ${r.initialBet}`);
});

// ═══════════════════════════════════════════════════
// 6. BET PLACEMENT COMMANDS (on existing markets)
// ═══════════════════════════════════════════════════
console.log('\n=== Bet Placement Commands ===\n');

test('bet 10 USDC YES on market abc123', () => {
  const r = p.parseBetPlacement('@AgentBetsBot bet 10 USDC YES on market abc123');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.amount === 10, `Amount: ${r.amount}`);
  assert(r.outcome === 'YES', `Outcome: ${r.outcome}`);
  assert(r.marketId === 'abc123', `Market ID: ${r.marketId}`);
  assert(r.currency === 'USDC', `Currency: ${r.currency}`);
});

test('Non-USDC bet placement is rejected', () => {
  const r = p.parseBetPlacement('@AgentBetsBot bet 10 SOL YES on market abc123');
  assert(!r.valid || r.error, 'SOL should be rejected');
  assert(r.error && r.error.includes('USDC only'), `Error: ${r.error}`);
});

test('Missing amount in bet placement', () => {
  const r = p.parseBetPlacement('@AgentBetsBot bet YES on market abc123');
  assert(!r.valid, 'Missing amount should be rejected');
});

test('Missing outcome in bet placement', () => {
  const r = p.parseBetPlacement('@AgentBetsBot bet 10 USDC on market abc123');
  // "on" might interfere, but NO/YES is missing
  const hasOutcome = r.outcome === 'YES' || r.outcome === 'NO';
  // This depends on parser behavior - just check it handles gracefully
  assert(r.error || hasOutcome, 'Should either error or find an outcome');
});

// ═══════════════════════════════════════════════════
// 7. COMMAND PARSING
// ═══════════════════════════════════════════════════
console.log('\n=== Command Parsing ===\n');

test('balance command', () => {
  const r = p.parseCommand('@AgentBetsBot balance');
  assert(r.command === 'balance', `Command: ${r.command}`);
});

test('withdraw with wallet', () => {
  const r = p.parseCommand('@AgentBetsBot withdraw 48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM');
  assert(r.command === 'withdraw', `Command: ${r.command}`);
  assert(r.wallet === '48sWTmPygvc4w2RqKMao6zXWPGzpnnD1uecXJbCkRnQM', `Wallet: ${r.wallet}`);
});

test('help command', () => {
  const r = p.parseCommand('@AgentBetsBot help');
  assert(r.command === 'help', `Command: ${r.command}`);
});

test('stats command', () => {
  const r = p.parseCommand('@AgentBetsBot stats');
  assert(r.command === 'stats', `Command: ${r.command}`);
});

test('status with market ID', () => {
  const r = p.parseCommand('@AgentBetsBot status market123');
  assert(r.command === 'status', `Command: ${r.command}`);
  assert(r.marketId === 'market123', `Market ID: ${r.marketId}`);
});

// ═══════════════════════════════════════════════════
// 8. VERIFIABILITY VALIDATION
// ═══════════════════════════════════════════════════
console.log('\n=== Verifiability Validation ===\n');

test('Quantitative token bet with threshold is verifiable', () => {
  const params = p.parseBet('bet: "Will $SOL hit $200?" resolution: dexscreener threshold: 200');
  const v = p.validateVerifiability(params);
  assert(v.verifiable, `Should be verifiable: ${v.warnings.join(', ')}`);
});

test('Quantitative bet without threshold is NOT verifiable', () => {
  const params = { valid: true, question: 'Will $SOL go up?', resolution: 'dexscreener', threshold: null };
  const v = p.validateVerifiability(params);
  assert(!v.verifiable, 'Missing threshold should be unverifiable');
});

test('Vague question with manual resolution is NOT verifiable', () => {
  const params = { valid: true, question: 'Will AI take over the world?', resolution: 'manual', threshold: null };
  const v = p.validateVerifiability(params);
  // "take over" matches vague pattern, manual resolution -> unverifiable
  assert(!v.verifiable, 'Vague manual bet should be unverifiable');
});

test('Token bet with implicit threshold ($1M) IS verifiable', () => {
  const params = p.parseBet('bet: "Will $BONK hit $1M mcap?"');
  const v = p.validateVerifiability(params);
  assert(v.verifiable, `Should be verifiable: ${v.warnings.join(', ')}`);
});

test('Specific measurable question is verifiable', () => {
  const params = p.parseBet('bet: "Will @AIButters reach 50000 followers?" resolution: x-api threshold: 50000');
  const v = p.validateVerifiability(params);
  assert(v.verifiable, `Should be verifiable: ${v.warnings.join(', ')}`);
});

// ═══════════════════════════════════════════════════
// 9. $1 MINIMUM BET (new validation)
// ═══════════════════════════════════════════════════
console.log('\n=== $1 Minimum Bet (Parser-Level) ===\n');

test('$0.50 initial bet parses (parser does not enforce min, API does)', () => {
  const r = p.parseBet('bet: "Will $SOL hit $300?" betting 0.50 USDC YES');
  // Parser itself doesn't enforce $1 min - that's the API's job
  // But let's verify the parser correctly captures the amount
  assert(r.valid, `Should parse, got error: ${r.error}`);
  assert(r.initialBet === 0.5, `Initial bet: ${r.initialBet}`);
});

test('$1.00 initial bet parses correctly', () => {
  const r = p.parseBet('bet: "Will $SOL hit $300?" betting 1 USDC YES');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.initialBet === 1, `Initial bet: ${r.initialBet}`);
});

test('$100 initial bet parses correctly', () => {
  const r = p.parseBet('bet: "Will $SOL hit $300?" betting 100 USDC YES');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.initialBet === 100, `Initial bet: ${r.initialBet}`);
});

// ═══════════════════════════════════════════════════
// 10. EDGE CASES
// ═══════════════════════════════════════════════════
console.log('\n=== Edge Cases ===\n');

test('Contract address detection in question', () => {
  const r = p.parseBet('bet: "Will DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 hit $1M mcap?"');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
});

test('Multiple @handles in question', () => {
  const r = p.parseBet('bet: "Will @AIButters beat @truth_terminal in followers?"');
  assert(r.valid, `Should be valid, got error: ${r.error}`);
  assert(r.targetHandle, `Should extract a target handle: ${r.targetHandle}`);
});

test('Flexible parser fallback for natural language', () => {
  const r = p.parseFlexible('@AgentBetsBot Will $BONK reach $1M mcap by Feb 28?');
  assert(r.valid, `Should be valid via flexible parse, got error: ${r.error}`);
  assert(r.question.includes('BONK'), `Question: ${r.question}`);
});

test('Empty text returns invalid', () => {
  const r = p.parseBet('');
  assert(!r.valid, 'Empty text should be invalid');
});

// ═══════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════
console.log('\n' + '='.repeat(50));
console.log(`\n  Results: ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
if (failed > 0) {
  console.log('  Some tests failed! Review output above.\n');
  process.exit(1);
} else {
  console.log('  All tests passed!\n');
}
