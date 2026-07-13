-- Latest/as-of price lookups (Round-2 confirm, Round-2.5 fishing, Slot-2c pools,
-- fetchLatestPrices) all walk (storeProductId, date DESC). They currently lean on the
-- unique_price(storeProductId, storeId, date) prefix, which works but is wider than
-- needed at ~14M rows. A dedicated two-column index makes the per-SP latest-row
-- window a pure index range scan.
ALTER TABLE Price ADD INDEX idx_price_sp_date (storeProductId, date);
