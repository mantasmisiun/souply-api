-- Tracks when the beta invite email was actually sent for a signup, so the
-- POST /api/beta-signups endpoint can:
--   (a) AWAIT the invite send and report delivery to the landing-page form
--       (loading → "sent" / error state),
--   (b) never re-send to an address that was already invited (anti-spam /
--       mail-bomb protection, independent of the rate limiter),
--   (c) still safely RETRY if a previous send failed — invitedAt stays NULL
--       until a send succeeds, so a resubmit re-attempts it.
ALTER TABLE BetaSignup ADD COLUMN invitedAt DATETIME NULL DEFAULT NULL;
