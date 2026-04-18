async function up(pool) {
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_email VARCHAR(255)
  `);
  console.log('[migration] 005_add_google_email: OK');
}

module.exports = { up };
