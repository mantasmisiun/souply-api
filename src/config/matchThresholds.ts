/**
 * Runtime thresholds for the pairwise swipe-voting state machine.
 *
 * Kept in a TS config file rather than the database so tuning is a single
 * file edit + restart. Values chosen intentionally low for a thesis-scale
 * user base: with only a handful of voters, classic thresholds like
 * `minVotes=15` would never cross. Tune upward once real traffic grows.
 *
 * Hysteresis: promote and demote bounds are deliberately split so a single
 * swing vote doesn't flap a merge on/off. Promote uses a high positive-rate
 * Wilson lower bound; demote uses a low one (giving a dead-band between
 * them where nothing changes).
 */

export const MatchThresholds = {
    /** z-score for Wilson confidence interval. 1.96 ≈ 95%. */
    wilsonZ: 1.96,

    /** Identical merge: both need to be satisfied to promote. */
    promoteIdentical: {
        minVotes: 3,
        minWilsonLower: 0.80, // positive-rate lower bound
    },

    /** Identical merge: if either is hit while already merged, demote. */
    demoteIdentical: {
        minVotes: 3,
        maxWilsonLower: 0.50,
    },

    /** Similar (baseProduct-level link) — thresholds used in C3. */
    promoteSimilar: {
        minVotes: 3,
        minWilsonLower: 0.70,
    },
    demoteSimilar: {
        minVotes: 3,
        maxWilsonLower: 0.40,
    },

    /** Burst filter: votes with shorter dwell are silently discarded.
     *  Lowered from 500 → 100 — users legitimately swipe fast once muscle
     *  memory kicks in, and the original threshold was silently killing
     *  real votes. 100ms still filters genuinely accidental thumb bumps. */
    minDwellMs: 100,

    /** Orphan-queue dwell filter. Cross-chain orphan cards take more reading
     *  than receipt-match cards (two unfamiliar products instead of OCR vs.
     *  expected candidate), so we require a longer dwell to count the vote
     *  into the aggregate. The vote row is still written for audit. */
    minDwellMsOrphan: 700,

    /** Max pair-votes a single user can cast per minute — defence against
     *  accidental rapid re-swiping through the queue. */
    maxUserVotesPerMinute: 40,

    /** Basket calc tier-3 substitution threshold. When a store doesn't
     *  carry the user's basket item, we look for the nearest-name-similar
     *  StoreProduct IN THE SAME CHAIN. If Levenshtein ratio on normalized
     *  names passes this cutoff, we price the slot with that SP; the
     *  shopping list still shows the original name+amount so the user
     *  sees their intent preserved.
     *
     *  Kept stricter than the cross-chain Product reuse threshold (0.85)
     *  since bad substitutions distort store totals and mislead shoppers.
     *  0.80 catches "PERSIL Discs Sensitive 37" ↔ "PERSIL SENSITIVE 37"
     *  but rejects "Pienas" ↔ "Pieno produktas". */
    substitutionMinSimilarity: 0.75,

    /** Products in the Nepriskirta bucket (categoryId=688) are excluded
     *  from substitution candidates by id. Stored here for documentation /
     *  future tuning; the calc service references NEPRISKIRTA_CATEGORY_ID
     *  directly. */
    nepriskirtaCategoryId: 688,
} as const;
