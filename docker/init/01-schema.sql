-- A tiny online bookshop, just enough to give an agent something to read and change.

CREATE TABLE customers (
  id          serial PRIMARY KEY,
  name        text        NOT NULL,
  email       text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id     serial PRIMARY KEY,
  title  text          NOT NULL,
  author text          NOT NULL,
  price  numeric(8, 2) NOT NULL CHECK (price >= 0),
  stock  integer       NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  customer_id integer     NOT NULL REFERENCES customers (id),
  book_id     integer     NOT NULL REFERENCES books (id),
  quantity    integer     NOT NULL CHECK (quantity > 0),
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'paid', 'shipped', 'delivered', 'cancelled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
