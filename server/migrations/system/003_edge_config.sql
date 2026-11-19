ALTER TABLE providers ADD COLUMN auth TEXT CHECK (auth IN ('x_api_key','bearer'));
ALTER TABLE providers ADD COLUMN proxy TEXT;
ALTER TABLE models ADD COLUMN route_model TEXT;
CREATE TABLE edge_config_counter (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL) STRICT;
INSERT INTO edge_config_counter VALUES (1, 0);
