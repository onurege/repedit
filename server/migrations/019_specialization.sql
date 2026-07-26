-- V2.8 Phase 4 — business specialization & controlled automation.
--
-- Additive & idempotent. Existing businesses stay UNSPECIALIZED (NULL) until the
-- owner deliberately chooses at level 20 — no business is auto-assigned. No other
-- state (cash/inventory/cost basis/licenses/active/jobs/XP/levels) is touched.

-- The chosen permanent specialization path id (see SPECIALIZATIONS in shared).
ALTER TABLE businesses      ADD COLUMN IF NOT EXISTS specialization TEXT;

-- Bounded auto-repeats remaining for a production job (never auto-buys; a repeat
-- becomes a real job only when ingredients/license/slot/storage allow at the time).
ALTER TABLE production_jobs ADD COLUMN IF NOT EXISTS repeat_remaining INTEGER NOT NULL DEFAULT 0;
