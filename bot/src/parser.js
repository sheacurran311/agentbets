/**
 * Bet Request Parser
 *
 * Parses natural language bet requests from tweets
 * Supports multiple formats for flexibility
 */

class BetParser {
  constructor() {
    // Keywords that indicate a bet request
    this.betKeywords = ['bet:', 'create bet', 'new bet', 'prediction:', 'market:'];

    // Bot command keywords
    this.commandKeywords = ['balance', 'withdraw', 'royalties', 'help', 'stats'];

    // Resolution source mappings
    this.resolutionSources = {
      'dexscreener': 'dexscreener',
      'dex': 'dexscreener',
      'price': 'dexscreener',
      'token': 'dexscreener',
      'x-api': 'x-api',
      'twitter': 'x-api',
      'followers': 'x-api',
      'moltbook': 'moltbook',
      'molt': 'moltbook',
      'karma': 'moltbook',
      'manual': 'manual',
      'github': 'github',
      'solana': 'solana',
      'onchain': 'solana'
    };

    // Category detection patterns
    this.categoryPatterns = {
      'token': /\$[A-Z]+|mcap|market cap|price/i,
      'performance': /followers|engagement|growth|reach|impressions/i,
      'milestone': /ship|launch|release|deploy|reach|hit/i,
      'competition': /win|hackathon|contest|competition|vs\./i,
      'head-to-head': /vs\.?|versus|compared to|more than.*than/i
    };
  }

  /**
   * Check if a tweet is a bet creation request
   */
  isBetRequest(text) {
    const lowerText = text.toLowerCase();
    // Make sure it's not a command
    if (this.isCommand(text)) return false;
    return this.betKeywords.some(keyword => lowerText.includes(keyword));
  }

  /**
   * Check if a tweet is a bot command
   */
  isCommand(text) {
    const lowerText = text.toLowerCase();
    return this.commandKeywords.some(keyword => lowerText.includes(keyword));
  }

  /**
   * Parse a bot command
   */
  parseCommand(text) {
    const lowerText = text.toLowerCase();

    if (lowerText.includes('balance') || lowerText.includes('royalties')) {
      return { command: 'balance' };
    }

    if (lowerText.includes('withdraw')) {
      // Check for wallet address in the tweet
      const walletMatch = text.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      return {
        command: 'withdraw',
        wallet: walletMatch ? walletMatch[1] : null
      };
    }

    if (lowerText.includes('help')) {
      return { command: 'help' };
    }

    if (lowerText.includes('stats')) {
      return { command: 'stats' };
    }

    return { command: 'unknown' };
  }

  /**
   * Parse bet parameters from tweet text
   */
  parseBet(text) {
    try {
      const result = {
        valid: false,
        question: null,
        endDate: null,
        resolution: 'manual',
        threshold: null,
        category: 'general',
        targetHandle: null,
        targetToken: null
      };

      // Extract question (in quotes or after bet: or natural language with ?)
      const questionMatch = text.match(/[""]([^""]+)[""]/) ||
                           text.match(/bet:\s*(.+?)(?:\n|ends:|resolution:|$)/i) ||
                           text.match(/prediction:\s*(.+?)(?:\n|ends:|resolution:|$)/i) ||
                           text.match(/@\w+\s+(Will\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Who\s+.+\?)/i) ||
                           text.match(/@\w+\s+(What\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Can\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Does\s+.+\?)/i);

      if (questionMatch) {
        result.question = questionMatch[1].trim();
      } else {
        return { valid: false, error: 'Could not find question. Use quotes or "bet: your question" or ask a question ending in ?' };
      }

      // Extract end date
      const dateMatch = text.match(/ends?:\s*(\d{4}-\d{2}-\d{2})/i) ||
                       text.match(/by\s+(\w+\s+\d{1,2},?\s*\d{4})/i) ||
                       text.match(/until\s+(\d{4}-\d{2}-\d{2})/i);

      if (dateMatch) {
        const parsedDate = new Date(dateMatch[1]);
        if (isNaN(parsedDate.getTime())) {
          return { valid: false, error: 'Invalid date format. Use YYYY-MM-DD' };
        }
        result.endDate = parsedDate.toISOString();
      } else {
        // Default to 7 days from now
        const defaultEnd = new Date();
        defaultEnd.setDate(defaultEnd.getDate() + 7);
        result.endDate = defaultEnd.toISOString();
      }

      // Extract resolution source
      const resolutionMatch = text.match(/resolution:\s*(\w+)/i) ||
                             text.match(/resolve:\s*(\w+)/i) ||
                             text.match(/via:\s*(\w+)/i);

      if (resolutionMatch) {
        const source = resolutionMatch[1].toLowerCase();
        result.resolution = this.resolutionSources[source] || 'manual';
      } else {
        // Auto-detect resolution source from question
        result.resolution = this.detectResolutionSource(result.question);
      }

      // Extract threshold
      const thresholdMatch = text.match(/threshold:\s*([\d,\.]+\s*\w*)/i) ||
                            text.match(/target:\s*([\d,\.]+\s*\w*)/i) ||
                            text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:followers|karma|mcap|\$)/i);

      if (thresholdMatch) {
        result.threshold = thresholdMatch[1].trim();
      }

      // Extract target handle for X API resolution
      const handleMatch = text.match(/@(\w+)\s+(?:reach|hit|get|followers)/i) ||
                         text.match(/will\s+@(\w+)/i);

      if (handleMatch) {
        result.targetHandle = handleMatch[1];
      }

      // Extract target token for DexScreener resolution
      const tokenMatch = text.match(/\$([A-Z]+)/);
      if (tokenMatch) {
        result.targetToken = tokenMatch[1];
      }

      // Detect category
      result.category = this.detectCategory(result.question);

      result.valid = true;
      return result;

    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  /**
   * Auto-detect resolution source from question text
   */
  detectResolutionSource(question) {
    const lower = question.toLowerCase();

    if (/\$[A-Z]+|mcap|market cap|price/i.test(question)) {
      return 'dexscreener';
    }
    if (/followers|following|likes|retweets|impressions/i.test(lower)) {
      return 'x-api';
    }
    if (/karma|moltbook|molt/i.test(lower)) {
      return 'moltbook';
    }
    if (/commit|release|deploy|ship|github/i.test(lower)) {
      return 'github';
    }
    if (/balance|wallet|sol|transaction/i.test(lower)) {
      return 'solana';
    }

    return 'manual';
  }

  /**
   * Detect market category from question
   */
  detectCategory(question) {
    for (const [category, pattern] of Object.entries(this.categoryPatterns)) {
      if (pattern.test(question)) {
        return category;
      }
    }
    return 'general';
  }

  /**
   * Parse multiple bet formats for flexibility
   */
  parseFlexible(text) {
    // Format 1: Structured with labels
    // @AgentBetsBot bet: "Question?" ends: 2026-02-15 resolution: dexscreener threshold: 100000

    // Format 2: Natural language
    // @AgentBetsBot Will $BUTTERS hit $1M mcap by Feb 28?

    // Format 3: Simple question + date
    // @AgentBetsBot "Will Butters win?" ends: 2026-02-12

    // Try structured first
    let result = this.parseBet(text);

    if (!result.valid) {
      // Try extracting question from natural language
      const naturalMatch = text.match(/@AgentBetsBot\s+(.+\?)/i);
      if (naturalMatch) {
        const question = naturalMatch[1].trim();
        result = {
          valid: true,
          question,
          endDate: this.extractDateFromText(text) || this.defaultEndDate(),
          resolution: this.detectResolutionSource(question),
          threshold: this.extractThreshold(text),
          category: this.detectCategory(question),
          targetHandle: this.extractHandle(text),
          targetToken: this.extractToken(text)
        };
      }
    }

    return result;
  }

  extractDateFromText(text) {
    // Try various date formats
    const patterns = [
      /by\s+(\w+\s+\d{1,2},?\s*\d{4})/i,
      /until\s+(\w+\s+\d{1,2},?\s*\d{4})/i,
      /ends?\s+(\w+\s+\d{1,2},?\s*\d{4})/i,
      /(\d{4}-\d{2}-\d{2})/
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const date = new Date(match[1]);
        if (!isNaN(date.getTime())) {
          return date.toISOString();
        }
      }
    }
    return null;
  }

  defaultEndDate() {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date.toISOString();
  }

  extractThreshold(text) {
    const match = text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:K|M|followers|karma|mcap|\$)?/i);
    return match ? match[0].trim() : null;
  }

  extractHandle(text) {
    const match = text.match(/@(\w+)\s+(?:reach|hit|get|have|followers)/i) ||
                 text.match(/will\s+@(\w+)/i);
    return match ? match[1] : null;
  }

  extractToken(text) {
    const match = text.match(/\$([A-Z]+)/);
    return match ? match[1] : null;
  }
}

module.exports = BetParser;
