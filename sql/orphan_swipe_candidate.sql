-- OrphanSwipeCandidate: precomputed top-K candidate Products for each
-- orphan Product, used to feed the "Gal dar?" cross-chain swipe queue.
--
-- Row lifecycle:
--   1. Seeded by src/scripts/seedOrphanSwipeCandidates.ts (and per-orphan
--      refilled on-demand by the extra-queue endpoint when its top-K runs
--      dry).
--   2. Served to the frontend via GET /api/swipe/extra-queue, filtered by
--      resolved=0 and the user's prior votes in StoreProductMatchVote.
--   3. Marked resolved=1 + resolvedOutcome when the pair's Wilson lower
--      bound crosses promote or demote thresholds (hook in reevaluateMerge).
--
-- tier = 1 means the orphan is at Category 688 (Nepriskirta). tier = 2 is
-- reserved for later — categorized Products with a potentially-better
-- cross-chain match that didn't clear the 0.85 import threshold.

CREATE TABLE IF NOT EXISTS OrphanSwipeCandidate (
    id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
    orphanProductId    INT NOT NULL,
    candidateProductId INT NOT NULL,
    orphanSpId         INT NOT NULL,
    candidateSpId      INT NOT NULL,
    similarityScore    DECIMAL(4, 3) NOT NULL,
    rankPos            TINYINT UNSIGNED NOT NULL,
    tier               TINYINT UNSIGNED NOT NULL DEFAULT 1,
    resolved           TINYINT(1) NOT NULL DEFAULT 0,
    resolvedOutcome    ENUM('promoted','demoted') NULL,
    resolvedAt         DATETIME NULL,
    createdAt          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_orphan_candidate (orphanProductId, candidateProductId),
    KEY idx_feed (resolved, tier, rankPos, similarityScore),
    KEY idx_orphan (orphanProductId, resolved, rankPos),
    KEY idx_candidate_product (candidateProductId),

    CONSTRAINT fk_osc_orphan_product   FOREIGN KEY (orphanProductId)    REFERENCES Product(id)       ON DELETE CASCADE,
    CONSTRAINT fk_osc_cand_product     FOREIGN KEY (candidateProductId) REFERENCES Product(id)       ON DELETE CASCADE,
    CONSTRAINT fk_osc_orphan_sp        FOREIGN KEY (orphanSpId)         REFERENCES StoreProduct(id)  ON DELETE CASCADE,
    CONSTRAINT fk_osc_cand_sp          FOREIGN KEY (candidateSpId)      REFERENCES StoreProduct(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
