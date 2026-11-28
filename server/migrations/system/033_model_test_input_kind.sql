ALTER TABLE platform_model_tests ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'text'
  CHECK (input_kind IN ('text', 'image'));
