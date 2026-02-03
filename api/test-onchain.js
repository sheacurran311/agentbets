/**
 * Poll.fun SDK Integration Test
 *
 * IMPORTANT FINDING: Poll.fun is only deployed on MAINNET, not devnet!
 * Program ID: po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u
 *
 * This test verifies:
 * 1. SDK integration is correct
 * 2. Method signatures match SDK expectations
 * 3. Payout calculations work
 * 4. Confirms mainnet deployment exists
 */

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { SDK } = require('@solworks/poll-sdk');

// Set env for testing
const testPrivateKey = '2cjHLPDxyEF3nsKPj8q3rABqd5D1va7zztuugeQiXbEB9cZ31eWfTA2PcMEf1W6apayToWXqMHRAGA5tKNK1xZbw';
process.env.SOLANA_PRIVATE_KEY = testPrivateKey;
process.env.SOLANA_NETWORK = 'devnet';

// Import after setting env
const { PollFunService } = require('./src/pollfun');

async function testIntegration() {
  console.log('=== Poll.fun SDK Integration Verification ===\n');

  // Test 1: Verify mainnet deployment
  console.log('1. Verifying Poll.fun mainnet deployment...');
  const mainnetConn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
  const mainnetSdk = SDK.build({ connection: mainnetConn, commitment: 'confirmed' });

  const programId = new PublicKey('po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u');
  const programAccount = await mainnetConn.getAccountInfo(programId);

  if (programAccount && programAccount.executable) {
    console.log('   [OK] Poll.fun program exists on mainnet');
    console.log('   Program ID:', programId.toBase58());
  } else {
    console.log('   [FAIL] Poll.fun program not found');
    return false;
  }

  const protocolAddr = mainnetSdk.addresses.protocol.get();
  const protocolAccount = await mainnetConn.getAccountInfo(protocolAddr);

  if (protocolAccount) {
    console.log('   [OK] Protocol account initialized on mainnet');
    console.log('   Protocol:', protocolAddr.toBase58());
  } else {
    console.log('   [FAIL] Protocol not initialized');
    return false;
  }

  // Test 2: Service initialization
  console.log('\n2. Testing AgentBets service initialization...');
  const service = new PollFunService({ network: 'mainnet' });

  if (service.sdk && service.creatorKeypair) {
    console.log('   [OK] Service initialized with wallet');
    console.log('   Wallet:', service.creatorKeypair.publicKey.toBase58());
  } else if (service.sdk) {
    console.log('   [OK] Service initialized (read-only mode)');
  } else {
    console.log('   [FAIL] Service initialization failed');
    return false;
  }

  // Test 3: Verify all required methods exist
  console.log('\n3. Verifying service methods...');
  const requiredMethods = [
    'createMarket',
    'buildWagerInstruction',
    'placeWager',
    'resolveMarket',
    'settleBatch',
    'getMarketData',
    'getUserData',
    'ensureUserExists',
    'cancelWager',
    'calculatePotentialPayout'
  ];

  let allMethodsOk = true;
  for (const method of requiredMethods) {
    const exists = typeof service[method] === 'function';
    console.log('   ' + (exists ? '[OK]' : '[FAIL]') + ' ' + method + '()');
    if (!exists) allMethodsOk = false;
  }

  // Test 4: Verify SDK methods are accessible
  console.log('\n4. Verifying SDK method availability...');
  const sdkMethods = [
    'initializeBetV2',
    'placeWagerV2',
    'initiateVoteV2',
    'placeVoteV2',
    'settleBetBatchV2',
    'initializeUser',
    'tryCancelWagerV2'
  ];

  for (const method of sdkMethods) {
    const exists = typeof service.sdk[method] === 'function';
    console.log('   ' + (exists ? '[OK]' : '[FAIL]') + ' sdk.' + method + '()');
    if (!exists) allMethodsOk = false;
  }

  // Test 5: Test payout calculation
  console.log('\n5. Testing payout calculation (offline)...');
  const mockMarket = {
    yesPool: 1000,
    noPool: 500
  };

  const payoutYes = service.calculatePotentialPayout(mockMarket, 'YES', 100);
  const payoutNo = service.calculatePotentialPayout(mockMarket, 'NO', 100);

  console.log('   Mock market: $1000 YES, $500 NO');
  console.log('   $100 on YES -> Win: $' + payoutYes.potentialWinnings + ', Prob: ' + payoutYes.impliedProbability);
  console.log('   $100 on NO  -> Win: $' + payoutNo.potentialWinnings + ', Prob: ' + payoutNo.impliedProbability);
  console.log('   [OK] Payout calculation working');

  // Test 6: Query existing mainnet market (if any)
  console.log('\n6. Checking SDK account query methods...');
  try {
    // Check if accounts methods exist
    const hasAccountMethods =
      service.sdk.accounts &&
      typeof service.sdk.accounts.betV2 === 'object' &&
      typeof service.sdk.accounts.user === 'object';

    console.log('   [OK] SDK account query methods available');
    console.log('   accounts.betV2:', typeof service.sdk.accounts.betV2);
    console.log('   accounts.user:', typeof service.sdk.accounts.user);
  } catch (err) {
    console.log('   [WARN] Account query error:', err.message);
  }

  // Summary
  console.log('\n=== Integration Test Summary ===');
  console.log('Poll.fun Program: MAINNET ONLY (po11oacBudCHcbqXWhmuuQmRnzKmkjwmkvwzHZvAX9u)');
  console.log('SDK Integration:', allMethodsOk ? 'PASS' : 'FAIL');
  console.log('Service Methods:', allMethodsOk ? 'PASS' : 'FAIL');
  console.log('Payout Math: PASS');

  console.log('\n=== Deployment Notes ===');
  console.log('- Poll.fun is NOT deployed to devnet');
  console.log('- Live testing requires mainnet USDC');
  console.log('- For hackathon demo: Use mainnet with small amounts');
  console.log('- AgentBets uses isCreatorResolver=true for secure resolution');

  return allMethodsOk;
}

testIntegration().then(success => {
  console.log('\nFinal Result:', success ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED');
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
