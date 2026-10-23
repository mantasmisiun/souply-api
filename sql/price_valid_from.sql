-- Price validity window: a start date to complement promoEnd.
--
-- Motivation (Lidl weekly leaflets, but applies to any chain): promos are
-- published with a FUTURE start ("valid 07-23 – 07-26" scraped on 07-20), and a
-- listed weekly price should stop being "current" once its window passes. The
-- effective-price gate now treats a Price row as active only within
-- [validFrom, promoEnd]:
--     (validFrom IS NULL OR validFrom <= NOW()) AND (promoEnd IS NULL OR promoEnd > NOW())
-- Before validFrom the calc shows the regular `price`; inside the window it shows
-- `promoPrice`. NULL validFrom = unbounded start (all existing rows → unchanged).
--
-- Apply: dev → staging → prod. Backward-compatible (nullable, defaults NULL).

ALTER TABLE Price
    ADD COLUMN validFrom DATETIME NULL AFTER promoEnd;

-- Optional: index to keep the added gate cheap on the hot price lookups.
CREATE INDEX idx_price_validfrom ON Price (validFrom);
