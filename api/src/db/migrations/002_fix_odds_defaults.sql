-- Fix odds defaults: 2.0 was incorrect, should be 0.5 (representing 50% probability)
-- This migration fixes both the column defaults and any existing data

-- Fix column defaults
ALTER TABLE markets ALTER COLUMN yes_odds SET DEFAULT 0.5;
ALTER TABLE markets ALTER COLUMN no_odds SET DEFAULT 0.5;

-- Fix any existing markets that have the wrong default (2.0)
UPDATE markets SET yes_odds = 0.5 WHERE yes_odds = 2.0;
UPDATE markets SET no_odds = 0.5 WHERE no_odds = 2.0;
