async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scrape_log (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id),
      handle     VARCHAR(255),
      platform   VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[migration] 003_create_scrape_log: OK');
}

module.exports = { up };
