require('dotenv').config();

const { Pool } = require('pg');
const migration001 = require('./migrations/001_create_users_table');
const migration002 = require('./migrations/002_create_preferences_table');
const migration003 = require('./migrations/003_create_scrape_log');
const migration004 = require('./migrations/004_add_onboarded_to_users');

const migrations = [migration001, migration002, migration003, migration004];

async function runMigrations() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    for (const migration of migrations) {
      await migration.up(pool);
    }
    console.log('[migrations] All migrations completed successfully.');
  } catch (err) {
    console.error('[migrations] Migration failed:', err.message || err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
