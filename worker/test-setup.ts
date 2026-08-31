import { applyD1Migrations, env } from 'cloudflare:test';

await applyD1Migrations(
  env.DB,
  (env as typeof env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] }).TEST_MIGRATIONS,
);
