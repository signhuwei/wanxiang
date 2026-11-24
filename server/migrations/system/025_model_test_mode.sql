ALTER TABLE platform_model_tests ADD COLUMN test_mode TEXT NOT NULL DEFAULT 'default'
  CHECK (test_mode IN ('default', 'chat_template_no_thinking'));
