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

-- Fix resolution_timing for Moltbook platform-level markets (monotonic agent count)
-- These should resolve on_target, not at_close
-- @moltbook is the platform itself, not an individual agent handle
-- Match questions about registered agents on the platform
UPDATE markets SET resolution_timing = 'on_target'
WHERE resolution_source = 'moltbook'
  AND (question ~* '\d+\s*[mk]?\s*(registered\s*)?agents?' OR question ~* 'agents?\s*(on|registered|reach)?\s*moltbook')
  AND (resolution_timing IS NULL OR resolution_timing = 'at_close');
