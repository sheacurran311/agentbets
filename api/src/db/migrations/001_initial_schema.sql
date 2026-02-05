-- AgentBets Database Schema
-- Initial migration: Create all tables

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- MARKETS TABLE
-- Core prediction markets
-- ============================================
CREATE TABLE IF NOT EXISTS markets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  question TEXT NOT NULL,
  description TEXT,
  category VARCHAR(50) DEFAULT 'general',
  status VARCHAR(30) DEFAULT 'active' CHECK (status IN ('active', 'pending_confirmation', 'resolved', 'cancelled')),
  resolution VARCHAR(10) CHECK (resolution IN ('YES', 'NO', NULL)),
  resolution_source VARCHAR(30) DEFAULT 'manual',
  end_date TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  creator_wallet VARCHAR(64),
  creator_agent VARCHAR(50),
  resolver_wallet VARCHAR(64),
  admin_notes TEXT,
  confirmed_by VARCHAR(50),
  
  -- Pool tracking (in lamports for SOL, or smallest unit for USDC)
  yes_pool BIGINT DEFAULT 0,
  no_pool BIGINT DEFAULT 0,
  total_volume BIGINT DEFAULT 0,
  total_bets INTEGER DEFAULT 0,
  
  -- Calculated odds
  yes_odds DECIMAL(10, 6) DEFAULT 2.0,
  no_odds DECIMAL(10, 6) DEFAULT 2.0,
  
  -- Resolution/verification fields
  threshold VARCHAR(100),
  token_id VARCHAR(100),
  token_symbol VARCHAR(20),
  verification_url TEXT,
  verification_method TEXT,
  
  -- On-chain fields (for Poll.fun markets)
  bet_pda VARCHAR(64),
  on_chain BOOLEAN DEFAULT FALSE,
  tx_signature VARCHAR(128),
  currency VARCHAR(10) DEFAULT 'SOL',
  on_chain_resolution_tx VARCHAR(128),
  settlement_status VARCHAR(20),
  settled_at TIMESTAMPTZ,
  
  -- Two-phase resolution
  proposed_resolution JSONB,
  resolution_evidence JSONB,
  
  -- Metadata
  tags TEXT[] DEFAULT '{}',
  proposer_wallet VARCHAR(64)
);

-- ============================================
-- BETS TABLE
-- Individual bets placed by users
-- ============================================
CREATE TABLE IF NOT EXISTS bets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  wallet VARCHAR(64) NOT NULL,
  outcome VARCHAR(10) NOT NULL CHECK (outcome IN ('YES', 'NO')),
  amount BIGINT NOT NULL,
  amount_sol DECIMAL(20, 9),
  amount_usdc DECIMAL(20, 6),
  currency VARCHAR(10) DEFAULT 'SOL',
  status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'won', 'lost', 'claimed')),
  source VARCHAR(20) DEFAULT 'api',
  tx_signature VARCHAR(128),
  bet_pda VARCHAR(64),
  on_chain BOOLEAN DEFAULT FALSE,
  agent_handle VARCHAR(50),
  placed_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- x402 payment fields
  x402_signature VARCHAR(64),
  payment_network VARCHAR(50)
);

-- ============================================
-- AGENTS TABLE
-- Verified AI agents
-- ============================================
CREATE TABLE IF NOT EXISTS agents (
  handle VARCHAR(50) PRIMARY KEY,
  wallet VARCHAR(64),
  verification_method VARCHAR(30) DEFAULT 'whitelisted',
  is_verified BOOLEAN DEFAULT TRUE,
  moltbook_data JSONB,
  bio TEXT,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  last_verified TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AGENT ROYALTIES TABLE
-- Agent earnings tracking
-- ============================================
CREATE TABLE IF NOT EXISTS agent_royalties (
  agent_handle VARCHAR(50) PRIMARY KEY REFERENCES agents(handle) ON DELETE CASCADE,
  earned BIGINT DEFAULT 0,
  withdrawn BIGINT DEFAULT 0,
  pending BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AGENT POINTS TABLE
-- Agent points/leaderboard
-- ============================================
CREATE TABLE IF NOT EXISTS agent_points (
  agent_handle VARCHAR(50) PRIMARY KEY REFERENCES agents(handle) ON DELETE CASCADE,
  total_points BIGINT DEFAULT 0,
  market_creation_points BIGINT DEFAULT 0,
  market_volume_points BIGINT DEFAULT 0,
  prediction_points BIGINT DEFAULT 0,
  bonus_points BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ROYALTY TRANSACTIONS TABLE
-- Withdrawal and earning history
-- ============================================
CREATE TABLE IF NOT EXISTS royalty_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_handle VARCHAR(50) NOT NULL REFERENCES agents(handle) ON DELETE CASCADE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('earning', 'withdrawal')),
  amount BIGINT NOT NULL,
  tx_signature VARCHAR(128),
  market_id UUID REFERENCES markets(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ODDS HISTORY TABLE
-- Historical odds snapshots for charts
-- ============================================
CREATE TABLE IF NOT EXISTS odds_history (
  id SERIAL PRIMARY KEY,
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  yes_odds DECIMAL(10, 6),
  no_odds DECIMAL(10, 6),
  yes_pool BIGINT,
  no_pool BIGINT,
  total_volume BIGINT,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PENDING RESOLUTIONS TABLE
-- Bot resolution tracking
-- ============================================
CREATE TABLE IF NOT EXISTS pending_resolutions (
  market_id UUID PRIMARY KEY REFERENCES markets(id) ON DELETE CASCADE,
  tweet_id VARCHAR(30),
  author_handle VARCHAR(50),
  question TEXT,
  end_date TIMESTAMPTZ,
  resolution_source VARCHAR(30),
  threshold VARCHAR(100),
  target_handle VARCHAR(50),
  target_token VARCHAR(20),
  proposal_status VARCHAR(20),
  proposed_at TIMESTAMPTZ,
  proposed_resolution JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- PROCESSED TWEETS TABLE
-- Tweet deduplication for bot
-- ============================================
CREATE TABLE IF NOT EXISTS processed_tweets (
  tweet_id VARCHAR(30) PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ESCROW TRANSACTIONS TABLE
-- Payment tracking
-- ============================================
CREATE TABLE IF NOT EXISTS escrow_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tx_signature VARCHAR(128) UNIQUE,
  type VARCHAR(20) NOT NULL CHECK (type IN ('deposit', 'payout', 'withdrawal')),
  from_wallet VARCHAR(64),
  to_wallet VARCHAR(64),
  amount BIGINT NOT NULL,
  market_id UUID REFERENCES markets(id) ON DELETE SET NULL,
  bet_id UUID REFERENCES bets(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- POSITIONS TABLE (Materialized View Alternative)
-- Aggregated user positions per market
-- ============================================
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet VARCHAR(64) NOT NULL,
  market_id UUID NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
  outcome VARCHAR(10) NOT NULL CHECK (outcome IN ('YES', 'NO')),
  total_amount BIGINT DEFAULT 0,
  bet_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(wallet, market_id, outcome)
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- Bets indexes
CREATE INDEX IF NOT EXISTS idx_bets_market_id ON bets(market_id);
CREATE INDEX IF NOT EXISTS idx_bets_wallet ON bets(wallet);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE INDEX IF NOT EXISTS idx_bets_placed_at ON bets(placed_at);

-- Markets indexes
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);
CREATE INDEX IF NOT EXISTS idx_markets_end_date ON markets(end_date);
CREATE INDEX IF NOT EXISTS idx_markets_creator_agent ON markets(creator_agent);
CREATE INDEX IF NOT EXISTS idx_markets_created_at ON markets(created_at);
CREATE INDEX IF NOT EXISTS idx_markets_category ON markets(category);

-- Pending resolutions indexes
CREATE INDEX IF NOT EXISTS idx_pending_resolutions_end_date ON pending_resolutions(end_date);
CREATE INDEX IF NOT EXISTS idx_pending_resolutions_status ON pending_resolutions(proposal_status);

-- Odds history indexes (time-series optimization)
CREATE INDEX IF NOT EXISTS idx_odds_history_market_time ON odds_history(market_id, recorded_at);

-- Positions indexes
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet);
CREATE INDEX IF NOT EXISTS idx_positions_market_id ON positions(market_id);

-- Processed tweets index for cleanup
CREATE INDEX IF NOT EXISTS idx_processed_tweets_at ON processed_tweets(processed_at);

-- Royalty transactions
CREATE INDEX IF NOT EXISTS idx_royalty_transactions_agent ON royalty_transactions(agent_handle);
CREATE INDEX IF NOT EXISTS idx_royalty_transactions_created ON royalty_transactions(created_at);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_agent_royalties_updated_at
    BEFORE UPDATE ON agent_royalties
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_agent_points_updated_at
    BEFORE UPDATE ON agent_points
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_positions_updated_at
    BEFORE UPDATE ON positions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
