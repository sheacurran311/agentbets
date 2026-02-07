/**
 * Bet Request Parser
 *
 * Parses natural language bet requests from tweets
 * Supports multiple formats for flexibility
 */

class BetParser {
  constructor() {
    // Keywords that indicate a bet request
    this.betKeywords = ['bet:', 'create bet', 'new bet', 'prediction:', 'market:', 'create market', 'new market'];

    // Bot command keywords - now includes 'bet on' for placing bets and 'status' for market updates
    this.commandKeywords = ['balance', 'withdraw', 'royalties', 'help', 'stats', 'status', 'update', 'bet on', 'wager'];

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
   * Supports both structured formats (bet: "question") and natural language questions
   * directed at the bot (e.g. "@AgentBetsBot Will X happen by Y?")
   */
  isBetRequest(text) {
    const lowerText = text.toLowerCase();
    // Make sure it's not a command
    if (this.isCommand(text)) return false;

    // Check for explicit bet keywords
    if (this.betKeywords.some(keyword => lowerText.includes(keyword))) {
      return true;
    }

    // Check for natural language question patterns directed at the bot
    // These match the same patterns that parseBet() can extract questions from
    const naturalQuestionPatterns = [
      /@\w+\s+Will\s+.+\?/i,
      /@\w+\s+Who\s+.+\?/i,
      /@\w+\s+What\s+.+\?/i,
      /@\w+\s+Can\s+.+\?/i,
      /@\w+\s+Does\s+.+\?/i,
      /@\w+\s+Is\s+.+\?/i,
      /@\w+\s+Are\s+.+\?/i,
      /@\w+\s+How\s+many\s+.+\?/i,
      /@\w+\s+[""].+[""]/,    // Quoted question directed at bot
    ];

    if (naturalQuestionPatterns.some(pattern => pattern.test(text))) {
      return true;
    }

    return false;
  }

  /**
   * Check if a tweet is a bot command
   */
  isCommand(text) {
    const lowerText = text.toLowerCase();
    // Check for explicit commands first
    if (this.commandKeywords.some(keyword => lowerText.includes(keyword))) {
      return true;
    }
    // Check for bet placement format (amount + outcome + market)
    if (this.isBetPlacement(text)) {
      return true;
    }
    return false;
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

    // Market status / bet update command
    if (lowerText.includes('status') || lowerText.includes('update')) {
      // Extract market ID from text
      const marketIdMatch = text.match(/(?:status|update)\s+(?:(?:market|bet|on)\s+)?([a-zA-Z0-9_-]{6,32})/i) ||
                            text.match(/(?:market|bet)\s+([a-zA-Z0-9_-]{6,32})\s+(?:status|update)/i);
      return {
        command: 'status',
        marketId: marketIdMatch ? marketIdMatch[1] : null
      };
    }

    // NEW: Bet placement command
    if (lowerText.includes('bet on') || lowerText.includes('wager on') ||
        /\d+\s*(usdc|sol)\s+(yes|no)\s+on/i.test(lowerText)) {
      return {
        command: 'bet',
        ...this.parseBetPlacement(text)
      };
    }

    return { command: 'unknown' };
  }

  /**
   * Check if this is a bet placement command (betting on existing market)
   */
  isBetPlacement(text) {
    const lowerText = text.toLowerCase();
    return lowerText.includes('bet on') ||
           lowerText.includes('wager on') ||
           lowerText.includes('bet yes') ||
           lowerText.includes('bet no') ||
           /\d+\s*(usdc|sol)\s+(yes|no)\s+on/i.test(lowerText);
  }

  /**
   * Parse bet placement command
   * Formats:
   *   @AgentBetsBot bet 10 USDC YES on market abc123
   *   @AgentBetsBot wager 5 USDC NO on "Will Butters win?"
   *   @AgentBetsBot bet on market abc123 - 10 USDC YES
   */
  parseBetPlacement(text) {
    const result = {
      valid: false,
      marketId: null,
      marketQuestion: null,
      outcome: null,
      amount: null,
      currency: 'USDC', // Default to USDC for x402 payments
      error: null
    };

    // Extract amount and currency
    const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(usdc|sol|eth|btc|bonk|usdt)/i);
    if (amountMatch) {
      result.amount = parseFloat(amountMatch[1]);
      const requestedCurrency = amountMatch[2].toUpperCase();

      // Only USDC is accepted for bets
      if (requestedCurrency !== 'USDC') {
        result.error = `AgentBets markets use USDC only. "${requestedCurrency}" is not accepted.\n\nUse: "bet 10 USDC YES on market [ID]"`;
        return result;
      }

      result.currency = 'USDC';
    }

    // Extract outcome (YES/NO)
    const outcomeMatch = text.match(/\b(yes|no)\b/i);
    if (outcomeMatch) {
      result.outcome = outcomeMatch[1].toUpperCase();
    }

    // Extract market ID (alphanumeric, typically 8-24 chars)
    const marketIdMatch = text.match(/market\s+([a-zA-Z0-9_-]{6,32})/i) ||
                          text.match(/on\s+([a-zA-Z0-9_-]{6,32})/i);
    if (marketIdMatch) {
      result.marketId = marketIdMatch[1];
    }

    // Extract market question (in quotes)
    const questionMatch = text.match(/[""]([^""]+)[""]/);
    if (questionMatch) {
      result.marketQuestion = questionMatch[1];
    }

    // Validate
    if (!result.amount) {
      result.error = 'Missing bet amount. Use: "bet 10 USDC YES on market [ID]"';
      return result;
    }
    if (!result.outcome) {
      result.error = 'Missing outcome (YES/NO). Use: "bet 10 USDC YES on market [ID]"';
      return result;
    }
    if (!result.marketId && !result.marketQuestion) {
      result.error = 'Missing market ID or question. Use: "bet 10 USDC YES on market [ID]"';
      return result;
    }

    result.valid = true;
    return result;
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
        targetToken: null,
        // NEW: Initial bet parameters
        initialBet: null,
        initialOutcome: null,
        initialCurrency: 'USDC'
      };

      // Extract question (in quotes or after bet: or natural language with ?)
      const questionMatch = text.match(/[""]([^""]+)[""]/) ||
                           text.match(/bet:\s*(.+?)(?:\n|ends:|resolution:|$)/i) ||
                           text.match(/prediction:\s*(.+?)(?:\n|ends:|resolution:|$)/i) ||
                           text.match(/(?:create|new)\s+(?:bet|market)\s*:?\s*(.+?)(?:\n|ends:|resolution:|$)/i) ||
                           text.match(/@\w+\s+(Will\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Who\s+.+\?)/i) ||
                           text.match(/@\w+\s+(What\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Can\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Does\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Is\s+.+\?)/i) ||
                           text.match(/@\w+\s+(Are\s+.+\?)/i) ||
                           text.match(/@\w+\s+(How\s+many\s+.+\?)/i);

      if (questionMatch) {
        result.question = questionMatch[1].trim();
      } else {
        return { valid: false, error: 'Could not find question. Use quotes or "bet: your question" or ask a question ending in ?' };
      }

      // Extract end date
      const dateParseResult = this.parseEndDate(text);
      
      if (dateParseResult.error) {
        return { valid: false, error: dateParseResult.error };
      }
      
      if (dateParseResult.needsClarification) {
        // Date is mentioned but too vague to parse precisely
        result.endDate = null;
        result.needsDateClarification = true;
        result.detectedDatePhrase = dateParseResult.detectedPhrase;
        result.suggestedDate = dateParseResult.suggestedDate;
        result.suggestedDateLabel = dateParseResult.suggestedLabel;
      } else if (dateParseResult.date) {
        result.endDate = dateParseResult.date;
        result.needsDateClarification = false;
      } else {
        // No date mentioned at all — must ask
        result.endDate = null;
        result.needsDateClarification = true;
        result.detectedDatePhrase = null;
        result.suggestedDate = null;
        result.suggestedDateLabel = null;
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

      // NEW: Extract initial bet amount (for create + bet in one tweet)
      // Formats: "betting 10 USDC YES", "wager: 5 USDC NO", "10 USDC on YES"
      const betAmountMatch = text.match(/(?:betting|wager|stake|put)\s*:?\s*(\d+(?:\.\d+)?)\s*(usdc|sol|eth|btc|bonk|usdt)/i) ||
                             text.match(/(\d+(?:\.\d+)?)\s*(usdc|sol|eth|btc|bonk|usdt)\s+(?:on\s+)?(yes|no)/i);

      if (betAmountMatch) {
        const requestedCurrency = betAmountMatch[2].toUpperCase();

        // Only USDC is accepted for bets
        if (requestedCurrency !== 'USDC') {
          return {
            valid: false,
            error: `AgentBets markets use USDC only. "${requestedCurrency}" is not accepted for bets. Use USDC instead.`
          };
        }

        result.initialBet = parseFloat(betAmountMatch[1]);
        result.initialCurrency = 'USDC';

        // Get outcome if present
        const outcomeMatch = text.match(/\b(yes|no)\b/i);
        if (outcomeMatch) {
          result.initialOutcome = outcomeMatch[1].toUpperCase();
        } else {
          // Default to YES if creating the market (creator believes their prediction)
          result.initialOutcome = 'YES';
        }
      }

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

  /**
   * Parse end date from tweet text
   * Returns: { date, error, needsClarification, detectedPhrase, suggestedDate }
   * 
   * Handles three cases:
   * 1. Exact date provided (e.g. "ends: 2026-03-01", "by March 1, 2026") → returns date
   * 2. Vague/relative date (e.g. "end of February", "by next month") → asks for clarification
   * 3. No date at all → asks for clarification
   */
  parseEndDate(text) {
    // 1. Try explicit/structured date formats first
    const explicitPatterns = [
      { regex: /ends?:\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/i, label: 'ends:' },
      { regex: /until\s+(\d{4}-\d{2}-\d{2})/i, label: 'until' },
      { regex: /by\s+(\w+\s+\d{1,2},?\s*\d{4})/i, label: 'by date' },
      { regex: /(\d{4}-\d{2}-\d{2})/i, label: 'ISO date' },
      // Standalone "Month Day, Year" (e.g. "February 28, 2026" or "Feb 28 2026")
      { regex: /\b((?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},?\s*\d{4})\b/i, label: 'month day year' },
    ];

    for (const { regex } of explicitPatterns) {
      const match = text.match(regex);
      if (match) {
        const parsedDate = new Date(match[1]);
        if (!isNaN(parsedDate.getTime())) {
          const now = new Date();
          if (parsedDate <= now) {
            return { error: 'End date must be in the future. Cannot create markets that have already ended.' };
          }
          if (parsedDate < new Date(now.getTime() + 10 * 60 * 1000)) {
            return { error: 'End date must be at least 10 minutes in the future.' };
          }
          return { date: parsedDate.toISOString() };
        }
      }
    }

    // 2. Detect vague/relative date references that we can't precisely parse
    // These need clarification from the agent
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                        'july', 'august', 'september', 'october', 'november', 'december'];
    const monthAbbrevs = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                          'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

    // "end of [Month]" / "end of [Month] [Year]"
    const endOfMonthMatch = text.match(/(?:end\s+of|by\s+end\s+of|by\s+the\s+end\s+of)\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?/i) ||
                            text.match(/(?:end\s+of|by\s+end\s+of|by\s+the\s+end\s+of)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\s+(\d{4}))?/i);

    if (endOfMonthMatch) {
      const monthStr = endOfMonthMatch[1].toLowerCase();
      const yearStr = endOfMonthMatch[2];
      let monthIdx = monthNames.indexOf(monthStr);
      if (monthIdx === -1) monthIdx = monthAbbrevs.indexOf(monthStr);
      const year = yearStr ? parseInt(yearStr) : (monthIdx >= currentMonth ? currentYear : currentYear + 1);

      // Last day of that month, 23:59:59 UTC
      const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59));
      const monthLabel = monthNames[monthIdx].charAt(0).toUpperCase() + monthNames[monthIdx].slice(1);

      return {
        needsClarification: true,
        detectedPhrase: endOfMonthMatch[0],
        suggestedDate: lastDay.toISOString(),
        suggestedLabel: `${monthLabel} ${lastDay.getUTCDate()}, ${year} (11:59 PM UTC)`
      };
    }

    // "by [Month]" / "in [Month]" without a specific day
    const byMonthMatch = text.match(/(?:by|in|before)\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?(?!\s+\d)/i) ||
                          text.match(/(?:by|in|before)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)(?:\s+(\d{4}))?(?!\s+\d)/i);

    if (byMonthMatch) {
      const monthStr = byMonthMatch[1].toLowerCase();
      const yearStr = byMonthMatch[2];
      let monthIdx = monthNames.indexOf(monthStr);
      if (monthIdx === -1) monthIdx = monthAbbrevs.indexOf(monthStr);
      const year = yearStr ? parseInt(yearStr) : (monthIdx >= currentMonth ? currentYear : currentYear + 1);

      // Last day of that month
      const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59));
      const monthLabel = monthNames[monthIdx].charAt(0).toUpperCase() + monthNames[monthIdx].slice(1);

      return {
        needsClarification: true,
        detectedPhrase: byMonthMatch[0],
        suggestedDate: lastDay.toISOString(),
        suggestedLabel: `${monthLabel} ${lastDay.getUTCDate()}, ${year} (11:59 PM UTC)`
      };
    }

    // "next week" / "next month" / "this week"
    const relativeMatch = text.match(/\b(next\s+week|next\s+month|this\s+week|this\s+month|tomorrow|tonight)\b/i);
    if (relativeMatch) {
      const phrase = relativeMatch[1].toLowerCase();
      let suggested;
      let label;
      if (phrase === 'tomorrow' || phrase === 'tonight') {
        suggested = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 23, 59, 59));
        label = `${suggested.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })} (11:59 PM UTC)`;
      } else if (phrase === 'this week') {
        const daysUntilSunday = 7 - now.getUTCDay();
        suggested = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilSunday, 23, 59, 59));
        label = `${suggested.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })} (11:59 PM UTC)`;
      } else if (phrase === 'next week') {
        const daysUntilNextSunday = 14 - now.getUTCDay();
        suggested = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilNextSunday, 23, 59, 59));
        label = `${suggested.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })} (11:59 PM UTC)`;
      } else if (phrase === 'this month') {
        suggested = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
        label = `${suggested.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })} (11:59 PM UTC)`;
      } else if (phrase === 'next month') {
        suggested = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, 23, 59, 59));
        label = `${suggested.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })} (11:59 PM UTC)`;
      }
      return {
        needsClarification: true,
        detectedPhrase: relativeMatch[0],
        suggestedDate: suggested?.toISOString() || null,
        suggestedLabel: label || null
      };
    }

    // 3. No date reference found at all
    return { needsClarification: true, detectedPhrase: null, suggestedDate: null, suggestedLabel: null };
  }

  /**
   * Parse a confirmation reply for a pending market creation
   * The agent can:
   *   - "confirm" / "yes" / "looks good" → use the suggested date
   *   - A specific date like "2026-02-28" or "Feb 28, 2026" → use that date
   *   - "cancel" / "no" / "nevermind" → cancel the market creation
   *   - Include a bet in the same reply: "Yes, bet $5 on YES" or "confirm, betting 10 USDC NO"
   */
  parseConfirmationReply(text) {
    const lower = text.toLowerCase().replace(/@\w+\s*/g, '').trim();

    // Check for cancellation first
    if (/\b(cancel|nevermind|never\s*mind|nah|nope|forget\s*it|stop)\b/i.test(lower)) {
      return { action: 'cancel' };
    }

    // Extract any bet intent from the reply (can be combined with confirm/date)
    const betIntent = this.extractBetIntent(text);

    // Check for explicit date in the reply
    const dateResult = this.parseEndDate(text);
    if (dateResult.date) {
      return { action: 'confirm', endDate: dateResult.date, bet: betIntent };
    }

    // Check for confirmation of the suggested date
    if (/\b(confirm|yes|yeah|yep|yup|ok|okay|sure|looks?\s*good|correct|go\s*ahead|do\s*it|lgtm|approved?|that\s*works?)\b/i.test(lower)) {
      return { action: 'confirm_suggested', bet: betIntent };
    }

    // If they provided a date that needs clarification again, pass it through
    if (dateResult.needsClarification && dateResult.suggestedDate) {
      return { 
        action: 'needs_clarification', 
        detectedPhrase: dateResult.detectedPhrase,
        suggestedDate: dateResult.suggestedDate,
        suggestedLabel: dateResult.suggestedLabel,
        bet: betIntent
      };
    }

    // Could not understand the reply
    return { action: 'unknown', bet: betIntent };
  }

  /**
   * Extract bet intent from a confirmation reply or any text
   * Matches patterns like:
   *   "bet $1 on YES", "betting 10 USDC NO", "put 5 on yes",
   *   "$1 YES", "$5 on NO", "bet 1 yes", "please bet $1 on YES"
   * Returns { amount, outcome, currency } or null if no bet detected
   */
  extractBetIntent(text) {
    const lower = text.toLowerCase();

    // Pattern 1: "bet/betting/wager/put $X on YES/NO" or "bet $X YES/NO"
    const betMatch = text.match(/(?:bet|betting|wager|put|stake)\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:usdc\s+)?(?:on\s+)?(yes|no)/i) ||
                     text.match(/(?:bet|betting|wager|put|stake)\s*(\d+(?:\.\d+)?)\s*(?:usdc\s+)?(?:on\s+)?(yes|no)/i);
    if (betMatch) {
      return {
        amount: parseFloat(betMatch[1]),
        outcome: betMatch[2].toUpperCase(),
        currency: 'USDC'
      };
    }

    // Pattern 2: "$X on YES/NO" or "$X YES/NO"
    const dollarMatch = text.match(/\$(\d+(?:\.\d+)?)\s*(?:usdc\s+)?(?:on\s+)?(yes|no)/i);
    if (dollarMatch) {
      return {
        amount: parseFloat(dollarMatch[1]),
        outcome: dollarMatch[2].toUpperCase(),
        currency: 'USDC'
      };
    }

    // Pattern 3: "X USDC on YES/NO" or "X USDC YES/NO"
    const usdcMatch = text.match(/(\d+(?:\.\d+)?)\s*usdc\s+(?:on\s+)?(yes|no)/i);
    if (usdcMatch) {
      return {
        amount: parseFloat(usdcMatch[1]),
        outcome: usdcMatch[2].toUpperCase(),
        currency: 'USDC'
      };
    }

    return null;
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
          // Validate date is in the future (at least 10 minutes)
          const now = new Date();
          const tenMinutesFromNow = new Date(now.getTime() + 10 * 60 * 1000);
          
          if (date <= now) {
            console.log(`[Parser] Rejected past date: ${date.toISOString()}`);
            return null;
          }
          
          if (date < tenMinutesFromNow) {
            console.log(`[Parser] Date too soon (< 10 min): ${date.toISOString()}`);
            return null;
          }
          
          // Ensure we return ISO format (UTC)
          return date.toISOString();
        }
      }
    }
    return null;
  }

  defaultEndDate() {
    // Default to 7 days from now in UTC
    const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
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

  /**
   * Validate that a bet has a verifiable outcome
   * Returns { verifiable, warnings[], suggestion }
   */
  validateVerifiability(betParams) {
    const result = {
      verifiable: true,
      warnings: [],
      suggestion: null
    };

    if (!betParams || !betParams.question) {
      return { verifiable: false, warnings: ['No question provided'], suggestion: null };
    }

    const question = betParams.question;
    const lower = question.toLowerCase();

    // Subjective / opinion keywords that indicate unverifiable outcomes
    const subjectivePatterns = [
      { pattern: /\b(best|worst|greatest|most important|least important)\b/i, label: 'subjective comparison' },
      { pattern: /\b(should|could|might|would|may)\s+(we|they|it|he|she)\b/i, label: 'speculative language' },
      { pattern: /\b(beautiful|ugly|amazing|terrible|awesome|awful|good|bad)\b/i, label: 'opinion-based adjective' },
      { pattern: /\b(deserve|fair|unfair|right|wrong|ethical|moral)\b/i, label: 'value judgment' },
    ];

    // Vague / unmeasurable outcome patterns
    const vaguePatterns = [
      { pattern: /\b(go mainstream|take over|dominate|revolutionize|change the world)\b/i, label: 'vague outcome' },
      { pattern: /\b(full autonomy|fully autonomous|sentient|conscious)\b/i, label: 'unmeasurable concept' },
      { pattern: /\b(moon|pump|dump|rug)\b/i, label: 'slang without threshold', needsThreshold: true },
      { pattern: /\b(succeed|fail|win)\b(?!.*\b(hackathon|contest|competition|game|match)\b)/i, label: 'vague success/failure' },
    ];

    // Check for subjective questions
    for (const { pattern, label } of subjectivePatterns) {
      if (pattern.test(question)) {
        result.warnings.push(`Question contains ${label}: not objectively verifiable`);
      }
    }

    // Check for vague outcomes
    for (const { pattern, label, needsThreshold } of vaguePatterns) {
      if (pattern.test(question)) {
        if (needsThreshold && !betParams.threshold) {
          result.warnings.push(`"${label}" needs a specific number/threshold to be verifiable`);
        } else if (!needsThreshold) {
          result.warnings.push(`Question contains ${label}: hard to verify objectively`);
        }
      }
    }

    // If resolution is manual AND there are warnings, it's unverifiable
    if (betParams.resolution === 'manual' && result.warnings.length > 0) {
      result.verifiable = false;
      result.suggestion = this.generateVerifiabilitySuggestion(question, betParams);
    }

    // Check: quantitative bets (token/price) without a threshold
    if (['dexscreener', 'coingecko', 'x-api', 'moltbook'].includes(betParams.resolution)) {
      if (!betParams.threshold && !this.hasImplicitThreshold(question)) {
        result.warnings.push(`Quantitative bet missing a threshold/target number`);
        result.verifiable = false;
        result.suggestion = this.generateThresholdSuggestion(question, betParams);
      }
    }

    return result;
  }

  /**
   * Check if the question has an implicit numeric threshold embedded in it
   */
  hasImplicitThreshold(question) {
    // Patterns like "hit $1M", "reach 10K", "above 100", "$200 price"
    return /\$[\d,.]+[KkMmBb]?|\d{2,}[KkMmBb]\b|\b\d+(?:,\d{3})+\b/.test(question);
  }

  /**
   * Generate a suggestion for making the question verifiable
   */
  generateVerifiabilitySuggestion(question, betParams) {
    const lower = question.toLowerCase();

    if (/\$[A-Z]+/i.test(question)) {
      const token = question.match(/\$([A-Z]+)/i)?.[1] || 'TOKEN';
      return `Try: "Will $${token} hit $X mcap by [date]?" with a specific number`;
    }

    if (/@\w+/.test(question)) {
      const handle = question.match(/@(\w+)/)?.[1] || 'handle';
      return `Try: "Will @${handle} reach X followers by [date]?" with a specific number`;
    }

    return `Make your bet measurable. Use a specific number/threshold that can be verified by an API (e.g., price, followers, mcap)`;
  }

  /**
   * Generate a suggestion for adding a threshold
   */
  generateThresholdSuggestion(question, betParams) {
    if (betParams.targetToken) {
      return `Add a target: "Will $${betParams.targetToken} hit $[amount] by [date]?"`;
    }
    if (betParams.targetHandle) {
      return `Add a target: "Will @${betParams.targetHandle} reach [number] followers by [date]?"`;
    }
    return `Add a measurable threshold (e.g., "$1M mcap", "10K followers", "$200 price")`;
  }
}

module.exports = BetParser;
