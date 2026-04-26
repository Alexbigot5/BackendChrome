require('dotenv').config();

const express = require('express');
const cors = require('cors');

const webhookRouter    = require('./routes/webhook');
const verifyRouter     = require('./routes/verify');
const saveRouter       = require('./routes/save');
const onboardingRouter = require('./routes/onboarding');
const provisionRouter  = require('./routes/provision');
const statsRouter      = require('./routes/stats');
const brandRouter      = require('./routes/brand');

const app  = express();
const PORT = process.env.PORT || 3000;

// Allow ALL origins — we handle auth via tokens, CORS is not a security boundary here
app.use(cors({ origin: true, credentials: true }));

app.use('/webhook', express.raw({ type: 'application/json' }), webhookRouter);
app.use(express.json());

app.use('/verify',     verifyRouter);
app.use('/save',       saveRouter);
app.use('/onboarding', onboardingRouter);
app.use('/provision',  provisionRouter);
app.use('/stats',      statsRouter);
app.use('/brand',      brandRouter);
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`LiveChrome backend listening on port ${PORT}`);
});
