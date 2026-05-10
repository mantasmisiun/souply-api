-- Missing composite indexes identified via EXPLAIN audit.
-- Run on both Basket-DB and Basket-DB-Test.
-- Safe to re-run: duplicate index errors can be ignored if already applied.

-- 1. StoreProductMatchVote: countRecentVotes rate-limit check runs before every
--    vote. Current idx_spmv_user(userId) narrows by user but then scans ALL
--    historical votes to filter by createdAt. With (userId, createdAt) the DB
--    uses the index to skip directly to the 60-second window.
CREATE INDEX idx_spmv_user_created
    ON StoreProductMatchVote (userId, createdAt);

-- 2. Price: applyLinePriceEffect runs on every vote and every undo.
--    Only receiptId is indexed (Price_ibfk_4), so the DB scans all Price rows
--    for that receipt (230+ rows due to fallback propagation) and filters
--    storeProductId + isFallback in memory.
CREATE INDEX idx_price_receipt_sp
    ON Price (receiptId, storeProductId, isFallback);

-- 3. Price: getVerifiedStoreProductIdsForReceipt runs on every swipe queue
--    load and produces "Using temporary" (DISTINCT forces a temp table).
--    This covering index lets the engine satisfy isFallback+priceVerified from
--    the index and return storeProductId without a table lookup or temp table.
CREATE INDEX idx_price_receipt_verified
    ON Price (receiptId, isFallback, priceVerified, storeProductId);

-- 4. Receipt: getPendingMandatorySwipeCount drives the Analize tab badge.
--    Single-column userId index used; processingStatus filtered in memory over
--    all receipts for that user.
CREATE INDEX idx_receipt_user_status
    ON Receipt (userId, processingStatus);

-- 5. Price: getReceiptComparison comparison engine fetches the latest verified
--    price per (storeProductId, storeId) via ROW_NUMBER(). Without a leading
--    storeId edge the DB scans all verified Price rows; this covering index
--    lets the engine range-scan on (storeId, priceVerified) and then use
--    storeProductId for the PARTITION BY ordering.
CREATE INDEX idx_price_store_verified
    ON Price (storeId, priceVerified, storeProductId);

-- 6. Price: getDiscountedProducts inner subquery groups by storeProductId
--    where promoEnd > NOW() and promoPrice IS NOT NULL. Without this index
--    the DB full-scans the entire Price table (all scraper promo rows) and
--    filters promoEnd in memory — the main cause of 30 s load times on the
--    Nuolaidos screen after a full scraper run.
CREATE INDEX idx_price_promo_end
    ON Price (promoEnd, storeProductId);
