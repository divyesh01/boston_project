-- Bootstrap OWNER_A identity for the live acceptance test. Email MUST match the
-- Cloudflare Access SSO identity the owner logs in with. role='owner' => scope
-- resolver treats as 'all' properties regardless of stored mode.
INSERT INTO user (id, account_id, username, display_name, email, role,
  property_access_mode, permissions, is_active, is_locked, must_change_password,
  created_date, updated_date)
VALUES ('usr_owner_A','ACCOUNT_A','owner_a','Owner A','divyesh.boston@gmail.com',
  'owner','all','{}',1,0,0,'2026-08-31T00:00:00.000Z','2026-08-31T00:00:00.000Z')
ON CONFLICT DO NOTHING;
