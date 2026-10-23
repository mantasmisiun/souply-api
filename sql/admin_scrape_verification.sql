-- Scrape-review workflow: per (chain, scrape day, product) verification state
-- set from the admin catalog. 'checked' = reviewed-OK (hidden from the review
-- list); 'flagged' = needs investigation (optional note). Rows are deleted when
-- the admin un-marks. Pull flagged/unresolved via scripts/scrapeReviewPull.
--
-- Apply: dev → staging → prod. Backward-compatible (new table).

CREATE TABLE AdminScrapeVerification (
    id INT(11) NOT NULL AUTO_INCREMENT,
    chainId INT(11) NOT NULL,
    scrapeDate DATE NOT NULL,
    productId INT(11) NOT NULL,
    status ENUM('checked','flagged') NOT NULL,
    note VARCHAR(500) NULL,
    adminUserId CHAR(36) NULL,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_asv (chainId, scrapeDate, productId),
    KEY idx_asv_day (chainId, scrapeDate, status)
);
