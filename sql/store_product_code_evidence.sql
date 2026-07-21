-- Receipt evidence for resolving UMBRELLA variant codes into full-named SPs.
-- Each row: "receipt(s) printed <name> next to <code>". K=2 independent
-- sightings of the same (code, normalized name) promote a dedicated SP —
-- the same OCR-safety rule as the receipt-name vocabulary system.
--
-- Apply: dev → staging → prod. Backward-compatible (new table).

CREATE TABLE StoreProductCodeEvidence (
    id INT(11) NOT NULL AUTO_INCREMENT,
    chainId INT(11) NOT NULL,
    code VARCHAR(16) NOT NULL,
    normalizedName VARCHAR(255) NOT NULL,
    printedName VARCHAR(255) NOT NULL,
    seenCount INT(11) NOT NULL DEFAULT 1,
    resolvedSpId INT(11) NULL,
    lastSeenAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_spce (chainId, code, normalizedName),
    KEY idx_spce_code (chainId, code)
);
