/**
 * AgentBets X Bot
 *
 * Allows AI agents on X/Twitter to create prediction markets
 * Only verified agent accounts can create bets
 * Auto-resolves markets using API data
 *
 * Built by Butters (@AIButters) for Colosseum Agent Hackathon
 */

require('dotenv').config();
const express = require('express');
const { CronJob } = require('cron');
const TwitterService = require('./twitter');
const BetParser = require('./parser');
const AgentVerifier = require('./verifier');
const ResolutionEngine = require('./resolver');
const AgentBetsAPI = require('./api-client');

const app = express();
const PORT = process.env.BOT_PORT || 3003;

// Initialize services
const twitter = new TwitterService();
const parser = new BetParser();
const verifier = new AgentVerifier();
const resolver = new ResolutionEngine();
const agentbets = new AgentBetsAPI();

// In-memory tracking (would use DB in production)
const processedTweets = new Set();
const pendingResolutions = new Map();

/**
 * Process a mention tweet
 */
async function processMention(tweet) {
  const tweetId = tweet.id;
  const authorId = tweet.author_id;
  const text = tweet.text;

  // Skip if already processed
  if (processedTweets.has(tweetId)) {
    return;
  }
  processedTweets.add(tweetId);

  console.log(`[Bot] Processing tweet ${tweetId} from ${authorId}`);
  console.log(`[Bot] Text: ${text}`);

  try {
    // Get author info
    const authorInfo = await twitter.getUser(authorId);
    const authorHandle = authorInfo.username;

    console.log(`[Bot] Author: @${authorHandle}`);

    // Check if this is a bot command (balance, withdraw, help, stats)
    if (parser.isCommand(text)) {
      await processCommand(tweetId, authorHandle, text);
      return;
    }

    // Check if this is a bet creation request
    if (!parser.isBetRequest(text)) {
      console.log(`[Bot] Not a bet request, skipping`);
      return;
    }

    // Verify the author is a verified agent
    const verification = await verifier.verifyAgent(authorHandle, authorId);

    if (!verification.isAgent) {
      console.log(`[Bot] @${authorHandle} is not a verified agent: ${verification.reason}`);
      await twitter.reply(tweetId,
        `Sorry @${authorHandle}, only verified AI agents can create bets on AgentBets.\n\n` +
        `To become a verified agent:\n` +
        `1. Set your account to "Automated" in X settings\n` +
        `2. Register on Moltbook\n` +
        `3. Try again!`
      );
      return;
    }

    console.log(`[Bot] Verified agent: ${verification.agentType}`);

    // Parse the bet parameters
    const betParams = parser.parseBet(text);

    if (!betParams.valid) {
      console.log(`[Bot] Invalid bet format: ${betParams.error}`);
      await twitter.reply(tweetId,
        `@${authorHandle} I couldn't parse your bet. Please use this format:\n\n` +
        `@AgentBetsBot bet: "Your question here?"\n` +
        `ends: YYYY-MM-DD\n` +
        `resolution: dexscreener|x-api|moltbook|manual\n` +
        `threshold: [optional value]`
      );
      return;
    }

    console.log(`[Bot] Parsed bet:`, betParams);

    // Create market on AgentBets
    // If agent included initial bet, use create-and-bet endpoint
    const hasInitialBet = betParams.initialBet && betParams.initialBet > 0;

    let market;
    if (hasInitialBet) {
      // Use create-and-bet endpoint (requires x402 payment)
      console.log(`[Bot] Agent wants to create market with initial bet: ${betParams.initialBet} ${betParams.initialCurrency} ${betParams.initialOutcome}`);

      // For now, create market without the bet (x402 payment would need to come from agent's wallet)
      // The agent will need to follow up with x402 payment to place the bet
      market = await agentbets.createMarket({
        question: betParams.question,
        description: `Created by @${authorHandle} via AgentBets Bot`,
        category: betParams.category || 'general',
        endDate: betParams.endDate,
        resolutionSource: betParams.resolution,
        threshold: betParams.threshold,
        verificationMethod: `Auto-resolved via ${betParams.resolution} API`,
        creatorAgent: `@${authorHandle}`,
        tags: ['agent-created', authorHandle, betParams.resolution],
        // Include initial bet info for the reply
        requestedInitialBet: {
          amount: betParams.initialBet,
          currency: betParams.initialCurrency,
          outcome: betParams.initialOutcome
        }
      });
    } else {
      market = await agentbets.createMarket({
        question: betParams.question,
        description: `Created by @${authorHandle} via AgentBets Bot`,
        category: betParams.category || 'general',
        endDate: betParams.endDate,
        resolutionSource: betParams.resolution,
        threshold: betParams.threshold,
        verificationMethod: `Auto-resolved via ${betParams.resolution} API`,
        creatorAgent: `@${authorHandle}`,
        tags: ['agent-created', authorHandle, betParams.resolution]
      });
    }

    if (!market.success) {
      console.log(`[Bot] Failed to create market: ${market.error}`);
      await twitter.reply(tweetId,
        `@${authorHandle} Sorry, I couldn't create your bet: ${market.error}`
      );
      return;
    }

    console.log(`[Bot] Market created: ${market.market.id}`);

    // Track for auto-resolution
    pendingResolutions.set(market.market.id, {
      tweetId,
      authorHandle,
      question: betParams.question,
      endDate: betParams.endDate,
      resolution: betParams.resolution,
      threshold: betParams.threshold,
      targetHandle: betParams.targetHandle,
      targetToken: betParams.targetToken
    });

    // Reply with success - include Blink URL for direct betting
    const baseUrl = process.env.AGENTBETS_API_URL?.replace('/api', '') || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${market.market.id}`;
    const actionUrl = `${baseUrl}/api/actions/bet/${market.market.id}`;
    const blinkUrl = `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`;

    const endDateFormatted = new Date(betParams.endDate).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    // Build reply message
    let replyMessage = `New bet created by @${authorHandle}!\n\n` +
      `"${betParams.question}"\n\n` +
      `Ends: ${endDateFormatted}\n` +
      `Resolution: ${betParams.resolution}\n\n`;

    // If agent requested initial bet, include x402 payment instructions
    if (hasInitialBet) {
      replyMessage += `To place your ${betParams.initialBet} ${betParams.initialCurrency} ${betParams.initialOutcome} bet:\n` +
        `POST ${baseUrl}/api/agent/bet/${market.market.id}\n\n`;
    }

    replyMessage += `Bet now: ${blinkUrl}`;

    // Post reply with Blink URL for in-feed betting
    await twitter.reply(tweetId, replyMessage);

    console.log(`[Bot] Successfully created and announced market`);

  } catch (error) {
    console.error(`[Bot] Error processing tweet:`, error);
  }
}

/**
 * Process bot commands (balance, withdraw, help, stats)
 */
async function processCommand(tweetId, authorHandle, text) {
  const command = parser.parseCommand(text);
  console.log(`[Bot] Processing command: ${command.command} from @${authorHandle}`);

  try {
    switch (command.command) {
      case 'balance': {
        // Get agent's royalty balance
        const balance = await agentbets.getRoyalties(authorHandle);

        if (!balance.found) {
          await twitter.reply(tweetId,
            `@${authorHandle} No royalties found yet!\n\n` +
            `Create markets to start earning. You'll get 0.3% of all winning payouts from your markets.`
          );
        } else {
          await twitter.reply(tweetId,
            `@${authorHandle} Your AgentBets Royalties:\n\n` +
            `Earned: ${balance.earnedSOL.toFixed(4)} SOL\n` +
            `Pending: ${balance.pendingSOL.toFixed(4)} SOL\n` +
            `Withdrawn: ${balance.withdrawnSOL.toFixed(4)} SOL\n` +
            `Markets Created: ${balance.marketsCreated}\n\n` +
            `${balance.canWithdraw ? 'Reply "withdraw" to claim!' : `Min withdrawal: ${balance.minWithdrawalSOL} SOL`}`
          );
        }
        break;
      }

      case 'withdraw': {
        // Check if they provided a wallet
        if (command.wallet) {
          // Register wallet first
          await agentbets.registerRoyaltyWallet(authorHandle, command.wallet);
        }

        // Process withdrawal
        const result = await agentbets.withdrawRoyalties(authorHandle);

        if (!result.success) {
          await twitter.reply(tweetId,
            `@${authorHandle} Withdrawal failed: ${result.error}\n\n` +
            `Include your wallet: "@AgentBetsBot withdraw [YOUR_WALLET]"`
          );
        } else {
          await twitter.reply(tweetId,
            `@${authorHandle} Withdrawal successful!\n\n` +
            `Amount: ${result.amountSOL.toFixed(4)} SOL\n` +
            `Wallet: ${result.wallet.slice(0, 8)}...\n` +
            `Tx: ${result.signature?.slice(0, 8) || 'pending'}...`
          );
        }
        break;
      }

      case 'help': {
        await twitter.reply(tweetId,
          `@${authorHandle} AgentBets Commands:\n\n` +
          `Create bet:\n` +
          `@AgentBetsBot "Question?" ends: YYYY-MM-DD\n\n` +
          `Check balance:\n` +
          `@AgentBetsBot balance\n\n` +
          `Withdraw:\n` +
          `@AgentBetsBot withdraw [wallet]\n\n` +
          `Users bet via Blinks right in their feed!\n` +
          `Earn 0.3% royalties on all winning payouts!`
        );
        break;
      }

      case 'stats': {
        const stats = await agentbets.getStats();
        await twitter.reply(tweetId,
          `@${authorHandle} AgentBets Stats:\n\n` +
          `Markets: ${stats?.markets?.total || 0}\n` +
          `Total Bets: ${stats?.bets?.total || 0}\n` +
          `Volume: ${stats?.bets?.totalVolume?.toFixed(2) || 0} SOL\n\n` +
          `Create markets to earn royalties!`
        );
        break;
      }

      case 'bet': {
        // Agent wants to place a bet on an existing market
        // Format: @AgentBetsBot bet 10 USDC YES on market abc123
        const betParams = command;

        if (!betParams.valid) {
          await twitter.reply(tweetId,
            `@${authorHandle} ${betParams.error}\n\n` +
            `Format: @AgentBetsBot bet [amount] USDC [YES/NO] on market [ID]\n\n` +
            `Example: @AgentBetsBot bet 10 USDC YES on market abc123`
          );
          break;
        }

        // Find market by ID or question
        let marketId = betParams.marketId;
        if (!marketId && betParams.marketQuestion) {
          // Search for market by question (would need API endpoint)
          await twitter.reply(tweetId,
            `@${authorHandle} Please specify the market ID.\n\n` +
            `Format: @AgentBetsBot bet 10 USDC YES on market [ID]\n\n` +
            `Find market IDs at agentbets.gg/markets`
          );
          break;
        }

        // Reply with x402 payment instructions
        const baseUrl = process.env.AGENTBETS_API_URL?.replace('/api', '') || 'https://agentbets.gg';

        await twitter.reply(tweetId,
          `@${authorHandle} To place this bet programmatically:\n\n` +
          `POST ${baseUrl}/api/agent/bet/${marketId}\n` +
          `Body: { outcome: "${betParams.outcome}", amount: ${betParams.amount}, agentHandle: "${authorHandle}" }\n\n` +
          `Use x402 payment (USDC on Base).\n` +
          `Docs: agentbets.gg/docs/agent-api\n\n` +
          `Or bet via Blink: ${baseUrl}/api/actions/bet/${marketId}`
        );
        break;
      }

      default:
        console.log(`[Bot] Unknown command: ${command.command}`);
    }
  } catch (error) {
    console.error(`[Bot] Error processing command:`, error);
    await twitter.reply(tweetId,
      `@${authorHandle} Sorry, there was an error processing your request.`
    );
  }
}

/**
 * Check for new mentions
 */
async function checkMentions() {
  console.log(`[Bot] Checking for new mentions...`);

  try {
    const mentions = await twitter.getMentions();

    if (!mentions || mentions.length === 0) {
      console.log(`[Bot] No new mentions`);
      return;
    }

    console.log(`[Bot] Found ${mentions.length} mentions`);

    for (const tweet of mentions) {
      await processMention(tweet);
    }
  } catch (error) {
    console.error(`[Bot] Error checking mentions:`, error);
  }
}

/**
 * Check and resolve ended markets
 */
async function checkResolutions() {
  console.log(`[Resolver] Checking for markets to resolve...`);

  const now = new Date();

  for (const [marketId, data] of pendingResolutions) {
    const endDate = new Date(data.endDate);

    if (now < endDate) {
      continue; // Not ended yet
    }

    console.log(`[Resolver] Market ${marketId} has ended, checking resolution...`);

    try {
      const result = await resolver.resolve(data);

      if (!result.resolved) {
        console.log(`[Resolver] Could not resolve: ${result.error}`);
        continue;
      }

      console.log(`[Resolver] Resolved: ${result.outcome} (value: ${result.actualValue})`);

      // Resolve market on AgentBets
      const resolution = await agentbets.resolveMarket(marketId, result.outcome);

      if (!resolution.success) {
        console.log(`[Resolver] Failed to resolve on API: ${resolution.error}`);
        continue;
      }

      // Tweet the resolution
      const marketUrl = `${process.env.AGENTBETS_URL || 'https://agentbets.gg'}/markets/${marketId}`;

      await twitter.tweet(
        `Market Resolved: ${result.outcome}\n\n` +
        `"${data.question}"\n\n` +
        `Result: ${result.actualValue}\n` +
        `Threshold: ${data.threshold || 'N/A'}\n\n` +
        `Created by @${data.authorHandle}\n\n` +
        `View results: ${marketUrl}`
      );

      // Remove from pending
      pendingResolutions.delete(marketId);

      console.log(`[Resolver] Market ${marketId} resolved and announced`);

    } catch (error) {
      console.error(`[Resolver] Error resolving market ${marketId}:`, error);
    }
  }
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'AgentBets X Bot',
    version: '1.0.0',
    processedTweets: processedTweets.size,
    pendingResolutions: pendingResolutions.size,
    uptime: process.uptime()
  });
});

/**
 * Stats endpoint
 */
app.get('/stats', (req, res) => {
  res.json({
    processedTweets: processedTweets.size,
    pendingResolutions: Array.from(pendingResolutions.entries()).map(([id, data]) => ({
      marketId: id,
      question: data.question,
      endDate: data.endDate,
      author: data.authorHandle
    }))
  });
});

/**
 * Manual trigger for testing
 */
app.post('/check', async (req, res) => {
  await checkMentions();
  res.json({ success: true, message: 'Checked mentions' });
});

app.post('/resolve', async (req, res) => {
  await checkResolutions();
  res.json({ success: true, message: 'Checked resolutions' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           AgentBets X Bot Running                         ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                ║
║  Mode: ${process.env.NODE_ENV || 'development'}                                      ║
║                                                           ║
║  Agent-created prediction markets via X/Twitter           ║
║  Built by Butters (@AIButters)                           ║
╚═══════════════════════════════════════════════════════════╝
  `);

  // Initial check
  if (process.env.TWITTER_BEARER_TOKEN) {
    console.log('[Bot] Twitter credentials configured, starting polling...');

    // Check mentions every 2 minutes
    const mentionJob = new CronJob('*/2 * * * *', checkMentions);
    mentionJob.start();

    // Check resolutions every 15 minutes
    const resolveJob = new CronJob('*/15 * * * *', checkResolutions);
    resolveJob.start();

    // Initial check on startup
    setTimeout(checkMentions, 5000);
  } else {
    console.log('[Bot] No Twitter credentials - running in demo mode');
    console.log('[Bot] Set TWITTER_BEARER_TOKEN to enable Twitter integration');
  }
});

module.exports = app;
