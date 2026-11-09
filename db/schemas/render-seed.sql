-- Seed data for render_library. Safe to run repeatedly.

INSERT INTO members (name, email, phone, membership_type)
VALUES
  ('Aarav Sharma', 'aarav.sharma@example.com', '+91-9000000001', 'PREMIUM'),
  ('Diya Patel', 'diya.patel@example.com', '+91-9000000002', 'STUDENT'),
  ('Kabir Singh', 'kabir.singh@example.com', '+91-9000000003', 'BASIC'),
  ('Meera Nair', 'meera.nair@example.com', '+91-9000000004', 'PREMIUM'),
  ('Rohan Verma', 'rohan.verma@example.com', '+91-9000000005', 'STUDENT')
ON CONFLICT (email) DO NOTHING;

INSERT INTO notifications (member_id, book_id, type, message, status)
SELECT 1, 1, 'BORROW', 'Welcome notification: the library mesh is online.', 'SENT'
WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE member_id = 1 AND type = 'BORROW');

INSERT INTO notifications (member_id, book_id, type, message, status)
SELECT 2, 2, 'SYSTEM', 'Your student membership is active.', 'SENT'
WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE member_id = 2 AND type = 'SYSTEM');
