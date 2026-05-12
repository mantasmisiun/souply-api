-- Cleanup script: wipes scraper-added promo Prices, then orphaned SPs and
-- Products created during those scraper runs. Run once before re-scraping
-- with the new fan-out promoUpsert (priceVerified=true, all chain stores).
--
-- Safe guards:
--   - Only deletes Price rows with receiptId IS NULL (scraper-only rows).
--   - Only deletes StoreProducts that have zero Price rows after step 1.
--   - Only deletes Products that have no StoreProducts AND are not in any basket.

-- 1. Delete all scraper-inserted promo prices.
--    receiptId IS NULL  → not linked to a user receipt (scraper-sourced).
--    promoPrice / promoEnd set  → it is a promo observation, not a regular price.
DELETE FROM Price
WHERE promoPrice IS NOT NULL
  AND promoEnd IS NOT NULL
  AND receiptId IS NULL;

-- 2. Delete StoreProducts that now have no Price rows at all.
--    These were created exclusively to hold scraper promo prices and are
--    now fully orphaned.
DELETE sp FROM StoreProduct sp
WHERE NOT EXISTS (
    SELECT 1 FROM Price p WHERE p.storeProductId = sp.id
);

-- 3. Unlink baseProductId pointers that reference Products about to be deleted
--    (prevents FK constraint errors in step 5).
UPDATE Product
SET baseProductId = NULL
WHERE baseProductId IN (
    SELECT id FROM (
        SELECT p.id FROM Product p
        WHERE NOT EXISTS (SELECT 1 FROM StoreProduct sp WHERE sp.productId = p.id)
          AND NOT EXISTS (SELECT 1 FROM BasketItem bi WHERE bi.productId = p.id)
    ) AS orphans
);

-- 4. Fix self-referential Products (baseProductId = id).
UPDATE Product
SET baseProductId = NULL
WHERE baseProductId = id;

-- 5. Delete Products that now have no StoreProducts and are not in any basket.
DELETE prod FROM Product prod
WHERE NOT EXISTS (SELECT 1 FROM StoreProduct sp WHERE sp.productId = prod.id)
  AND NOT EXISTS (SELECT 1 FROM BasketItem bi WHERE bi.productId = prod.id);

-- Sanity check — should be 0 remaining scraper promo prices:
SELECT COUNT(*) AS remaining_scraper_promo_prices
FROM Price
WHERE promoPrice IS NOT NULL
  AND promoEnd IS NOT NULL
  AND receiptId IS NULL;
