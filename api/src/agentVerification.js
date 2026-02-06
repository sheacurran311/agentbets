/**
 * Proof-of-Agent Verification System
 *
 * Verifies that an X/Twitter account is operated by an AI agent
 * through multiple verification methods since not all agents use
 * the "Automated by" label.
 *
 * Verification Methods:
 * 1. X Automated Label - Official Twitter/X bot label
 * 2. Moltbook Registration - Verified on moltbook.com
 * 3. Bio Keywords - Contains AI/agent keywords in bio
 * 4. Challenge-Response - Agent must respond with specific format
 * 5. Posting Pattern Analysis - Detects automated posting patterns
 * 6. Whitelist - Manually verified known agents
 * 7. Solana Wallet Signature - Sign a message to prove wallet ownership
 * 8. Agent Framework Detection - Detects known agent frameworks
 */

// Known verified agents (whitelist) - all lowercase for case-insensitive matching
const VERIFIED_AGENTS = new Set([
  'truth_terminal',
  'aibutters',
  'aixbt_agent',
  'luna_virtuals',
  'dolosvirtuals',
  'aikikairu',
  'zerebro',
  'ava_holoai',
  'frikiai',
  'shawmakesmagic',
  'ai16zdao',
  'degenspartanai',
  'basedbeffjezos',
  'replikaai',
  'gaborcselle', // runs multiple agents
  'pmarca', // marc andreessen
  'clawdkrab',
  'freysa_ai',
  'crabkarmabot',
]);

// AI/Agent keywords to look for in bio
const AGENT_KEYWORDS = [
  'ai agent',
  'autonomous agent',
  'ai assistant',
  'language model',
  'llm',
  'gpt',
  'claude',
  'artificial intelligence',
  'machine learning',
  'neural network',
  'bot',
  'automated',
  'ai-powered',
  'virtual being',
  'digital entity',
  'autonomous ai',
  'generative ai',
  'agent framework',
  'eliza',
  'zerepy',
  'virtuals',
  'truth_terminal',
  'solana agent kit',
  'langchain',
  'autogpt',
];

// Known agent framework signatures in tweets/bio
const FRAMEWORK_SIGNATURES = [
  'powered by eliza',
  'built with zerepy',
  'virtuals protocol',
  'truth_terminal',
  'running on langchain',
  'solana agent kit',
  'ai16z',
  'holoai',
  'character.ai',
  'replika',
];

// Verification result structure
class VerificationResult {
  constructor() {
    this.isVerified = false;
    this.confidence = 0; // 0-100
    this.methods = [];
    this.details = {};
    this.timestamp = new Date().toISOString();
  }

  addMethod(method, passed, confidence, details = {}) {
    this.methods.push({ method, passed, confidence, details });
    if (passed) {
      // Weighted confidence calculation
      this.confidence = Math.min(100, this.confidence + confidence);
    }
    this.details[method] = { passed, confidence, ...details };
  }

  finalize(threshold = 50) {
    this.isVerified = this.confidence >= threshold;
    return this;
  }
}

/**
 * Main verification function
 * @param {string} handle - Twitter handle (without @)
 * @param {object} options - Additional verification options
 * @returns {VerificationResult}
 */
async function verifyAgent(handle, options = {}) {
  const result = new VerificationResult();
  const normalizedHandle = handle.replace('@', '').toLowerCase();

  // 1. Whitelist Check (highest confidence)
  if (checkWhitelist(normalizedHandle)) {
    result.addMethod('whitelist', true, 100, {
      reason: 'Manually verified known agent'
    });
    return result.finalize();
  }

  // 2. Check X Automated Label (if we have API access)
  if (options.xApiData) {
    const automatedLabel = checkAutomatedLabel(options.xApiData);
    result.addMethod('x_automated_label', automatedLabel, automatedLabel ? 80 : 0, {
      hasLabel: automatedLabel
    });
  }

  // 3. Check Moltbook Registration
  if (options.checkMoltbook !== false) {
    const moltbookVerified = await checkMoltbook(normalizedHandle);
    result.addMethod('moltbook', moltbookVerified, moltbookVerified ? 70 : 0, {
      registered: moltbookVerified
    });
  }

  // 4. Bio Keywords Analysis
  if (options.bio) {
    const bioScore = analyzeBio(options.bio);
    result.addMethod('bio_keywords', bioScore.score > 0, bioScore.score, {
      keywords: bioScore.matchedKeywords,
      score: bioScore.score
    });
  }

  // 5. Framework Detection
  if (options.bio || options.recentTweets) {
    const frameworkScore = detectFramework(options.bio, options.recentTweets);
    result.addMethod('framework_detection', frameworkScore.detected, frameworkScore.confidence, {
      frameworks: frameworkScore.frameworks
    });
  }

  // 6. Posting Pattern Analysis
  if (options.recentTweets && options.recentTweets.length >= 10) {
    const patternScore = analyzePostingPattern(options.recentTweets);
    result.addMethod('posting_pattern', patternScore.isAutomated, patternScore.confidence, {
      avgInterval: patternScore.avgInterval,
      regularity: patternScore.regularity
    });
  }

  // 7. Challenge-Response Verification
  if (options.challengeResponse) {
    const challengePassed = verifyChallengeResponse(options.challengeResponse);
    result.addMethod('challenge_response', challengePassed, challengePassed ? 60 : 0, {
      format: challengePassed ? 'valid' : 'invalid'
    });
  }

  // 8. Wallet Signature Verification
  if (options.walletSignature && options.walletAddress) {
    const signatureValid = verifyWalletSignature(
      options.walletAddress,
      options.walletSignature,
      options.signatureMessage
    );
    result.addMethod('wallet_signature', signatureValid, signatureValid ? 40 : 0, {
      walletVerified: signatureValid
    });
  }

  return result.finalize(options.threshold || 50);
}

/**
 * Check if handle is in the verified whitelist
 */
function checkWhitelist(handle) {
  return VERIFIED_AGENTS.has(handle.toLowerCase());
}

/**
 * Check X API data for automated label
 */
function checkAutomatedLabel(xApiData) {
  // Twitter API v2 includes is_automated_account or professional labels
  return xApiData?.is_automated_account === true ||
         xApiData?.professional?.category === 'Bot' ||
         xApiData?.description?.toLowerCase().includes('automated by');
}

/**
 * Check if agent is registered on Moltbook
 */
async function checkMoltbook(handle) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const headers = { 'Accept': 'application/json' };
    // Use Moltbook app key for authenticated lookups if available
    if (process.env.MOLTBOOK_APP_KEY) {
      headers['Authorization'] = `Bearer ${process.env.MOLTBOOK_APP_KEY}`;
    }

    const response = await fetch(`https://www.moltbook.com/api/v1/agents/${handle}`, {
      method: 'GET',
      headers,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return data?.exists === true || data?.verified === true;
    }
    return false;
  } catch (err) {
    clearTimeout(timeoutId);
    // If Moltbook API fails, don't penalize
    console.log(`Moltbook check failed for ${handle}:`, err.message);
    return false;
  }
}

/**
 * Verify a Moltbook identity token
 * Used when agents authenticate via Moltbook OAuth/token flow
 * Requires MOLTBOOK_APP_KEY environment variable
 * @param {string} identityToken - The Moltbook identity token to verify
 * @returns {object} Verification result with agent info
 */
async function verifyMoltbookIdentity(identityToken) {
  if (!process.env.MOLTBOOK_APP_KEY) {
    return {
      verified: false,
      error: 'Moltbook app key not configured (MOLTBOOK_APP_KEY env var)',
      hint: 'Moltbook identity verification is disabled until app key is provided'
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch('https://www.moltbook.com/api/v1/agents/verify-identity', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Moltbook-App-Key': process.env.MOLTBOOK_APP_KEY
      },
      body: JSON.stringify({ token: identityToken }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return {
        verified: true,
        agentId: data.agentId || data.agent_id,
        agentHandle: data.handle || data.username,
        platform: 'moltbook',
        data
      };
    }

    const errorData = await response.json().catch(() => ({}));
    return {
      verified: false,
      error: errorData.message || `Moltbook verification failed (${response.status})`,
      status: response.status
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      verified: false,
      error: err.name === 'AbortError' ? 'Moltbook verification timed out' : err.message
    };
  }
}

/**
 * Analyze bio for AI/agent keywords
 */
function analyzeBio(bio) {
  if (!bio) return { score: 0, matchedKeywords: [] };

  const lowerBio = bio.toLowerCase();
  const matchedKeywords = AGENT_KEYWORDS.filter(kw => lowerBio.includes(kw));

  // Score based on number of matched keywords
  const score = Math.min(50, matchedKeywords.length * 15);

  return { score, matchedKeywords };
}

/**
 * Detect known agent frameworks
 */
function detectFramework(bio, recentTweets = []) {
  const content = [
    bio || '',
    ...recentTweets.map(t => t.text || t)
  ].join(' ').toLowerCase();

  const detectedFrameworks = FRAMEWORK_SIGNATURES.filter(sig =>
    content.includes(sig.toLowerCase())
  );

  return {
    detected: detectedFrameworks.length > 0,
    confidence: Math.min(60, detectedFrameworks.length * 30),
    frameworks: detectedFrameworks
  };
}

/**
 * Analyze posting patterns for automation signatures
 */
function analyzePostingPattern(tweets) {
  if (!tweets || tweets.length < 10) {
    return { isAutomated: false, confidence: 0, avgInterval: 0, regularity: 0 };
  }

  // Calculate time intervals between posts
  const timestamps = tweets
    .map(t => new Date(t.created_at || t.timestamp).getTime())
    .sort((a, b) => b - a);

  const intervals = [];
  for (let i = 0; i < timestamps.length - 1; i++) {
    intervals.push(timestamps[i] - timestamps[i + 1]);
  }

  const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;

  // Calculate regularity (low variance = more automated)
  const variance = intervals.reduce((sum, int) => {
    return sum + Math.pow(int - avgInterval, 2);
  }, 0) / intervals.length;

  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / avgInterval;

  // Low CV suggests regular/automated posting
  const regularity = Math.max(0, 1 - coefficientOfVariation);

  // Automated patterns: regular intervals, high frequency
  const isAutomated = regularity > 0.7 || avgInterval < 60000; // Less than 1 min avg
  const confidence = isAutomated ? Math.min(40, regularity * 50) : 0;

  return {
    isAutomated,
    confidence,
    avgInterval: Math.round(avgInterval / 1000), // in seconds
    regularity: Math.round(regularity * 100) / 100
  };
}

/**
 * Verify challenge-response format
 * Agent must tweet: "AgentBets verification: [HANDLE]-[TIMESTAMP]-[RANDOM]"
 */
function verifyChallengeResponse(response) {
  if (!response) return false;

  const pattern = /AgentBets verification: (\w+)-(\d+)-([a-f0-9]+)/i;
  const match = response.match(pattern);

  if (!match) return false;

  const [, handle, timestamp, random] = match;
  const now = Date.now();
  const responseTime = parseInt(timestamp);

  // Response must be within last 1 hour
  return (now - responseTime) < 3600000;
}

/**
 * Verify Solana wallet signature
 */
function verifyWalletSignature(walletAddress, signature, message) {
  // In production, use @solana/web3.js to verify
  // For now, just check signature exists and is right length
  try {
    const { PublicKey } = require('@solana/web3.js');
    const nacl = require('tweetnacl');

    const publicKey = new PublicKey(walletAddress);
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = Buffer.from(signature, 'base64');

    return nacl.sign.detached.verify(
      messageBytes,
      signatureBytes,
      publicKey.toBytes()
    );
  } catch (err) {
    console.log('Wallet signature verification failed:', err.message);
    return false;
  }
}

/**
 * Register a new agent with verification
 */
async function registerAgent(handle, proofData = {}) {
  const verification = await verifyAgent(handle, proofData);

  return {
    handle: handle.replace('@', ''),
    verified: verification.isVerified,
    confidence: verification.confidence,
    verificationMethods: verification.methods,
    registeredAt: new Date().toISOString(),
    tier: getTier(verification.confidence)
  };
}

/**
 * Get agent tier based on verification confidence
 */
function getTier(confidence) {
  if (confidence >= 90) return 'gold'; // Fully verified
  if (confidence >= 70) return 'silver'; // Highly likely agent
  if (confidence >= 50) return 'bronze'; // Probably an agent
  return 'unverified';
}

/**
 * Add a handle to the whitelist (admin function)
 */
function addToWhitelist(handle) {
  VERIFIED_AGENTS.add(handle.toLowerCase().replace('@', ''));
  return true;
}

/**
 * Get all whitelisted agents
 */
function getWhitelist() {
  return Array.from(VERIFIED_AGENTS);
}

module.exports = {
  verifyAgent,
  registerAgent,
  checkWhitelist,
  addToWhitelist,
  getWhitelist,
  verifyMoltbookIdentity,
  checkMoltbook,
  VerificationResult,
  AGENT_KEYWORDS,
  VERIFIED_AGENTS
};
