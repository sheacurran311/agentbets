-- Migration 007: Fix resolution source for frontend-created markets
-- Markets created via POST /api/onchain/markets were hardcoded as 'pollfun'
-- which the bot resolver doesn't handle. Update them to proper sources based on question text.

-- Moltbook-related markets (agent count, karma, molt keywords)
UPDATE markets SET resolution_source = 'moltbook'
WHERE resolution_source = 'pollfun'
  AND (question ~* 'moltbook|karma|molt');

-- X/Twitter follower markets
UPDATE markets SET resolution_source = 'x-api'
WHERE resolution_source = 'pollfun'
  AND (question ~* 'followers|following|likes|retweets|impressions');

-- Token price/mcap markets
UPDATE markets SET resolution_source = 'dexscreener'
WHERE resolution_source = 'pollfun'
  AND (question ~ '\$[A-Z]+' OR question ~* 'mcap|market cap|price');

-- GitHub markets
UPDATE markets SET resolution_source = 'github'
WHERE resolution_source = 'pollfun'
  AND (question ~* 'commit|release|deploy|ship|github');

-- Any remaining 'pollfun' markets default to manual
UPDATE markets SET resolution_source = 'manual'
WHERE resolution_source = 'pollfun';
