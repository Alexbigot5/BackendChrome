require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');

const webhookRouter = require('./routes/webhook');
const verifyRouter = require('./routes/verify');
const saveRouter = require('./routes/save');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhooks require the raw body — mount before express.json()
app.use('/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());

app.use('/verify', verifyRouter);
app.use('/save', saveRouter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Centralised error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

// Shared DB pool exported so routes can import it
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

module.exports = { pool };

app.listen(PORT, () => {
  console.log(`LiveChrome backend listening on port ${PORT}`);
});
