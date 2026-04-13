require('dotenv').config();

const express = require('express');
const cors = require('cors');

const webhookRouter = require('./routes/webhook');
const verifyRouter = require('./routes/verify');
const saveRouter = require('./routes/save');
const onboardingRouter = require('./routes/onboarding');
const provisionRouter = require('./routes/provision');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'chrome-extension://*',
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some((o) => origin.startsWith(o.replace('*', '')))) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ─── Stripe webhooks require raw body — mount BEFORE express.json() ─────────
app.use('/webhook', express.raw({ type: 'application/json' }), webhookRouter);

app.use(express.json());

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/verify', verifyRouter);
app.use('/save', saveRouter);
app.use('/onboarding', onboardingRouter);
app.use('/provision', provisionRouter);
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ─── Centralised error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`LiveChrome backend listening on port ${PORT}`);
});app.use('/provision', provisionRouter);
app.use('/provision', provisionRouter);
