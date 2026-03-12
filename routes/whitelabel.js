/**
 * Law-Trust White Label API Routes
 * Integrates with LegalWills / PartingWishes White Label API
 * Endpoint: https://legalwills.services/whitelabel
 */
require('dotenv').config();
const express = require('express');
const router = express.Router();
const db = require('../database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const axios = require('axios');
const qs = require('querystring');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const WL_URL = process.env.WL_API_URL || 'https://legalwills.services/whitelabel';
const AFFILIATE_ID = process.env.WL_AFFILIATE_ID;
const AFFILIATE_SIG = process.env.WL_AFFILIATE_SIGNATURE;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://law-trust.com';

// ─── Service catalog ──────────────────────────────────────────────────────────
const SERVICES = {
  mywill:              { label: 'Last Will & Testament',          price: 4900,  key: 'MYWILL' },
  mypowerofattorney:   { label: 'Power of Attorney',              price: 3900,  key: 'MYPOWEROFATTORNEY' },
  mylivingwill:        { label: 'Living Will / Healthcare Dir.',  price: 2900,  key: 'MYLIVINGWILL' },
  mylifelocker:        { label: 'Life Locker',                    price: 1900,  key: 'MYLIFELOCKER' },
  myfuneral:           { label: 'Funeral & Organ Wishes',         price: 1900,  key: 'MYFUNERAL' },
  myexpatwill_us:      { label: 'Expat Will (US Assets)',         price: 5900,  key: 'MYEXPATWILL_US' },
  myexpatwill_canada:  { label: 'Expat Will (Canada Assets)',     price: 5900,  key: 'MYEXPATWILL_CANADA' },
  myexpatwill_quebec:  { label: 'Expat Will (Québec Assets)',     price: 5900,  key: 'MYEXPATWILL_QUEBEC' },
  myexpatwill_uk:      { label: 'Expat Will (UK Assets)',         price: 5900,  key: 'MYEXPATWILL_UK' },
};

const BUNDLES = {
  bundle_estate: {
    label: 'Estate Package (Will + POA + Living Will)',
    price: 8900,
    services: ['mywill', 'mypowerofattorney', 'mylivingwill']
  },
  bundle_full: {
    label: 'Full Estate Package (All 5 Documents)',
    price: 11900,
    services: ['mywill', 'mypowerofattorney', 'mylivingwill', 'mylifelocker', 'myfuneral']
  }
};

// ─── Helper: call LegalWills API ──────────────────────────────────────────────
async function wlApi(params) {
  try {
    const body = qs.stringify({
      AFFILIATE_ID,
      AFFILIATE_SIGNATURE: AFFILIATE_SIG,
      ...params
    });
    const resp = await axios.post(WL_URL, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    return qs.parse(resp.data) || { ResultCode: resp.data };
  } catch (err) {
    console.error('[WL API Error]', err.message);
    return { ResultCode: 'ERROR', error: err.message };
  }
}

// ─── Helper: encrypt a value via LegalWills encrypt command ──────────────────
async function wlEncrypt(value) {
  const result = await wlApi({ CMD: 'encrypt', VALUE: value });
  return result.EncryptedValue || result.ResultCode || value;
}

// ─── Helper: generate unique WL credentials ──────────────────────────────────
function generateWlCreds() {
  const userid = 'lt_' + crypto.randomBytes(8).toString('hex'); // lt_ + 16 hex chars = 19 chars
  const password = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  return { userid, password };
}

// ─── Helper: session auth middleware ─────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'] || req.body?.session_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const user = db.prepare(
    "SELECT * FROM wl_users WHERE session_token = ? AND session_expires > datetime('now')"
  ).get(token);
  if (!user) return res.status(401).json({ error: 'Session expired' });
  req.wlUser = user;
  next();
}

// ─── POST /api/wl/register ────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  const { email, password, first_name, last_name, country, stateprov, city,
          address_line1, postalcode, gender } = req.body;

  if (!email || !password || !first_name || !last_name || !country) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const validCountries = ['Canada','United States','South Africa',
                          'United Kingdom - England','United Kingdom - Wales'];
  if (!validCountries.includes(country)) {
    return res.status(400).json({ error: 'Unsupported country', validCountries });
  }

  const existing = db.prepare('SELECT id FROM wl_users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const { userid, password: wlPass } = generateWlCreds();

    // Create user in LegalWills database
    const wlResult = await wlApi({
      CMD: 'create_user',
      USERID: userid,
      PASSWORD: wlPass,
      FIRST_NAME: first_name,
      LAST_NAME: last_name,
      EMAIL: email,
      COUNTRY: country,
      ...(stateprov && { STATEPROV: stateprov }),
      ...(city && { CITY: city }),
      ...(address_line1 && { ADDRESS_LINE1: address_line1 }),
      ...(postalcode && { POSTALCODE: postalcode }),
      ...(gender && { GENDER: gender }),
      MEM_YEARS: '1',
      TEST_USER: 'N'
    });

    const wlCreated = wlResult.ResultCode === 'OK' ? 1 : 0;
    if (!wlCreated) {
      console.warn('[WL] create_user returned:', wlResult.ResultCode,
        '— storing user locally anyway');
    }

    // Generate session
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 19).replace('T', ' ');

    db.prepare(`
      INSERT INTO wl_users
        (email, password_hash, first_name, last_name, country, stateprov, city,
         address_line1, postalcode, gender, wl_userid, wl_password, wl_created,
         session_token, session_expires)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(email, passwordHash, first_name, last_name, country,
           stateprov || null, city || null, address_line1 || null,
           postalcode || null, gender || 'X', userid, wlPass, wlCreated,
           sessionToken, sessionExpires);

    const user = db.prepare('SELECT * FROM wl_users WHERE email = ?').get(email);
    res.json({
      success: true,
      session_token: sessionToken,
      user: sanitizeUser(user),
      wl_status: wlResult.ResultCode
    });
  } catch (err) {
    console.error('[Register Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/wl/login ───────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Missing credentials' });

  const user = db.prepare('SELECT * FROM wl_users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

  const sessionToken = crypto.randomBytes(32).toString('hex');
  const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ');

  db.prepare("UPDATE wl_users SET session_token=?, session_expires=?, updated_at=datetime('now') WHERE id=?")
    .run(sessionToken, sessionExpires, user.id);

  res.json({ success: true, session_token: sessionToken, user: sanitizeUser(user) });
});

// ─── GET /api/wl/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: sanitizeUser(req.wlUser) });
});

// ─── POST /api/wl/logout ──────────────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  db.prepare("UPDATE wl_users SET session_token=NULL, session_expires=NULL WHERE id=?")
    .run(req.wlUser.id);
  res.json({ success: true });
});

// ─── GET /api/wl/services ─────────────────────────────────────────────────────
router.get('/services', (req, res) => {
  res.json({ services: SERVICES, bundles: BUNDLES });
});

// ─── POST /api/wl/launch ─────────────────────────────────────────────────────
// Returns encrypted USERID + PASSWORD for the iframe login form
router.post('/launch', requireAuth, async (req, res) => {
  const { service_name } = req.body;
  const user = req.wlUser;

  const validServices = ['mywill','mypowerofattorney','mylivingwill',
    'myexpatwill_us','myexpatwill_canada','myexpatwill_quebec','myexpatwill_uk',
    'mylifelocker','myfuneral'];

  if (!validServices.includes(service_name?.toLowerCase())) {
    return res.status(400).json({ error: 'Invalid service name' });
  }

  // If WL credentials not yet created, create user now
  if (!user.wl_created) {
    const wlResult = await wlApi({
      CMD: 'create_user',
      USERID: user.wl_userid,
      PASSWORD: user.wl_password,
      FIRST_NAME: user.first_name,
      LAST_NAME: user.last_name,
      EMAIL: user.email,
      COUNTRY: user.country,
      ...(user.stateprov && { STATEPROV: user.stateprov }),
      MEM_YEARS: '1',
      TEST_USER: 'N'
    });
    if (wlResult.ResultCode === 'OK' || wlResult.ResultCode === 'USER_EXISTS') {
      db.prepare("UPDATE wl_users SET wl_created=1 WHERE id=?").run(user.id);
    }
  }

  try {
    // Validate login first
    const validation = await wlApi({
      CMD: 'validate_login',
      USERID: user.wl_userid,
      PASSWORD: user.wl_password
    });

    if (validation.ResultCode !== 'OK' && validation.ResultCode !== 'MEM_EXPIRED') {
      return res.status(400).json({
        error: 'Account validation failed',
        code: validation.ResultCode
      });
    }

    // Encrypt credentials (5-min TTL)
    const [encUserId, encPassword] = await Promise.all([
      wlEncrypt(user.wl_userid),
      wlEncrypt(user.wl_password)
    ]);

    res.json({
      success: true,
      wl_url: WL_URL,
      affiliate_id: AFFILIATE_ID,
      encrypted_userid: encUserId,
      encrypted_password: encPassword,
      service_name: service_name.toLowerCase()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/wl/checkout ────────────────────────────────────────────────────
router.post('/checkout', requireAuth, async (req, res) => {
  const { items } = req.body; // Array of service keys or bundle keys
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'No items provided' });
  }

  const user = req.wlUser;
  let lineItems = [];
  let servicesToUnlock = new Set();

  for (const item of items) {
    if (BUNDLES[item]) {
      const bundle = BUNDLES[item];
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: bundle.label, description: 'Law-Trust.com Estate Planning' },
          unit_amount: bundle.price
        },
        quantity: 1
      });
      bundle.services.forEach(s => servicesToUnlock.add(s));
    } else if (SERVICES[item]) {
      const svc = SERVICES[item];
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: svc.label, description: 'Law-Trust.com Estate Planning' },
          unit_amount: svc.price
        },
        quantity: 1
      });
      servicesToUnlock.add(item);
    }
  }

  if (lineItems.length === 0) return res.status(400).json({ error: 'Invalid items' });

  const totalCents = lineItems.reduce((sum, li) => sum + li.price_data.unit_amount, 0);
  const servicesStr = Array.from(servicesToUnlock).join(',');

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${FRONTEND_URL}/estate-planning/dashboard.html?payment=success`,
      cancel_url: `${FRONTEND_URL}/estate-planning/dashboard.html?payment=cancelled`,
      customer_email: user.email,
      metadata: {
        wl_user_id: String(user.id),
        wl_userid: user.wl_userid,
        services: servicesStr
      }
    });

    // Record pending purchase
    db.prepare(`
      INSERT INTO wl_purchases (wl_user_id, stripe_session_id, services, amount_cents, status)
      VALUES (?,?,?,?,'pending')
    `).run(user.id, session.id, servicesStr, totalCents);

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    console.error('[Stripe checkout error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/wl/webhook (Stripe) ───────────────────────────────────────────
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET_LAWTRUST
    );
  } catch (err) {
    console.error('[Webhook sig error]', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { wl_user_id, wl_userid, services } = session.metadata;

    if (!wl_userid || !services) {
      return res.json({ received: true });
    }

    const serviceList = services.split(',').filter(Boolean);
    const wlParams = { CMD: 'modify_user', USERID: wl_userid, MEM_YEARS: '1', MEM_YEARS_OP: 'add' };

    for (const svc of serviceList) {
      const s = SERVICES[svc];
      if (s) wlParams[s.key] = 'Y';
    }

    const wlResult = await wlApi(wlParams);
    console.log('[WL modify_user]', wl_userid, services, '->', wlResult.ResultCode);

    // Update our DB
    const updateFields = serviceList.map(s => `${s} = 1`).join(', ');
    db.prepare(`UPDATE wl_users SET ${updateFields}, updated_at=datetime('now') WHERE id=?`)
      .run(parseInt(wl_user_id));

    db.prepare(`UPDATE wl_purchases SET status='completed', stripe_payment_intent=?
                WHERE stripe_session_id=?`)
      .run(session.payment_intent, session.id);
  }

  res.json({ received: true });
});

// ─── GET /api/wl/status/:service ─────────────────────────────────────────────
router.get('/status/:service', requireAuth, async (req, res) => {
  const service = req.params.service.toLowerCase();
  const user = req.wlUser;

  if (service === 'mywill') {
    const result = await wlApi({ CMD: 'query_mywill', USERID: user.wl_userid });
    return res.json(result);
  }

  const expired = await wlApi({ CMD: 'query_if_expired', USERID: user.wl_userid });
  res.json({ ...expired, service, paid: !!user[service] });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitizeUser(user) {
  const { password_hash, wl_userid, wl_password, session_token, ...safe } = user;
  return safe;
}

module.exports = router;
