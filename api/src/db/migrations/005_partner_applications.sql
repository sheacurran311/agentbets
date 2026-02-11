-- Migration 005: Partner application workflow
-- Adds wallet-based partner applications with approval flow
-- Partners connect wallet, apply for API key, admin approves/rejects

-- ============================================
-- ADD PARTNER APPLICATION COLUMNS
-- to existing platform_keys table
-- ============================================

-- Wallet address of the applying partner
ALTER TABLE platform_keys ADD COLUMN IF NOT EXISTS wallet_address VARCHAR(64);

-- Application status: pending, approved, rejected, active (legacy admin-created)
ALTER TABLE platform_keys ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active';

-- Free-text description of the partner's integration plans
ALTER TABLE platform_keys ADD COLUMN IF NOT EXISTS platform_description TEXT;

-- When the application was reviewed by admin
ALTER TABLE platform_keys ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

-- Reason for rejection (if rejected)
ALTER TABLE platform_keys ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Fast lookup by wallet address (1 key per wallet enforcement)
CREATE INDEX IF NOT EXISTS idx_platform_keys_wallet ON platform_keys(wallet_address);

-- Filter by status (admin listing pending applications)
CREATE INDEX IF NOT EXISTS idx_platform_keys_status ON platform_keys(status);
