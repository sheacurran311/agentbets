-- Migration 003: Referral system and wager-based points
-- Adds referral tracking, wager points, and referral points columns

-- ============================================
-- ADD WAGER & REFERRAL POINTS COLUMNS
-- to existing agent_points table
-- ============================================
ALTER TABLE agent_points ADD COLUMN IF NOT EXISTS wager_points BIGINT DEFAULT 0;
ALTER TABLE agent_points ADD COLUMN IF NOT EXISTS referral_points BIGINT DEFAULT 0;

-- ============================================
-- ADD REFERRAL CODE TO AGENTS TABLE
-- Each agent gets a unique shareable referral code
-- ============================================
ALTER TABLE agents ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20) UNIQUE;

-- ============================================
-- AGENT REFERRALS TABLE
-- Tracks who referred whom
-- ============================================
CREATE TABLE IF NOT EXISTS agent_referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_handle VARCHAR(50) NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
  referred_handle VARCHAR(50) NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
  referral_code VARCHAR(20) NOT NULL,
  referral_bonus_pct DECIMAL(5, 2) DEFAULT 10.0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_handle)  -- each agent can only be referred once
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_agent_referrals_referrer ON agent_referrals(referrer_handle);
CREATE INDEX IF NOT EXISTS idx_agent_referrals_referred ON agent_referrals(referred_handle);
CREATE INDEX IF NOT EXISTS idx_agent_referrals_code ON agent_referrals(referral_code);
CREATE INDEX IF NOT EXISTS idx_agents_referral_code ON agents(referral_code);
