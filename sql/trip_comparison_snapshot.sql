-- Trip-level Sutaupyta snapshot.
--
-- The per-receipt snapshot (ReceiptComparisonSnapshot) freezes "this receipt vs
-- other chains for ITS items". A split trip needs the other question — "the whole
-- basket at ONE store" — and that answer must be frozen for the same reason: a
-- trip from March must not silently re-price itself against today's catalog.
--
-- Applied: dev  <fill on run>   staging PENDING   prod PENDING
CREATE TABLE IF NOT EXISTS TripComparisonSnapshot (
    tripId            INT           NOT NULL PRIMARY KEY,
    paidTotal         DECIMAL(10,2) NOT NULL,
    -- Cheapest single-store total for the whole basket (NULL = no candidates).
    bestSingleTotal   DECIMAL(10,2)     NULL,
    bestStoreId       INT               NULL,
    candidateCount    SMALLINT      NOT NULL DEFAULT 0,
    -- Receipt lines with no product identity: in paidTotal, unpriceable elsewhere.
    unmatchedLines    SMALLINT      NOT NULL DEFAULT 0,
    payload           LONGTEXT          NULL,   -- full comparison as rendered
    computedAt        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_tcs_trip FOREIGN KEY (tripId) REFERENCES Trip(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
