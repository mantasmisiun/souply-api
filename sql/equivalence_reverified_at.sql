-- Re-verification anti-nag marker (2026-07-03).
--
-- needsReverification=1 re-serves a personal vote as a swipe card (queue priority,
-- no-repeat bypass). Two triggers set it: (A) a fresh S1 receipt match contradicting
-- a personal 'different' on a same-Product pair, (B) a global merge transition
-- contradicting the personal verdict. Without a marker, trigger (A) would RE-FLAG the
-- same vote on every subsequent scan of that product — a nag loop for a user who
-- already re-confirmed their 'different' with fresh eyes.
--
-- reverifiedAt = "this vote already survived a challenge": stamped whenever the user
-- re-votes a flagged pair. Trigger (A) skips stamped rows forever; trigger (B) CLEARS
-- the stamp (a global flip is genuinely new information → one fresh challenge allowed).
--
-- Apply: dev ✓, test_ci ✓ (this file), staging/prod via the deploy checklist.
ALTER TABLE UserStoreProductEquivalence
    ADD COLUMN reverifiedAt DATETIME NULL DEFAULT NULL AFTER needsReverification;
