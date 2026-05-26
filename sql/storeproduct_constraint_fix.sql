-- Fix StoreProduct unique constraint so product merges are allowed.
--
-- The old constraint UNIQUE (chainId, productId, amount, unit) blocks merging
-- two products that each have an SP from the same chain at the same size but
-- with different storeProductNames (different brands / SKUs). It is replaced
-- by a plain index on chainId that keeps the FK to StoreChain covered without
-- imposing any uniqueness rule that blocks merges.
--
-- Application-level uniqueness (findExactMatchingStoreProduct) already
-- prevents duplicate inserts, so no DB-level UNIQUE constraint is needed.
--
-- Both ops in one statement so MySQL sees the chainId FK remains covered
-- and doesn't reject the drop.
ALTER TABLE StoreProduct
    DROP INDEX uq_sp_chain_product_size,
    ADD INDEX idx_sp_chainId (chainId);
