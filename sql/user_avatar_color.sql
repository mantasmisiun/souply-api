-- Per-user avatar colour: drives the coloured initial circle shown wherever a
-- user is represented (profile, trip/home member rosters, who-checked badges
-- on shared list items). Assigned a random palette colour when the user first
-- sets a display name; editable any time from the profile.
--
-- Apply: dev → staging → prod. Backward-compatible (new nullable column).

ALTER TABLE User ADD COLUMN avatarColor VARCHAR(7) NULL AFTER avatarUrl;
