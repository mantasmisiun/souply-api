-- Chain-native product codes → StoreProduct mapping. Lidl prints item codes in
-- BOTH the leaflet tiles (80818, 7608826; variant tiles list several) and on
-- RECEIPTS at line start ("7600526 Švyturys Ekstra…", zero-padded to 7 digits)
-- — an exact receipt↔SP match key that bypasses fuzzy name matching entirely.
-- Codes are stored NORMALIZED (leading zeros stripped). A code maps to exactly
-- one SP per chain; re-scraping re-points it to the latest listing.
--
-- Apply: dev → staging → prod. Backward-compatible (new table).

CREATE TABLE StoreProductCode (
    id INT(11) NOT NULL AUTO_INCREMENT,
    chainId INT(11) NOT NULL,
    code VARCHAR(16) NOT NULL,
    storeProductId INT(11) NOT NULL,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_spc_chain_code (chainId, code),
    KEY idx_spc_sp (storeProductId)
);
