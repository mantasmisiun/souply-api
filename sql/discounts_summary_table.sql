-- Migration: DiscountedProductSummary — materialised view for /api/products/discounted
--
-- The runtime query in productModel.ts joins Product × StoreProduct × Price with
-- a subquery that finds MAX(id) per storeProductId for active promos. The MySQL
-- optimizer prefers a full index scan on unique_price (11 M rows) over the
-- targeted idx_price_promo_end, so cold cache misses take ~30 s on prod.
--
-- This table replaces request-time aggregation with a write-time job that runs
-- post-scrape (Mon/Tue/Thu/Sat 06:00) + daily at 00:30 to drop expired promos.
-- Endpoint becomes a flat indexed SELECT — sub-100 ms cold.
CREATE TABLE IF NOT EXISTS DiscountedProductSummary (
    productId       INT PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    categoryId      INT,
    l2CategoryId    INT,
    imageUrls       JSON,
    chainLogos      JSON,
    minAmount       INT,
    maxAmount       INT,
    unit            VARCHAR(8) DEFAULT 'g',
    hasWeighable    TINYINT(1) DEFAULT 0,
    bestDiscountPct INT NOT NULL,
    realDiscountPct INT NULL,
    cheapestChainId INT NULL,
    canonicalUnit   VARCHAR(8),
    canonicalStep   DOUBLE,
    canonicalFamily VARCHAR(16),
    updatedAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_dps_discount (bestDiscountPct),
    INDEX idx_dps_l2 (l2CategoryId, bestDiscountPct)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
