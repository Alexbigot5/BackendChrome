const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const crypto = require('crypto');
const { pool } = require('../index');
const { provisionSheet } = require('../helpers/sheets');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'customer.subscription.created': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const customer = await stripe.customers.retrieve(customerId);
        const email = customer.email;

        if (!email) {
          console.error('[WEBHOOK] No email on customer:', customerId);
          break;
        }

        const token = generateToken();

        // Upsert: if user already exists (e.g. re-subscribing), update their record
        const upsertResult = await pool.query(
          `INSERT INTO users (email, stripe_customer_id, stripe_subscription_id, active, token)
           VALUES ($1, $2, $3, true, $4)
           ON CONFLICT (email) DO UPDATE SET
             stripe_customer_id = EXCLUDED.stripe_customer_id,
             stripe_subscription_id = EXCLUDED.stripe_subscription_id,
             active = true,
             token = EXCLUDED.token
           RETURNING id`,
          [email, customerId, subscription.id, token]
        );

        console.log(`[NEW SIGNUP] ${email} — subscription ${subscription.id}`);

        // Provision Google Sheet in the background; update DB when ready
        provisionSheet(email)
          .then(async ({ sheetId, sheetUrl }) => {
            await pool.query(
              'UPDATE users SET sheet_id = $1, sheet_url = $2 WHERE email = $3',
              [sheetId, sheetUrl, email]
            );
            console.log(`[SHEET PROVISIONED] ${email} → ${sheetUrl}`);
          })
          .catch((err) => {
            console.error(`[SHEET ERROR] Failed to provision sheet for ${email}:`, err.message);
          });

        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        // Ensure the user stays active when a renewal payment succeeds
        const customer = await stripe.customers.retrieve(customerId);
        const email = customer.email;

        if (email) {
          await pool.query('UPDATE users SET active = true WHERE email = $1', [email]);
          console.log(`[PAYMENT SUCCEEDED] ${email} — invoice ${invoice.id}`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const customer = await stripe.customers.retrieve(customerId);
        const email = customer.email;

        if (email) {
          await pool.query('UPDATE users SET active = false WHERE email = $1', [email]);
          console.log(`[PAYMENT FAILED] ${email} — invoice ${invoice.id}`);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const customer = await stripe.customers.retrieve(customerId);
        const email = customer.email;

        if (email) {
          await pool.query('UPDATE users SET active = false WHERE email = $1', [email]);
          console.log(`[SUBSCRIPTION DELETED] ${email} — subscription ${subscription.id}`);
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK] Handler error:', err.message);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

module.exports = router;
