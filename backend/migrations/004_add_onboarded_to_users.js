async function up(pool) {
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS onboarded BOOLEAN DEFAULT false
  `);
  console.log('[migration] 004_add_onboarded_to_users: OK');
}

module.exports = { up };
