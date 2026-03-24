const express = require('express');
const router = express.Router();
const { pool } = require('../index');

// GET /verify?email=xxx
router.get('/', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'email query parameter is required' });
  }

  try {
    const result = await pool.query(
      'SELECT active, token, sheet_id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (result.rows.length === 0 || !result.rows[0].active) {
      return res.json({ valid: false });
    }

    const user = result.rows[0];
    return res.json({
      valid: true,
      token: user.token,
      sheetId: user.sheet_id,
    });
  } catch (err) {
    console.error('[VERIFY] DB error:', err.message);
    res.status(500).json({ error: 'Failed to verify user' });
  }
});

module.exports = router;
