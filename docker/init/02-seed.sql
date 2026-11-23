INSERT INTO customers (name, email) VALUES
  ('Ada Lovelace',     'ada@example.com'),
  ('Alan Turing',      'alan@example.com'),
  ('Grace Hopper',     'grace@example.com'),
  ('Edsger Dijkstra',  'edsger@example.com'),
  ('Barbara Liskov',   'barbara@example.com');

INSERT INTO books (title, author, price, stock) VALUES
  ('Structure and Interpretation of Computer Programs', 'Abelson & Sussman', 49.00, 12),
  ('The Mythical Man-Month',                            'Frederick Brooks',  29.50,  4),
  ('Designing Data-Intensive Applications',             'Martin Kleppmann',  45.00,  0),
  ('A Philosophy of Software Design',                   'John Ousterhout',   24.00,  9),
  ('Site Reliability Engineering',                      'Beyer et al.',      39.90,  3);

INSERT INTO orders (customer_id, book_id, quantity, status, created_at) VALUES
  (1, 1, 1, 'delivered', now() - interval '20 days'),
  (2, 3, 2, 'paid',      now() - interval '3 days'),
  (3, 2, 1, 'shipped',   now() - interval '2 days'),
  (4, 4, 1, 'pending',   now() - interval '1 day'),
  (5, 5, 3, 'pending',   now() - interval '5 hours'),
  (2, 4, 1, 'cancelled', now() - interval '9 days');
