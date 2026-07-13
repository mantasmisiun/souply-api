-- Observability for the beta-signup invite flow.
--
-- A tester who hits a generic "couldn't sign up" error currently leaves no
-- diagnosable trace (a successful signup logs nothing; only an invite-email
-- failure logs, and even that doesn't persist). These columns record the
-- outcome of the invite email per row so a retry can be diagnosed straight
-- from the DB:
--   status = 'pending' (row created, invite not yet attempted)
--          | 'sent'    (invite email accepted by the provider)
--          | 'failed'  (invite send threw — see `error`)
--   error  = the SMTP/provider error message when status='failed', else NULL.
ALTER TABLE BetaSignup
  ADD COLUMN status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  ADD COLUMN error  TEXT NULL;

-- Backfill: any already-invited row really is 'sent'.
UPDATE BetaSignup SET status = 'sent' WHERE invitedAt IS NOT NULL;
