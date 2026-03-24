async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id                     SERIAL PRIMARY KEY,
      email                  VARCHAR(255) UNIQUE NOT NULL,
      stripe_customer_id     VARCHAR(255),
      stripe_subscription_id VARCHAR(255),
      sheet_id               VARCHAR(255),
      sheet_url              VARCHAR(255),
      active                 BOOLEAN DEFAULT false,
      token                  VARCHAR(255),
      created_at             TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[migration] 001_create_users_table: OK');
}

module.exports = { up };
