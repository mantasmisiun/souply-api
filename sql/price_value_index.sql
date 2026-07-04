-- Round-2.5 fishing pool query anchors on a PRICE VALUE range (pr.price BETWEEN ±0.02)
-- + a date window. Without a price-value index the planner drives from the chain's SPs
-- and walks each one's whole price history (~7M row touches, measured 12s at a common
-- price point like 1.99 — receipt-238's save hung past the client timeout). This index
-- lets it drive from the narrow price range instead.
ALTER TABLE Price ADD INDEX idx_price_value (price, date);
