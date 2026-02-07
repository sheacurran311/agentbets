/**
 * Phishing Detection Module
 *
 * Scans incoming tweet text and market questions for phishing attempts:
 * - Private key / seed phrase / mnemonic requests
 * - Suspicious URLs (shorteners, known phishing domains)
 * - Social engineering patterns (DM me, send to wallet, verify by sending)
 * - Wallet address solicitation outside withdraw command context
 */

class PhishingDetector {
  constructor() {
    // Phrases that request private keys or secrets
    this.secretKeyPhrases = [
      'private key',
      'secret key',
      'seed phrase',
      'seed words',
      'recovery phrase',
      'recovery words',
      'mnemonic',
      'mnemonic phrase',
      'backup phrase',
      'wallet phrase',
      'passphrase',
      'secret recovery',
      'private seed',
      'master key',
      'keypair',
      'key pair',
      '12 words',
      '24 words',
      'twelve words',
      'twenty-four words',
      'json keyfile',
      'keystore file',
      'wallet.json',
      'solana keypair',
      'phantom recovery',
      'export private',
      'share your key',
      'give me your key',
      'send your key',
      'paste your key',
      'enter your key',
      'provide your key',
      'input your seed',
      'type your seed',
    ];

    // Social engineering patterns
    this.socialEngineeringPatterns = [
      /dm\s+me\s+(your|the|a)\s+(wallet|key|seed|phrase|secret)/i,
      /send\s+(your|the|a)\s+(wallet|key|seed|private|secret|recovery)/i,
      /verify\s+(your|by)\s+(sending|sharing|providing|entering)/i,
      /claim\s+your\s+(reward|prize|airdrop|tokens?)\s+(?:by|at|via)/i,
      /connect\s+your\s+wallet\s+(?:at|to|via)\s+https?/i,
      /airdrop.*(?:send|share|provide).*(?:key|wallet|seed)/i,
      /(?:free|bonus)\s+(?:sol|usdc|tokens?).*(?:send|dm|click)/i,
      /(?:double|triple|multiply)\s+your\s+(?:sol|crypto|tokens?)/i,
      /send\s+\d+\s*(?:sol|usdc|lamports)\s+(?:to|and)\s+(?:get|receive)/i,
      /urgent.*(?:wallet|account|funds?).*(?:risk|danger|compromised|hacked)/i,
      /(?:your|this)\s+(?:wallet|account)\s+(?:has been|is)\s+(?:compromised|hacked|at risk)/i,
    ];

    // Known phishing URL patterns (kept as reference, but ALL URLs are now blocked)
    this.suspiciousUrlPatterns = [
      /bit\.ly\//i,
      /tinyurl\.com\//i,
      /t\.co\//i,    // Twitter's own shortener is fine in tweets, but suspicious in bet questions
      /goo\.gl\//i,
      /is\.gd\//i,
      /buff\.ly\//i,
      /ow\.ly\//i,
      /rb\.gy\//i,
      /short\.io\//i,
      /cutt\.ly\//i,
      // Known phishing domain patterns
      /phantom[\-_]?(?:wallet|app|verify|claim|update)\./i,
      /solana[\-_]?(?:claim|airdrop|verify|reward|drop)\./i,
      /(?:free|claim|get)[\-_]?(?:sol|solana|phantom|usdc)\./i,
      /(?:wallet|connect)[\-_]?(?:verify|validate|confirm)\./i,
      // IP address URLs (almost always phishing)
      /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/i,
    ];

    // Wallet drain patterns - requests to send funds somewhere
    this.walletDrainPatterns = [
      /send\s+(?:\d+\s*)?(?:sol|usdc|lamports|tokens?)\s+to\s+[1-9A-HJ-NP-Za-km-z]{32,44}/i,
      /transfer\s+(?:\d+\s*)?(?:sol|usdc|lamports|tokens?)\s+to\s+[1-9A-HJ-NP-Za-km-z]{32,44}/i,
      /deposit\s+(?:to|into)\s+[1-9A-HJ-NP-Za-km-z]{32,44}/i,
    ];
  }

  /**
   * Scan text for phishing indicators
   * @param {string} text - The tweet or question text to scan
   * @param {string} context - 'tweet' | 'question' | 'withdraw' for context-aware scanning
   * @returns {{ isPhishing: boolean, reason: string|null, severity: 'high'|'medium'|'low'|null }}
   */
  scan(text, context = 'tweet') {
    if (!text || typeof text !== 'string') {
      return { isPhishing: false, reason: null, severity: null };
    }

    const lowerText = text.toLowerCase();

    // Check 1: Secret key / seed phrase requests (HIGH severity)
    for (const phrase of this.secretKeyPhrases) {
      if (lowerText.includes(phrase)) {
        return {
          isPhishing: true,
          reason: `Contains suspicious phrase: "${phrase}"`,
          severity: 'high'
        };
      }
    }

    // Check 2: Social engineering patterns (HIGH severity)
    for (const pattern of this.socialEngineeringPatterns) {
      if (pattern.test(text)) {
        return {
          isPhishing: true,
          reason: `Matches social engineering pattern`,
          severity: 'high'
        };
      }
    }

    // Check 3: Wallet drain patterns (HIGH severity)
    for (const pattern of this.walletDrainPatterns) {
      if (pattern.test(text)) {
        return {
          isPhishing: true,
          reason: `Contains wallet drain pattern (request to send funds)`,
          severity: 'high'
        };
      }
    }

    // Check 4: Block ALL links in any context
    // The bot has no reason to process URLs. Ignoring all links prevents
    // phishing attacks regardless of how clever the domain looks.
    if (/https?:\/\/\S+/i.test(text)) {
      return {
        isPhishing: true,
        reason: `Contains a URL. AgentBets ignores all links for security`,
        severity: 'medium'
      };
    }

    // Also catch URL-like patterns without protocol (www., .com, .io, etc.)
    if (/(?:^|\s)(?:www\.|[\w-]+\.(?:com|io|xyz|net|org|gg|app|dev|co|me|finance|exchange|claim|drop))\b/i.test(text)) {
      return {
        isPhishing: true,
        reason: `Contains a URL-like pattern. AgentBets ignores all links for security`,
        severity: 'medium'
      };
    }

    // Check 5: Fund transfer requests (any context)
    // Catch patterns asking to send, transfer, or deposit funds to an address
    if (/(?:send|transfer|deposit|pay)\s+(?:\d+\s*)?(?:sol|usdc|lamports|spl|tokens?)\s+(?:to|into|at)/i.test(text)) {
      return {
        isPhishing: true,
        reason: `Contains a fund transfer request. AgentBets never asks you to send funds directly`,
        severity: 'high'
      };
    }

    return { isPhishing: false, reason: null, severity: null };
  }

  /**
   * Scan a bet question specifically for phishing content
   * More strict than general tweet scanning
   */
  scanQuestion(question) {
    return this.scan(question, 'question');
  }

  /**
   * Scan a full tweet for phishing content
   */
  scanTweet(tweetText) {
    return this.scan(tweetText, 'tweet');
  }

  /**
   * Strip all URLs from text (for sanitizing before processing)
   * Removes both protocol URLs and bare domain references
   */
  stripUrls(text) {
    if (!text) return text;
    return text
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/(?:^|\s)www\.\S+/gi, '')
      .trim();
  }

  /**
   * Check if text contains any URL
   */
  containsUrl(text) {
    if (!text) return false;
    return /https?:\/\/\S+/i.test(text) ||
           /(?:^|\s)(?:www\.|[\w-]+\.(?:com|io|xyz|net|org|gg|app|dev|co|me|finance|exchange|claim|drop))\b/i.test(text);
  }
}

module.exports = PhishingDetector;
