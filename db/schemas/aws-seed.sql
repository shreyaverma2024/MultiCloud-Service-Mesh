-- Seed data for aws_library. Safe to run repeatedly.

INSERT INTO books (title, author, isbn, category, total_copies, available_copies, published_year)
VALUES
  ('The Pragmatic Programmer', 'Andrew Hunt and David Thomas', '9780201616224', 'Software Engineering', 6, 6, 1999),
  ('Clean Code', 'Robert C. Martin', '9780132350884', 'Software Engineering', 5, 5, 2008),
  ('Designing Data-Intensive Applications', 'Martin Kleppmann', '9781449373320', 'Distributed Systems', 4, 4, 2017),
  ('Site Reliability Engineering', 'Niall Richard Murphy et al.', '9781491929124', 'Operations', 3, 3, 2016),
  ('Computer Networks', 'Andrew S. Tanenbaum', '9780132126953', 'Networking', 4, 4, 2010),
  ('Operating System Concepts', 'Abraham Silberschatz et al.', '9781118063330', 'Operating Systems', 5, 5, 2012),
  ('Introduction to Algorithms', 'Thomas H. Cormen et al.', '9780262046305', 'Algorithms', 3, 3, 2022),
  ('Database System Concepts', 'Abraham Silberschatz et al.', '9780078022159', 'Databases', 4, 4, 2019),
  ('The Mythical Man-Month', 'Frederick P. Brooks Jr.', '9780201835953', 'Software Engineering', 2, 2, 1995),
  ('Building Microservices', 'Sam Newman', '9781492034025', 'Distributed Systems', 3, 3, 2021),
  ('Cloud Native Patterns', 'Cornelia Davis', '9781617294297', 'Cloud Computing', 2, 2, 2019),
  ('Release It!', 'Michael T. Nygard', '9781680502398', 'Operations', 3, 3, 2018)
ON CONFLICT (isbn) DO NOTHING;
