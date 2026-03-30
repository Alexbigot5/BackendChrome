async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id                   SERIAL PRIMARY KEY,
      user_id              INTEGER REFERENCES users(id) UNIQUE,
      platforms            TEXT[],
      fields               TEXT[],
      sheet_option         VARCHAR(50),
      brief_follower_min   INTEGER,
      brief_follower_max   INTEGER,
      brief_min_engagement DECIMAL,
      brief_location       VARCHAR(255),
      brief_niches         TEXT[],
      created_at           TIMESTAMP DEFAULT NOW(),
      updated_at           TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[migration] 002_create_preferences_table: OK');
}

module.exports = { up };
