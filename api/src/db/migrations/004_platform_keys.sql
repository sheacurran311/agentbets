-- Migration 004: Platform API Keys for integration partners
-- Enables platforms (Moltbook, Pump.fun, etc.) to access filtered market feeds
-- Platform keys are read+bet only; market creation/resolution stays admin-only

-- ============================================
-- PLATFORM KEYS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS platform_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_name VARCHAR(100) NOT NULL,
  api_key VARCHAR(64) NOT NULL UNIQUE,
  contact_email VARCHAR(255),
  permissions TEXT[] DEFAULT '{read,bet}',
  rate_limit_per_minute INTEGER DEFAULT 60,
  tags_filter TEXT[],
  categories_filter TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  request_count BIGINT DEFAULT 0
);

-- Fast lookup by API key (used on every authenticated request)
CREATE INDEX IF NOT EXISTS idx_platform_keys_api_key ON platform_keys(api_key);

-- Index for listing active keys
CREATE INDEX IF NOT EXISTS idx_platform_keys_active ON platform_keys(is_active) WHERE is_active = true;
