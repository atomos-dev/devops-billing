CREATE TABLE IF NOT EXISTS resource_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  services_scanned INTEGER DEFAULT 0,
  resources_found INTEGER DEFAULT 0,
  error_message TEXT,
  details TEXT
);
