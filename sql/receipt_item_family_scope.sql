-- FAMILY SHOPPING §4 — the per-item FAMILY / PERSONAL flag (spec §4.1, §4.3).
-- Idempotent (IF NOT EXISTS); no FK, no data backfill needed.
--
-- WHY `isPersonal` AND NOT `isFamily` / ENUM('family','personal')
--   · §4.1 fixes the default at FAMILY. Storing the flag as "is it personal"
--     makes that default fall out of `DEFAULT 0` — and, far more importantly,
--     makes ZERO the safe value: every existing row, every INSERT that omits
--     the column, every write path that has not learned about the flag yet, and
--     every coercion of undefined/null/'' lands on FAMILY. With `isFamily
--     DEFAULT 1` the safe value would be 1, and any forgotten column, stale
--     client payload or falsy coercion would silently make an item PERSONAL —
--     i.e. silently REMOVE money from the family subtotal and from everyone
--     else's balance. The failure mode has to be the harmless one.
--   · TINYINT(1) is the house convention for line-level booleans on this exact
--     table (isWeighable, matchConfirmed, priceVerified, variantUncertain,
--     priceImplausible), and §4.1 itself calls the feature "a boolean per item"
--     with `isPantry` as the named precedent.
--   · An ENUM would buy a third state this feature has no use for, and would
--     have to be spelled out at every one of the ~8 line<->row mapping sites.
--
-- The index is (receiptId, isPersonal) because the ONLY query shape is "the
-- family items of receipt R" — the family-subtotal aggregate (§4.3) and the
-- non-participant read path (§4.5). It is a strict prefix-extension of the
-- existing idx_ri_receipt, so it costs one small index and no query rewrite.
ALTER TABLE ReceiptItem
    ADD COLUMN IF NOT EXISTS isPersonal TINYINT(1) NOT NULL DEFAULT 0,
    ADD KEY IF NOT EXISTS idx_ri_scope (receiptId, isPersonal);
