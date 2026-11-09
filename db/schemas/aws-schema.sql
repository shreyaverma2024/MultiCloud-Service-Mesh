-- AWS logical database: aws_library
-- Authoritative book and borrowing data.

CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  isbn TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  total_copies INTEGER NOT NULL CHECK (total_copies >= 0),
  available_copies INTEGER NOT NULL CHECK (available_copies >= 0),
  published_year INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS borrows (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id),
  member_id INTEGER NOT NULL,
  borrowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ NOT NULL,
  returned_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'BORROWED' CHECK (status IN ('BORROWED', 'RETURNED', 'OVERDUE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borrows_member ON borrows(member_id);
CREATE INDEX IF NOT EXISTS idx_borrows_book ON borrows(book_id);
CREATE INDEX IF NOT EXISTS idx_borrows_status ON borrows(status);
CREATE INDEX IF NOT EXISTS idx_books_title ON books(title);

-- Control Plane persistence (best-effort; the Control Plane also works in memory).
CREATE TABLE IF NOT EXISTS mesh_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  cloud TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB
);

CREATE TABLE IF NOT EXISTS mesh_routing_policy (
  id INTEGER PRIMARY KEY,
  aws_weight INTEGER NOT NULL,
  render_weight INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO mesh_routing_policy (id, aws_weight, render_weight, updated_by)
VALUES (1, 70, 30, 'initial-policy')
ON CONFLICT (id) DO NOTHING;
