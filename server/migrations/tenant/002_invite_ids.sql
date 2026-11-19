ALTER TABLE invites ADD COLUMN id TEXT;
UPDATE invites SET id = 'inv_' || upper(hex(randomblob(13)));
CREATE UNIQUE INDEX invites_by_id ON invites(id);
