/**
 * LLM Intent Classifier
 *
 * Uses OpenAI gpt-4o-mini to determine whether a tweet is a genuine
 * market creation request vs. instructional, promotional, or informational content.
 *
 * Each classification costs ~$0.00005 — negligible compared to $4 in SOL rent
 * lost on every false-positive market created on-chain.
 *
 * Falls back to allowing the tweet through if OpenAI is unavailable, so the
 * existing rule-based pipeline still acts as a baseline filter.
 */

const OpenAI = require('openai');

const SYSTEM_PROMPT = `You are a classifier for AgentBets, a prediction-market platform where AI agents create markets by tweeting at @agentbetsbot.

Your job: decide whether a tweet is a GENUINE REQUEST to create a new prediction market.

A tweet IS a market request when the author is directly asking the bot to open a new bet. It must include:
- A clear, verifiable question or outcome to bet on
- The intent to actually create a market right now (not explain, not demonstrate, not promote)

A tweet is NOT a market request if it:
- Asks what AgentBets is or how it works ("What is AgentBets?", "How do I create a market?")
- Explains or demonstrates the bot for others ("Tag @agentbetsbot to create a market like this!")
- Is promotional/announcement content about AgentBets
- Is a greeting, test, or casual conversation
- Is asking about an existing market rather than creating one
- Contains instructions on how to use the bot
- Uses "create market" or "new market" only to explain the feature, not to invoke it

Examples that ARE market requests:
- "@agentbetsbot Will $SOL hit $200 by March 1? ends: 2026-03-01"
- "@agentbetsbot bet: \"Will @elonmusk tweet 50 times this week?\" ends: 2026-02-28"
- "@agentbetsbot create market: Will BTC reach $100k before April? ends: 2026-04-01"

Examples that are NOT market requests:
- "What is AgentBets? Tag @agentbetsbot to create a market!"
- "Here's how to create a market on @agentbetsbot — just tag the bot with your question"
- "Check out @agentbetsbot — you can create market predictions with it!"
- "How do you create a market? @agentbetsbot"
- "Is @agentbetsbot working?"
- "@agentbetsbot What is this?"
- "Excited to announce our new partnership with @agentbetsbot — create markets today!"

Respond with valid JSON only, no markdown:
{"isMarketRequest": true|false, "reason": "one short sentence"}`;

class IntentClassifier {
  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[Classifier] OPENAI_API_KEY not set — LLM classification disabled, falling back to rule-based only');
      this.client = null;
    } else {
      this.client = new OpenAI({ apiKey });
    }
  }

  /**
   * Classify whether a tweet is a genuine market creation request.
   *
   * @param {string} tweetText - Raw tweet text (with @mentions preserved)
   * @returns {Promise<{isMarketRequest: boolean, reason: string, skipped: boolean}>}
   *   skipped=true means OpenAI was unavailable; caller should allow through
   */
  async classify(tweetText) {
    if (!this.client) {
      return { isMarketRequest: true, reason: 'OpenAI unavailable — skipping LLM check', skipped: true };
    }

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: tweetText }
        ],
        max_tokens: 80,
        temperature: 0,
        response_format: { type: 'json_object' }
      });

      const raw = response.choices[0]?.message?.content?.trim();
      const parsed = JSON.parse(raw);

      const isMarketRequest = Boolean(parsed.isMarketRequest);
      const reason = typeof parsed.reason === 'string' ? parsed.reason : '';

      console.log(`[Classifier] isMarketRequest=${isMarketRequest} reason="${reason}"`);
      return { isMarketRequest, reason, skipped: false };
    } catch (err) {
      console.error('[Classifier] OpenAI error — allowing tweet through:', err.message);
      return { isMarketRequest: true, reason: `OpenAI error: ${err.message}`, skipped: true };
    }
  }
}

module.exports = IntentClassifier;
