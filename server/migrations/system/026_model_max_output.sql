ALTER TABLE models ADD COLUMN max_output_tokens INTEGER
  CHECK (max_output_tokens IS NULL OR (max_output_tokens >= 1 AND max_output_tokens <= context_window));
