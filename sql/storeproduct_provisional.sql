-- Migration: cross-chain rescue mints (user-confirmed, provisional until corroborated).
--
-- When a receipt line has NO same-chain match but a cross-chain candidate passes the
-- name + price gates, the user gets a swipe card (crop vs the other chain's SP). An
-- "identical" swipe mints an SP in the receipt's chain — copied name/photo, attached
-- to the SAME Product — but PROVISIONAL: visible only to the minting user (their
-- receipt links, their comparisons) until corroborated.
--
-- Promotion to the global catalog (provisional=0): K=2 DISTINCT users whose recorded
-- OCR aliases for this SP are mutually similar at a high confusion-weighted threshold
-- (receipt prints are deterministic per product, so print-vs-print similarity is the
-- same-product proof) AND whose paid prices agree; disagreeing prices demand a third
-- user. Admin verdicts override. See crossChainMintService.ts.
ALTER TABLE StoreProduct
    ADD COLUMN provisional TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN provisionalOwnerUserId CHAR(36) NULL,
    ADD COLUMN mintedFromSpId INT NULL,
    ADD INDEX idx_sp_provisional (provisional, chainId);
