'use strict';
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const https = require('https');
const db = require('../database');
const { verifyBuyer, JWT_SECRET } = require('../middleware/auth');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8659195374:AAGVydpl_rMlw-O-Y3dgTNMsvhMq8Bi25WE';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6928347196';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function sendEmail(to, subject, html) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ from: 'Law-Trust.com <support@law-trust.com>', to, subject, html });
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// POST /api/buyers/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, firm, preferences } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    const existing = db.prepare('SELECT id FROM lead_buyers WHERE email = ?').get(email);
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const password_hash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const prefsStr = typeof preferences === 'object' ? JSON.stringify(preferences) : (preferences || '{}');

    const result = db.prepare(`
      INSERT INTO lead_buyers (name, email, password_hash, phone, firm, preferences, balance, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)
    `).run(name, email, password_hash, phone || null, firm || null, prefsStr, now);

    const buyerId = result.lastInsertRowid;
    const token = jwt.sign({ id: buyerId, email, name, firm }, JWT_SECRET, { expiresIn: '30d' });

    // Welcome email
    sendEmail(email, 'Welcome to Law-Trust.com Lead Buyer Portal', `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
<div style="background:#1a2744;padding:24px;border-radius:8px 8px 0 0;">
  <h1 style="color:#c9a84c;margin:0;">Welcome, ${name}!</h1>
</div>
<div style="padding:24px;border:1px solid #eee;border-top:none;">
<p>Your Law-Trust.com Lead Buyer account is now active. 🎉</p>
<p>You'll start receiving leads matching your preferences as soon as they come in.</p>
<p><strong>Next steps:</strong></p>
<ul>
  <li>Add funds to your account to activate automatic lead delivery</li>
  <li>Update your preferences to fine-tune the leads you receive</li>
  <li>Log in to your dashboard: <a href="https://law-trust.com/buyer-portal/dashboard.html">View Dashboard</a></li>
</ul>
<p>Questions? Reply to this email.</p>
</div>
</div>`).catch(() => {});

    // Telegram Matt
    sendTelegram(`🏢 New buyer registered: ${name} from ${firm || 'N/A'}\nEmail: ${email}`).catch(() => {});

    res.json({ success: true, token, buyerId, message: 'Account created successfully' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/buyers/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const buyer = db.prepare('SELECT * FROM lead_buyers WHERE email = ?').get(email);
    if (!buyer) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, buyer.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (!buyer.active) return res.status(403).json({ error: 'Account is inactive' });

    const token = jwt.sign({ id: buyer.id, email: buyer.email, name: buyer.name, firm: buyer.firm }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, name: buyer.name, firm: buyer.firm });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/buyers/dashboard
router.get('/dashboard', verifyBuyer, (req, res) => {
  try {
    const buyer = db.prepare('SELECT id, name, email, phone, firm, balance, preferences, active, created_at FROM lead_buyers WHERE id = ?').get(req.buyer.id);
    if (!buyer) return res.status(404).json({ error: 'Buyer not found' });

    const monthStart = new Date();
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

    const recentLeads = db.prepare(`
      SELECT id, doc_type, country, state, score, status, sold_at, sold_price, created_at
      FROM leads WHERE buyer_id = ? ORDER BY created_at DESC LIMIT 20
    `).all(buyer.id);

    const leadsThisMonth = db.prepare(`
      SELECT COUNT(*) as count FROM leads WHERE buyer_id = ? AND sold_at >= ?
    `).get(buyer.id, monthStart.toISOString());

    let preferences = {};
    try { preferences = JSON.parse(buyer.preferences || '{}'); } catch(e) {}

    res.json({
      buyer: { ...buyer, preferences },
      leadsThisMonth: leadsThisMonth.count,
      recentLeads
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/buyers/preferences
router.put('/preferences', verifyBuyer, (req, res) => {
  try {
    const prefs = req.body;
    db.prepare('UPDATE lead_buyers SET preferences = ? WHERE id = ?')
      .run(JSON.stringify(prefs), req.buyer.id);
    res.json({ success: true, message: 'Preferences updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/buyers/leads
router.get('/leads', verifyBuyer, (req, res) => {
  try {
    const leads = db.prepare(`
      SELECT id, doc_type, country, state, score, status, sold_at, sold_price, created_at
      FROM leads WHERE buyer_id = ? ORDER BY created_at DESC
    `).all(req.buyer.id);
    res.json({ leads, total: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/buyers/topup
router.post('/topup', verifyBuyer, (req, res) => {
  const { amount } = req.body;
  const buyer = db.prepare('SELECT name FROM lead_buyers WHERE id = ?').get(req.buyer.id);
  sendTelegram(`💳 Buyer ${buyer?.name || req.buyer.name} wants to add $${amount} — manual invoice needed`).catch(() => {});
  res.json({ success: true, message: 'Top-up request received. We will send you an invoice shortly.' });
});

module.exports = router;
