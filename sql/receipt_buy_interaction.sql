-- Souply 2.0 — `receipt_buy` interaction type (weight 5, the strongest
-- ranking signal: a fiscal receipt proves the purchase). Fired once per
-- resolved receipt line (S1/S2 band, initial save only — never reparse or
-- autosave). Weights live in code (productInteractionModel WEIGHTED_SCORE_EXPR).
-- Idempotent: MODIFY to the superset enum is safe to re-run.

ALTER TABLE ProductInteraction
    MODIFY COLUMN type ENUM('basket_add','list_add','list_check','receipt_buy') NOT NULL;
