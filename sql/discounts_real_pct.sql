-- Migration: cross-store "real discount" on the Discounts screen badge.
--
-- realDiscountPct: how far the cheapest chain's latest EFFECTIVE unit price
-- (active promo if present, else regular) sits below the average of all chains'
-- effective unit prices — (avg − min) / avg. NULL when the product has only one
-- participating chain or its offers aren't unit-comparable (mixed units) — the
-- badge then falls back to the classic own-store bestDiscountPct.
-- cheapestChainId: the chain holding that minimum (rendered as the badge logo).
--
-- Rows whose computed realDiscountPct rounds to 0 are DELISTED at refresh time
-- (all chains equal ⇒ the "promo" buys nothing), so stored values are ≥ 1.
ALTER TABLE DiscountedProductSummary
    ADD COLUMN realDiscountPct INT NULL AFTER bestDiscountPct,
    ADD COLUMN cheapestChainId INT NULL AFTER realDiscountPct;
