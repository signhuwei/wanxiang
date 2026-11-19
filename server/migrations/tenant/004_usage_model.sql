ALTER TABLE usage ADD COLUMN model TEXT;
UPDATE usage SET model = model_id;
