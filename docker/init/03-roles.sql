-- Two roles, so the database enforces the same split as the gateway (defence in depth):
--   gateway_reader: SELECT only, and every transaction defaults to read-only.
--   gateway_writer: may change rows, but cannot drop tables or create roles.
CREATE ROLE gateway_reader LOGIN PASSWORD 'reader';
CREATE ROLE gateway_writer LOGIN PASSWORD 'writer';

GRANT CONNECT ON DATABASE demo TO gateway_reader, gateway_writer;
GRANT USAGE ON SCHEMA public TO gateway_reader, gateway_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO gateway_reader;
ALTER ROLE gateway_reader SET default_transaction_read_only = on;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gateway_writer;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO gateway_writer;
