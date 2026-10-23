-- Category-review flag for products MINTED into a BORROWED category by the
-- scraper's weak-match path (advanced matcher, 0.75–0.80 band). At that
-- confidence the borrowed category is right ~90% of the time, so the mint is
-- provisional: the admin queue confirms or reclassifies. Strong joins (≥0.80)
-- and hard-uncategorised (<0.75 → 688) never set this.
--
-- Apply: dev → staging → prod. Backward-compatible (default 0 = nothing to review).

ALTER TABLE Product
    ADD COLUMN categoryReviewPending TINYINT(1) NOT NULL DEFAULT 0;

CREATE INDEX idx_product_category_review ON Product (categoryReviewPending);
