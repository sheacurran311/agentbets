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
const fs = require('fs');
const path = require('path');
const { CronJob } = require('cron');
const schedule = require('node-schedule');
const TwitterService = require('./twitter');
const MoltbookService = require('./moltbook');
const BetParser = require('./parser');
const AgentVerifier = require('./verifier');
const ResolutionEngine = require('./resolver');
const AgentBetsAPI = require('./api-client');

// Database (optional - only available when running with full monorepo)
// On Railway, the bot runs standalone and uses file-based storage
let db = null;
let Resolution = null;
let ProcessedTweet = null;

try {
  // Try to load shared database (only works in monorepo environment like Replit)
  db = require('../../api/src/db');
  const models = require('../../api/src/db/models');
  Resolution = models.Resolution;
  ProcessedTweet = models.ProcessedTweet;
  console.log('[Bot] Shared database modules loaded');
} catch (err) {
  console.log('[Bot] Running standalone - using file-based storage (this is normal on Railway)');
}

const app = express();
app.use(express.json());
const PORT = process.env.BOT_PORT || 3003;

// Database connection flag
let dbConnected = false;

// Fallback file paths (used when database not available or on Railway)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const PENDING_RESOLUTIONS_FILE = path.join(DATA_DIR, 'pending-resolutions.json');
const PROCESSED_TWEETS_FILE = path.join(DATA_DIR, 'processed-tweets.json');

/**
 * Validate required environment variables
 */
function validateEnvironment() {
  const required = {
    TWITTER_BEARER_TOKEN: 'Required for X API follower verification',
    AGENTBETS_API_URL: 'Required for API communication'
  };

  const optional = {
    TWITTER_API_KEY: 'Required for posting tweets',
    TWITTER_API_SECRET: 'Required for posting tweets',
    TWITTER_ACCESS_TOKEN: 'Required for posting tweets',
    TWITTER_ACCESS_SECRET: 'Required for posting tweets',
    MOLTBOOK_API_KEY: 'Required for Moltbook agent verification',
    GITHUB_TOKEN: 'Required for GitHub-based resolution'
  };

  console.log('\n[Config] Checking environment variables...');
  
  let hasErrors = false;
  for (const [key, description] of Object.entries(required)) {
    if (!process.env[key]) {
      console.error(`[Config] ERROR: Missing required env var: ${key}`);
      console.error(`        ${description}`);
      hasErrors = true;
    } else {
      console.log(`[Config] ✓ ${key} is configured`);
    }
  }

  for (const [key, description] of Object.entries(optional)) {
    if (!process.env[key]) {
      console.warn(`[Config] WARNING: Missing optional env var: ${key}`);
      console.warn(`        ${description}`);
    } else {
      console.log(`[Config] ✓ ${key} is configured`);
    }
  }

  if (hasErrors) {
    console.error('\n[Config] Missing required environment variables!');
    console.error('[Config] For Railway: Set these in your service variables');
    console.error('[Config] For local dev: Copy .env.example to .env and fill in values\n');
  }

  return !hasErrors;
}

/**
 * Ensure data directory exists (fallback)
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[Persistence] Created data directory: ${DATA_DIR}`);
  }
}

/**
 * Load pending resolutions from database (or disk as fallback)
 */
async function loadPendingResolutions() {
  if (dbConnected) {
    try {
      const resolutions = await Resolution.getPending();
      console.log(`[Persistence] Loaded ${resolutions.length} pending resolutions from database`);
      const map = new Map();
      for (const r of resolutions) {
        map.set(r.marketId, r);
      }
      return map;
    } catch (error) {
      console.error('[Persistence] Error loading from database:', error.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(PENDING_RESOLUTIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PENDING_RESOLUTIONS_FILE, 'utf8'));
      console.log(`[Persistence] Loaded ${Object.keys(data).length} pending resolutions from disk`);
      return new Map(Object.entries(data));
    }
  } catch (error) {
    console.error('[Persistence] Error loading from disk:', error.message);
  }
  return new Map();
}

/**
 * Save pending resolutions to database (or disk as fallback)
 */
async function savePendingResolutions() {
  if (dbConnected) {
    try {
      for (const [marketId, data] of pendingResolutions) {
        await Resolution.create({ ...data, marketId });
      }
      return;
    } catch (error) {
      console.error('[Persistence] Error saving to database:', error.message);
    }
  }
  
  // Fallback to file
  try {
    ensureDataDir();
    const data = Object.fromEntries(pendingResolutions);
    fs.writeFileSync(PENDING_RESOLUTIONS_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[Persistence] Error saving to disk:', error.message);
  }
}

/**
 * Save a single pending resolution to database
 */
async function savePendingResolution(marketId, data) {
  if (dbConnected) {
    try {
      await Resolution.create({ ...data, marketId });
    } catch (error) {
      console.error('[Persistence] Error saving resolution to database:', error.message);
    }
  }
  // Always update the in-memory map
  pendingResolutions.set(marketId, data);
  
  // Also save to file as backup
  if (!dbConnected) {
    savePendingResolutions();
  }
}

/**
 * Delete a pending resolution from database
 */
async function deletePendingResolution(marketId) {
  if (dbConnected) {
    try {
      await Resolution.delete(marketId);
    } catch (error) {
      console.error('[Persistence] Error deleting resolution from database:', error.message);
    }
  }
  pendingResolutions.delete(marketId);
}

/**
 * Load processed tweets from database (or disk as fallback)
 */
async function loadProcessedTweets() {
  if (dbConnected) {
    try {
      const tweetSet = await ProcessedTweet.toSet();
      console.log(`[Persistence] Loaded ${tweetSet.size} processed tweet IDs from database`);
      return tweetSet;
    } catch (error) {
      console.error('[Persistence] Error loading tweets from database:', error.message);
    }
  }
  
  // Fallback to file
  try {
    if (fs.existsSync(PROCESSED_TWEETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROCESSED_TWEETS_FILE, 'utf8'));
      console.log(`[Persistence] Loaded ${data.length} processed tweet IDs from disk`);
      return new Set(data);
    }
  } catch (error) {
    console.error('[Persistence] Error loading tweets from disk:', error.message);
  }
  return new Set();
}

/**
 * Mark a tweet as processed
 */
async function markTweetProcessed(tweetId) {
  processedTweets.add(tweetId);
  if (dbConnected) {
    try {
      await ProcessedTweet.add(tweetId);
    } catch (error) {
      console.error('[Persistence] Error marking tweet in database:', error.message);
    }
  }
}

/**
 * Check if a tweet has been processed
 */
async function isTweetProcessed(tweetId) {
  if (processedTweets.has(tweetId)) {
    return true;
  }
  if (dbConnected) {
    try {
      return await ProcessedTweet.has(tweetId);
    } catch (error) {
      console.error('[Persistence] Error checking tweet in database:', error.message);
    }
  }
  return false;
}

/**
 * Save processed tweets to disk (keep last 10000 to prevent unbounded growth)
 */
function saveProcessedTweets() {
  if (dbConnected) {
    // Database handles this automatically
    return;
  }
  try {
    ensureDataDir();
    const tweets = Array.from(processedTweets).slice(-10000);
    fs.writeFileSync(PROCESSED_TWEETS_FILE, JSON.stringify(tweets));
  } catch (error) {
    console.error('[Persistence] Error saving tweets to disk:', error.message);
  }
}

// Initialize services
const twitter = new TwitterService();
const moltbook = new MoltbookService();
const parser = new BetParser();
const verifier = new AgentVerifier();
const resolver = new ResolutionEngine();
const agentbets = new AgentBetsAPI();

// Storage - will be initialized async on startup
let processedTweets = new Set();
let pendingResolutions = new Map();
const notifiedMarkets = new Set(); // Track which markets we've sent reminders for
const scheduledJobs = new Map(); // Track scheduled resolution jobs

/**
 * Initialize storage (database or file-based)
 */
async function initializeStorage() {
  // Try to connect to database (only if db module is available and DATABASE_URL is set)
  if (db && process.env.DATABASE_URL) {
    console.log('[Bot] Connecting to PostgreSQL...');
    try {
      const connected = await db.initDatabase();
      if (connected) {
        dbConnected = true;
        console.log('[Bot] Database connected successfully');
      } else {
        console.warn('[Bot] Database connection failed, using file-based storage');
        ensureDataDir();
      }
    } catch (dbError) {
      console.warn('[Bot] Database initialization error:', dbError.message);
      console.warn('[Bot] Falling back to file-based storage');
      ensureDataDir();
    }
  } else {
    if (!db) {
      console.log('[Bot] Running standalone (no shared database module)');
    } else {
      console.log('[Bot] DATABASE_URL not set');
    }
    console.log('[Bot] Using file-based storage');
    ensureDataDir();
  }
  
  // Load persisted data
  processedTweets = await loadProcessedTweets();
  pendingResolutions = await loadPendingResolutions();
  
  console.log(`[Bot] Loaded ${processedTweets.size} processed tweets`);
  console.log(`[Bot] Loaded ${pendingResolutions.size} pending resolutions`);
}

/**
 * Extract @handles from text (excluding the bot itself)
 */
function extractMentionedHandles(text) {
  const matches = text.match(/@(\w+)/g) || [];
  return matches
    .map(h => h.slice(1).toLowerCase()) // Remove @ and lowercase
    .filter(h => h !== 'agentbetsbot' && h !== 'agentbets'); // Exclude bot
}

/**
 * Notify agents mentioned in a market question
 */
async function notifyMentionedAgents(marketId, question, creatorHandle, marketUrl) {
  const mentionedHandles = extractMentionedHandles(question);

  if (mentionedHandles.length === 0) {
    console.log(`[Notify] No agents to notify for market ${marketId}`);
    return;
  }

  console.log(`[Notify] Notifying agents: ${mentionedHandles.join(', ')}`);

  for (const handle of mentionedHandles) {
    // Don't notify the creator (they already know)
    if (handle.toLowerCase() === creatorHandle.toLowerCase().replace('@', '')) {
      continue;
    }

    try {
      // Check if this is actually an agent (optional - could skip for speed)
      const verification = await verifier.verifyAgent(handle, null);

      const agentLabel = verification.isAgent ? '' : '';

      await twitter.tweet(
        `@${handle} A prediction market was just created about you!\n\n` +
        `"${question.slice(0, 100)}${question.length > 100 ? '...' : ''}"\n\n` +
        `Created by @${creatorHandle}\n\n` +
        `View & bet: ${marketUrl}`
      );

      console.log(`[Notify] Notified @${handle} about market ${marketId}`);

      // Rate limit: wait between tweets
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`[Notify] Failed to notify @${handle}:`, error.message);
    }
  }
}

/**
 * Send reminder for markets ending soon (within 24 hours)
 */
async function sendMarketReminders() {
  console.log(`[Reminders] Checking for markets ending soon...`);

  const now = new Date();
  const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  for (const [marketId, data] of pendingResolutions) {
    const endDate = new Date(data.endDate);
    const reminderKey = `${marketId}-24h`;

    // Skip if already notified or not within 24h window
    if (notifiedMarkets.has(reminderKey)) continue;
    if (endDate > oneDayFromNow || endDate < now) continue;

    console.log(`[Reminders] Market ${marketId} ends in <24h, sending reminder`);

    try {
      // Get current odds from API
      const market = await agentbets.getMarket(marketId);
      const yesOdds = market?.yesOdds ? `${Math.round(market.yesOdds * 100)}%` : '50%';
      const noOdds = market?.noOdds ? `${Math.round(market.noOdds * 100)}%` : '50%';

      // Extract mentioned handles for tagging
      const mentionedHandles = extractMentionedHandles(data.question);
      const tagString = mentionedHandles.slice(0, 3).map(h => `@${h}`).join(' ');

      const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
      const marketUrl = `${baseUrl}/markets/${marketId}`;

      await twitter.tweet(
        `Market ending soon! ${tagString}\n\n` +
        `"${data.question.slice(0, 80)}${data.question.length > 80 ? '...' : ''}"\n\n` +
        `Current odds: YES ${yesOdds} / NO ${noOdds}\n` +
        `Ends: ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })}\n\n` +
        `Last chance to bet: ${marketUrl}`
      );

      notifiedMarkets.add(reminderKey);
      console.log(`[Reminders] Sent reminder for market ${marketId}`);

      // Rate limit
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      console.error(`[Reminders] Failed to send reminder for ${marketId}:`, error.message);
    }
  }
}

/**
 * Schedule a market resolution at its exact end time
 * Uses node-schedule for precise timing instead of polling
 */
function scheduleMarketResolution(marketId, data) {
  const endDate = new Date(data.endDate);
  const now = new Date();

  // If already past end date, resolve immediately
  if (endDate <= now) {
    console.log(`[Scheduler] Market ${marketId} already ended, resolving immediately`);
    resolveMarket(marketId, data);
    return;
  }

  // Cancel any existing job for this market
  if (scheduledJobs.has(marketId)) {
    scheduledJobs.get(marketId).cancel();
    console.log(`[Scheduler] Cancelled existing job for market ${marketId}`);
  }

  // Schedule job at exact end time
  const job = schedule.scheduleJob(marketId, endDate, async () => {
    console.log(`[Scheduler] Executing scheduled resolution for market ${marketId}`);
    await resolveMarket(marketId, data);
    scheduledJobs.delete(marketId);
  });

  if (job) {
    scheduledJobs.set(marketId, job);
    console.log(`[Scheduler] Scheduled resolution for market ${marketId} at ${endDate.toISOString()}`);
  } else {
    console.error(`[Scheduler] Failed to schedule job for market ${marketId}`);
  }
}

/**
 * Resolve a single market - called by scheduler or polling
 */
async function resolveMarket(marketId, data) {
  // Skip if we've already proposed a resolution
  if (data.proposalStatus === 'proposed') {
    console.log(`[Resolver] Market ${marketId} already has proposal, skipping`);
    return;
  }

  console.log(`[Resolver] Resolving market ${marketId}...`);

  try {
    const result = await resolver.resolve(data);

    if (!result.resolved) {
      console.log(`[Resolver] Could not resolve market ${marketId}: ${result.error}`);
      return;
    }

    console.log(`[Resolver] Resolved: ${result.outcome} (value: ${result.actualValue})`);

    // Propose resolution on AgentBets (does NOT finalize - admin must confirm)
    const confidence = result.confidence || 90;
    const evidence = {
      source: result.source,
      actualValue: result.actualValue,
      threshold: result.threshold,
      data: result.data,
      resolvedAt: new Date().toISOString()
    };

    const proposal = await agentbets.proposeResolution(
      marketId,
      result.outcome,
      confidence,
      evidence
    );

    if (!proposal.success) {
      console.log(`[Resolver] Failed to propose resolution on API: ${proposal.error}`);
      return;
    }

    console.log(`[Resolver] Resolution proposed for market ${marketId}`);
    console.log(`[Resolver] Outcome: ${result.outcome} (confidence: ${confidence}%)`);

    // Optionally announce the proposal
    if (process.env.ANNOUNCE_PROPOSALS === 'true') {
      await announceProposal(marketId, data, result);
    }

    // Mark as proposed so we don't re-propose
    data.proposalStatus = 'proposed';
    data.proposedAt = new Date().toISOString();
    data.proposedResolution = result;
    pendingResolutions.set(marketId, data);
    savePendingResolutions();

    console.log(`[Resolver] Market ${marketId} proposal complete, awaiting admin confirmation`);

  } catch (error) {
    console.error(`[Resolver] Error resolving market ${marketId}:`, error);
  }
}

/**
 * Reschedule all pending resolutions on startup
 * This ensures we don't miss resolutions after a restart
 */
function rescheduleAllMarkets() {
  console.log(`[Scheduler] Rescheduling ${pendingResolutions.size} pending markets...`);
  
  for (const [marketId, data] of pendingResolutions) {
    if (data.proposalStatus !== 'proposed') {
      scheduleMarketResolution(marketId, data);
    }
  }
}

/**
 * Announce market resolution proposal (not final yet)
 */
async function announceProposal(marketId, data, result) {
  console.log(`[Announce] Announcing resolution proposal for market ${marketId}`);

  try {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    // Extract mentioned handles for tagging
    const mentionedHandles = extractMentionedHandles(data.question);
    const tagString = mentionedHandles.slice(0, 2).map(h => `@${h}`).join(' ');
    const creatorTag = `@${data.authorHandle}`;

    await twitter.tweet(
      `Market Ended - Resolution Pending ${tagString} ${creatorTag}\n\n` +
      `"${data.question.slice(0, 60)}${data.question.length > 60 ? '...' : ''}"\n\n` +
      `Proposed Outcome: ${result.outcome}\n` +
      `Data: ${result.actualValue}\n` +
      `Source: ${result.source || data.resolution}\n\n` +
      `Awaiting admin verification...\n` +
      `View: ${marketUrl}`
    );

    console.log(`[Announce] Proposal announced for market ${marketId}`);

    // Cross-post proposal to Moltbook
    if (moltbook.enabled) {
      try {
        await moltbook.announceProposal(marketId, data, result);
      } catch (err) {
        console.warn(`[Announce] Failed to cross-post proposal to Moltbook: ${err.message}`);
      }
    }
  } catch (error) {
    console.error(`[Announce] Failed to announce proposal:`, error.message);
  }
}

/**
 * Announce final market resolution (after admin confirmation)
 * This should be called via webhook or API when admin confirms
 */
async function announceResolution(marketId, data, result) {
  console.log(`[Announce] Announcing FINAL resolution for market ${marketId}`);

  try {
    const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${marketId}`;

    // Extract mentioned handles for tagging
    const mentionedHandles = extractMentionedHandles(data.question);
    const tagString = mentionedHandles.slice(0, 2).map(h => `@${h}`).join(' ');
    const creatorTag = `@${data.authorHandle}`;

    await twitter.tweet(
      `Market Resolved: ${result.outcome} wins! ${tagString} ${creatorTag}\n\n` +
      `"${data.question.slice(0, 60)}${data.question.length > 60 ? '...' : ''}"\n\n` +
      `Result: ${result.actualValue}\n` +
      `Source: ${result.source || data.resolution}\n\n` +
      `Winnings distributed!\n` +
      `View: ${marketUrl}`
    );

    console.log(`[Announce] Resolution announced for market ${marketId}`);

    // Cross-post resolution to Moltbook
    if (moltbook.enabled) {
      try {
        await moltbook.announceResolution(marketId, data, result);
      } catch (err) {
        console.warn(`[Announce] Failed to cross-post resolution to Moltbook: ${err.message}`);
      }
    }
  } catch (error) {
    console.error(`[Announce] Failed to announce resolution:`, error.message);
  }
}

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
    const marketData = {
      tweetId,
      authorHandle,
      question: betParams.question,
      endDate: betParams.endDate,
      resolution: betParams.resolution,
      threshold: betParams.threshold,
      targetHandle: betParams.targetHandle,
      targetToken: betParams.targetToken,
      createdAt: new Date().toISOString()
    };
    pendingResolutions.set(market.market.id, marketData);
    savePendingResolutions();

    // Schedule exact-time resolution
    scheduleMarketResolution(market.market.id, marketData);

    // Reply with success - include Blink URL for direct betting
    const baseUrl = process.env.AGENTBETS_API_URL?.replace('/api', '') || 'https://agentbets.gg';
    const marketUrl = `${baseUrl}/markets/${market.market.id}`;
    const actionUrl = `${baseUrl}/api/actions/bet/${market.market.id}`;
    const blinkUrl = `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`;

    const endDateFormatted = new Date(betParams.endDate).toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short', 
      day: 'numeric', 
      year: 'numeric'
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

    // Notify any agents mentioned in the market question
    await notifyMentionedAgents(market.market.id, betParams.question, authorHandle, marketUrl);

    // Cross-post to Moltbook if enabled
    if (moltbook.enabled) {
      try {
        await moltbook.announceMarket({
          id: market.market.id,
          question: betParams.question,
          description: `Created by @${authorHandle} via X`,
          category: betParams.category || 'general',
          endDate: betParams.endDate,
          resolutionSource: betParams.resolution,
          threshold: betParams.threshold,
          creatorAgent: `@${authorHandle}`
        });
        console.log(`[Bot] Market cross-posted to Moltbook`);
      } catch (err) {
        console.warn(`[Bot] Failed to cross-post to Moltbook: ${err.message}`);
      }
    }

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

// Track processed Moltbook post/comment IDs to avoid duplicates
const processedMoltbookItems = new Set();

/**
 * Check Moltbook for new bet requests
 * Polls the m/agentbets submolt for posts/comments containing bet syntax
 */
async function checkMoltbookRequests() {
  if (!moltbook.enabled) return;

  console.log(`[Moltbook] Checking for new bet requests...`);

  try {
    const requests = await moltbook.checkForBetRequests();

    if (!requests || requests.length === 0) {
      console.log(`[Moltbook] No new bet requests`);
      return;
    }

    console.log(`[Moltbook] Found ${requests.length} potential bet requests`);

    for (const request of requests) {
      // Skip if already processed
      const itemKey = `${request.type}_${request.id}`;
      if (processedMoltbookItems.has(itemKey)) continue;
      processedMoltbookItems.add(itemKey);

      console.log(`[Moltbook] Processing ${request.type} from ${request.author}: ${request.text.slice(0, 80)}...`);

      try {
        // Parse the bet request using the same parser as Twitter
        if (!parser.isBetRequest(request.text)) {
          console.log(`[Moltbook] Not a valid bet request, skipping`);
          continue;
        }

        const betParams = parser.parseBet(request.text);
        if (!betParams.valid) {
          console.log(`[Moltbook] Invalid bet format: ${betParams.error}`);
          await moltbook.replyToRequest(request, {
            success: false,
            error: `Invalid bet format: ${betParams.error}. Use: bet: "Your question?" ends: YYYY-MM-DD resolution: dexscreener|x-api|moltbook|manual`
          });
          continue;
        }

        // Create market via AgentBets API
        const market = await agentbets.createMarket({
          question: betParams.question,
          description: `Created by ${request.author} via Moltbook`,
          category: betParams.category || 'general',
          endDate: betParams.endDate,
          resolutionSource: betParams.resolution,
          threshold: betParams.threshold,
          verificationMethod: `Auto-resolved via ${betParams.resolution} API`,
          creatorAgent: request.author,
          tags: ['moltbook-created', request.author, betParams.resolution]
        });

        if (market.success) {
          console.log(`[Moltbook] Market created: ${market.market.id} by ${request.author}`);

          // Track for auto-resolution
          const marketData = {
            moltbookItemId: request.id,
            authorHandle: request.author,
            question: betParams.question,
            endDate: betParams.endDate,
            resolution: betParams.resolution,
            threshold: betParams.threshold,
            targetHandle: betParams.targetHandle,
            targetToken: betParams.targetToken,
            createdAt: new Date().toISOString(),
            platform: 'moltbook'
          };
          pendingResolutions.set(market.market.id, marketData);
          savePendingResolutions();

          // Schedule resolution
          scheduleMarketResolution(market.market.id, marketData);

          // Cross-post to Twitter if available
          if (twitter.writeClient || twitter.infshAvailable) {
            const baseUrl = process.env.AGENTBETS_URL || 'https://agentbets.gg';
            const actionUrl = `${baseUrl}/api/actions/bet/${market.market.id}`;
            const blinkUrl = `https://dial.to/?action=${encodeURIComponent(`solana-action:${actionUrl}`)}`;
            await twitter.tweet(
              `New bet from Moltbook agent ${request.author}!\n\n` +
              `"${betParams.question.slice(0, 80)}"\n\n` +
              `Bet now: ${blinkUrl}`
            );
          }
        }

        // Reply on Moltbook
        await moltbook.replyToRequest(request, market);

      } catch (err) {
        console.error(`[Moltbook] Error processing request from ${request.author}:`, err.message);
      }
    }
  } catch (error) {
    console.error(`[Moltbook] Error checking requests:`, error);
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
 * Check and resolve ended markets (fallback for missed scheduled jobs)
 * Primary resolution happens via node-schedule at exact end times
 * This runs every minute as a safety net
 */
async function checkResolutions() {
  console.log(`[Resolver] Fallback check for markets to resolve...`);

  const now = new Date();
  let resolvedCount = 0;

  for (const [marketId, data] of pendingResolutions) {
    const endDate = new Date(data.endDate);

    // Skip if not ended yet
    if (now < endDate) {
      continue;
    }

    // Skip if we've already proposed a resolution
    if (data.proposalStatus === 'proposed') {
      continue;
    }

    // Check if there's already a scheduled job for this market
    // If so, the scheduled job should handle it
    if (scheduledJobs.has(marketId)) {
      console.log(`[Resolver] Market ${marketId} has scheduled job, skipping fallback`);
      continue;
    }

    // No scheduled job and market has ended - resolve now
    console.log(`[Resolver] Market ${marketId} missed scheduled resolution, resolving via fallback...`);
    await resolveMarket(marketId, data);
    resolvedCount++;
  }

  if (resolvedCount > 0) {
    console.log(`[Resolver] Fallback resolved ${resolvedCount} markets`);
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

app.post('/check-moltbook', async (req, res) => {
  await checkMoltbookRequests();
  res.json({ success: true, message: 'Checked Moltbook requests', enabled: moltbook.enabled });
});

app.post('/resolve', async (req, res) => {
  await checkResolutions();
  res.json({ success: true, message: 'Checked resolutions' });
});

/**
 * Webhook endpoint for admin confirmations
 * Called by API server when admin confirms a resolution
 */
app.post('/webhook/resolution-confirmed', async (req, res) => {
  const { marketId, outcome, actualValue, source, data: marketData } = req.body;

  console.log(`[Webhook] Received resolution confirmation for market ${marketId}`);

  // Get market data from our tracking
  const trackedData = pendingResolutions.get(marketId);

  if (!trackedData) {
    console.log(`[Webhook] Market ${marketId} not found in pending resolutions`);
    return res.json({ success: false, error: 'Market not found in tracking' });
  }

  // Announce final resolution
  const result = trackedData.proposedResolution || {
    outcome,
    actualValue,
    source
  };

  await announceResolution(marketId, trackedData, result);

  // Remove from pending and cancel any scheduled job
  pendingResolutions.delete(marketId);
  savePendingResolutions();
  
  if (scheduledJobs.has(marketId)) {
    scheduledJobs.get(marketId).cancel();
    scheduledJobs.delete(marketId);
  }

  console.log(`[Webhook] Market ${marketId} final resolution announced`);

  res.json({ success: true, message: 'Resolution announced' });
});

// Start server with async initialization
async function startBot() {
  try {
    // Initialize storage (database or file-based)
    await initializeStorage();
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║           AgentBets Bot Running                           ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                ║
║  Mode: ${process.env.NODE_ENV || 'development'}                                      ║
║  Storage: ${dbConnected ? 'PostgreSQL' : 'File-based'}                                ║
║  X/Twitter: ${process.env.TWITTER_BEARER_TOKEN ? 'Enabled' : 'Disabled'}                                    ║
║  Moltbook: ${moltbook.enabled ? 'Enabled ' : 'Disabled'}                                    ║
║                                                           ║
║  Prediction markets via X/Twitter & Moltbook              ║
║  Built by Butters (@AIButters)                            ║
╚═══════════════════════════════════════════════════════════╝
      `);

      // Validate environment variables
      const envValid = validateEnvironment();

      // Reschedule all pending market resolutions from persistence
      rescheduleAllMarkets();
      console.log(`[Bot] Scheduled ${scheduledJobs.size} market resolutions at exact end times`);

      // Initialize Moltbook if configured (async, fire-and-forget from listen callback)
      if (moltbook.enabled) {
        (async () => {
          try {
            const meResult = await moltbook.getMe();
            if (meResult.success) {
              console.log(`[Moltbook] Authenticated as: ${moltbook.botName}`);
            } else {
              console.warn(`[Moltbook] Could not verify identity: ${meResult.error}`);
            }

            // Ensure m/agentbets submolt exists
            await moltbook.ensureSubmolt();

            // Poll Moltbook for bet requests every 3 minutes
            const moltbookJob = new CronJob('*/3 * * * *', checkMoltbookRequests);
            moltbookJob.start();

            // Initial Moltbook check on startup (after 10s to avoid rate limits)
            setTimeout(checkMoltbookRequests, 10000);

            console.log('[Moltbook] Polling started (every 3 minutes)');
          } catch (err) {
            console.warn(`[Moltbook] Initialization error: ${err.message}`);
            console.warn('[Moltbook] Moltbook features will be limited');
          }
        })();
      }

      // Initial check
      if (process.env.TWITTER_BEARER_TOKEN) {
        console.log('[Bot] Twitter credentials configured, starting polling...');

        // Check mentions every 2 minutes
        const mentionJob = new CronJob('*/2 * * * *', checkMentions);
        mentionJob.start();

        // Check resolutions every minute (fallback for missed scheduled jobs)
        // Primary resolution happens via node-schedule at exact end times
        const resolveJob = new CronJob('* * * * *', checkResolutions);
        resolveJob.start();

        // Send market reminders every hour (for markets ending within 24h)
        const reminderJob = new CronJob('0 * * * *', sendMarketReminders);
        reminderJob.start();

        // Save processed tweets periodically (every 5 minutes) - only for file-based
        if (!dbConnected) {
          const saveJob = new CronJob('*/5 * * * *', () => {
            saveProcessedTweets();
          });
          saveJob.start();
        }

        // Initial check on startup
        setTimeout(checkMentions, 5000);
      } else {
        console.log('[Bot] No Twitter credentials - running in demo mode');
        console.log('[Bot] Set TWITTER_BEARER_TOKEN to enable Twitter integration');
        
        if (!envValid) {
          console.error('[Bot] WARNING: Missing required environment variables for follower verification!');
          console.error('[Bot] Bets requiring X API verification will fail to resolve.');
        }
      }
    });
  } catch (error) {
    console.error('[Bot] Failed to start:', error);
    process.exit(1);
  }
}

// Start the bot
startBot();

// Graceful shutdown - save state before exit
process.on('SIGTERM', async () => {
  console.log('[Bot] Received SIGTERM, saving state...');
  await savePendingResolutions();
  saveProcessedTweets();
  
  // Cancel all scheduled jobs
  for (const [marketId, job] of scheduledJobs) {
    job.cancel();
  }
  
  // Close database connection
  if (dbConnected && db && db.closePool) {
    await db.closePool();
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Bot] Received SIGINT, saving state...');
  await savePendingResolutions();
  saveProcessedTweets();
  
  // Cancel all scheduled jobs
  for (const [marketId, job] of scheduledJobs) {
    job.cancel();
  }
  
  // Close database connection
  if (dbConnected && db && db.closePool) {
    await db.closePool();
  }
  
  process.exit(0);
});

module.exports = app;
