-- Phase-1 staging acceptance provisioning (email-independent parts).
-- Operator-provisioned account + properties + canonical code->id map, mirroring
-- how _worker-testkit.mjs seeds them. Users are seeded separately once the real
-- Cloudflare Access identity emails are known.
INSERT INTO account (id, name, created_date)
VALUES ('ACCOUNT_A', 'Account A', '2026-08-31T00:00:00.000Z')
ON CONFLICT(id) DO NOTHING;

INSERT INTO property (id, account_id, code, name, rooms, city, state, active, created_date)
VALUES
  ('HOTEL_A', 'ACCOUNT_A', 'HOTEL_A', 'Hotel A', 120, 'Boston', 'MA', 1, '2026-08-31T00:00:00.000Z'),
  ('HOTEL_B', 'ACCOUNT_A', 'HOTEL_B', 'Hotel B', 80, 'Cambridge', 'MA', 1, '2026-08-31T00:00:00.000Z')
ON CONFLICT(account_id, code) DO NOTHING;

INSERT INTO property_id_map (account_id, local_numeric_id, code, server_id)
VALUES
  ('ACCOUNT_A', 1, 'HOTEL_A', 'HOTEL_A'),
  ('ACCOUNT_A', 2, 'HOTEL_B', 'HOTEL_B')
ON CONFLICT(account_id, code) DO NOTHING;
