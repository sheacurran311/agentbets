-- Migration 006: Resolution timing for early vs end-of-market resolution
-- Markets with monotonic metrics (e.g. Moltbook agent count) can resolve as soon as target is hit
-- Markets with variable metrics (e.g. Twitter followers) must resolve at close date

ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_timing VARCHAR(20) DEFAULT 'at_close';

COMMENT ON COLUMN markets.resolution_timing IS 'on_target: resolve as soon as threshold is met (monotonic). at_close: resolve only at end date (variable)';

-- Bot tracking: pending_resolutions also needs resolution_timing for on_target early checks
ALTER TABLE pending_resolutions ADD COLUMN IF NOT EXISTS resolution_timing VARCHAR(20) DEFAULT 'at_close';
