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

// ─── Helper: call LegalWills API (key=value response) ────────────────────────
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
    // Most commands return URL-encoded key=value (e.g. ResultCode=OK)
    // Parse that, falling back to treating the whole body as ResultCode
    const parsed = qs.parse(resp.data);
    return Object.keys(parsed).length > 0 ? parsed : { ResultCode: resp.data.trim() };
  } catch (err) {
    console.error('[WL API Error]', err.message);
    return { ResultCode: 'ERROR', error: err.message };
  }
}

// ─── Helper: encrypt a value via LegalWills encrypt command ──────────────────
// The encrypt command returns a raw encrypted string (NOT key=value format).
// Must use STR (not VALUE) as the parameter name per API docs.
async function wlEncrypt(value) {
  try {
    const body = qs.stringify({
      CMD: 'encrypt',
      AFFILIATE_ID,
      AFFILIATE_SIGNATURE: AFFILIATE_SIG,
      STR: value          // ← correct parameter name per API docs
    });
    const resp = await axios.post(WL_URL, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });
    // Response is the raw encrypted string (not key=value)
    const enc = resp.data?.trim();
    if (!enc) throw new Error('Empty encrypt response');
    return enc;
  } catch (err) {
    console.error('[WL Encrypt Error]', err.message);
    throw err;
  }
}

// ─── Helper: generate unique WL credentials ──────────────────────────────────
function generateWlCreds() {
  const userid = 'lt_' + crypto.randomBytes(8).toString('hex'); // 19 chars, unique
  const password = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  return { userid, password };
}

// ─── Result code map — user-facing messages + severity ───────────────────────
const WL_RESULT = {
  // ✅ Success / acceptable
  OK:                       { ok: true,  retry: false, msg: null },
  MEM_EXPIRED:              { ok: true,  retry: false, msg: null, warn: 'Membership expired — document preview only. Renew to download.' },
  EXISTING_USERID:          { ok: false, retry: true,  msg: 'UserID collision — retrying with new ID.' },

  // 🔄 Retriable errors
  ENCRYPTION_EXPIRED:       { ok: false, retry: true,  msg: 'Session token expired — retrying.' },
  DECRYPTION_FAILURE:       { ok: false, retry: true,  msg: 'Encryption error — retrying.' },
  NO_SUCH_USERID:           { ok: false, retry: true,  msg: 'Account not found on service — recreating.' },

  // 🚨 Admin alerts (something is seriously wrong on our end)
  INVALID_CREDENTIALS:      { ok: false, retry: false, alert: true, msg: 'Affiliate credentials are invalid. Contact support.' },
  BANNED_IP:                { ok: false, retry: false, alert: true, msg: 'Server IP address has been banned. Email support@uslegalwills.com immediately.' },
  SUSPENDED_USERID:         { ok: false, retry: false, alert: true, msg: 'This user account has been suspended. Email support@uslegalwills.com.' },
  BANNED_USERID:            { ok: false, retry: false, alert: true, msg: 'This user account has been banned. Email support@uslegalwills.com.' },

  // ⚠️ User data errors (fixable by the user)
  BAD_ADDRESS_LINE1:        { ok: false, retry: false, msg: 'Address line 1 is too long (max 128 characters).' },
  BAD_ADDRESS_LINE2:        { ok: false, retry: false, msg: 'Address line 2 is too long (max 128 characters).' },
  BAD_CITY:                 { ok: false, retry: false, msg: 'City name is too long (max 64 characters).' },
  BAD_COUNTRY:              { ok: false, retry: false, msg: 'Country name is too long (max 64 characters).' },
  BAD_EMAIL:                { ok: false, retry: false, msg: 'Email address must be between 1 and 64 characters.' },
  BAD_FIRST_NAME:           { ok: false, retry: false, msg: 'First name must be between 1 and 64 characters.' },
  BAD_LAST_NAME:            { ok: false, retry: false, msg: 'Last name must be between 1 and 64 characters.' },
  BAD_PASSWORD:             { ok: false, retry: false, msg: 'Password must be between 5 and 64 characters.' },
  BAD_POSTALCODE:           { ok: false, retry: false, msg: 'Postal/ZIP code is too long (max 32 characters).' },
  BAD_STATEPROV:            { ok: false, retry: false, msg: 'State/province name is too long (max 64 characters).' },
  BAD_USERID:               { ok: false, retry: false, msg: 'Invalid UserID format.' },
  DUPLICATE_USER:           { ok: false, retry: false, msg: 'An account with this name and email already exists. Please sign in instead.' },
  INVALID_COUNTRY:          { ok: false, retry: false, msg: 'The selected country is not supported for document creation.' },
  INVALID_EMAIL:            { ok: false, retry: false, msg: 'Invalid email address format.' },
  INVALID_GENDER:           { ok: false, retry: false, msg: 'Invalid gender value.' },
  INVALID_LOGIN:            { ok: false, retry: false, msg: 'Invalid login credentials. Please contact support.' },
  INVALID_SERVICE_NAME:     { ok: false, retry: false, msg: 'Invalid document type requested.' },
  INVALID_STATEPROV:        { ok: false, retry: false, msg: 'Invalid state/province. Please check the spelling.' },
  INVALID_MEM_YEARS:        { ok: false, retry: false, msg: 'Invalid membership duration.' },
  INVALID_MEM_YEARS_OP:     { ok: false, retry: false, msg: 'Invalid membership operation.' },
  MISSING_COUNTRY:          { ok: false, retry: false, msg: 'Country is required.' },
  MISSING_EMAIL:            { ok: false, retry: false, msg: 'Email is required.' },
  MISSING_FIRST_NAME:       { ok: false, retry: false, msg: 'First name is required.' },
  MISSING_LAST_NAME:        { ok: false, retry: false, msg: 'Last name is required.' },
  MISSING_PASSWORD:         { ok: false, retry: false, msg: 'Password is required.' },
  MISSING_SERVICE_NAME:     { ok: false, retry: false, msg: 'Document type is required.' },
  MISSING_USERID:           { ok: false, retry: false, msg: 'UserID is required.' },
  IS_LIFETIME:              { ok: false, retry: false, msg: 'User already has a lifetime membership.' },
  IS_NOT_LIFETIME:          { ok: false, retry: false, msg: 'User does not have a lifetime membership.' },
  TOO_FEW_YEARS:            { ok: false, retry: false, msg: 'This would result in less than 1 year of membership.' },
  TOO_MANY_YEARS:           { ok: false, retry: false, msg: 'This would exceed the maximum membership length.' },

  // Service flag errors (should never happen in normal flow — indicates code bug)
  INVALID_MYWILL:           { ok: false, retry: false, msg: 'Internal error: invalid MYWILL flag.', bug: true },
  INVALID_MYPOWEROFATTORNEY:{ ok: false, retry: false, msg: 'Internal error: invalid MYPOWEROFATTORNEY flag.', bug: true },
  INVALID_MYLIVINGWILL:     { ok: false, retry: false, msg: 'Internal error: invalid MYLIVINGWILL flag.', bug: true },
  INVALID_MYLIFELOCKER:     { ok: false, retry: false, msg: 'Internal error: invalid MYLIFELOCKER flag.', bug: true },
  INVALID_MYFUNERAL:        { ok: false, retry: false, msg: 'Internal error: invalid MYFUNERAL flag.', bug: true },
  INVALID_MYEXPATWILL_US:   { ok: false, retry: false, msg: 'Internal error: invalid MYEXPATWILL_US flag.', bug: true },
  INVALID_MYEXPATWILL_CANADA:{ ok: false, retry: false, msg: 'Internal error: invalid MYEXPATWILL_CANADA flag.', bug: true },
  INVALID_MYEXPATWILL_QUEBEC:{ ok: false, retry: false, msg: 'Internal error: invalid MYEXPATWILL_QUEBEC flag.', bug: true },
  INVALID_MYEXPATWILL_UK:   { ok: false, retry: false, msg: 'Internal error: invalid MYEXPATWILL_UK flag.', bug: true },
  INVALID_CMD:              { ok: false, retry: false, msg: 'Internal error: invalid API command.', bug: true },
};

// ─── Interpret a WL result code and optionally send an admin alert ────────────
function interpretResult(code, context = '') {
  const entry = WL_RESULT[code] || { ok: false, retry: false, msg: `Unexpected error: ${code}` };

  if (entry.alert || entry.bug) {
    const level = entry.bug ? '🐛 BUG' : '🚨 ALERT';
    console.error(`[WL ${level}] ${code} — ${context} — ${entry.msg}`);
    // Send Telegram alert for critical issues
    alertAdmin(`${level}: LegalWills API returned ${code}\n${context}\n${entry.msg}`);
  } else if (!entry.ok && !entry.retry) {
    console.warn(`[WL WARN] ${code} — ${context}`);
  }

  return entry;
}

// ─── Telegram admin alert ─────────────────────────────────────────────────────
async function alertAdmin(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '8659195374:AAGVydpl_rMlw-O-Y3dgTNMsvhMq8Bi25WE';
  const chatId = process.env.TELEGRAM_CHAT_ID || '6928347196';
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: `⚖️ Law-Trust WL API Alert\n\n${message}`,
      parse_mode: 'HTML'
    });
  } catch (e) {
    console.error('[Alert Error]', e.message);
  }
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
    let { userid, password: wlPass } = generateWlCreds();

    // Build the create_user payload
    const buildPayload = (uid, pwd) => ({
      CMD: 'create_user',
      USERID: uid,
      PASSWORD: pwd,
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

    // Create user in LegalWills database (auto-retry on EXISTING_USERID)
    let wlResult = await wlApi(buildPayload(userid, wlPass));
    let entry = interpretResult(wlResult.ResultCode, `register: ${email}`);

    if (entry.retry && wlResult.ResultCode === 'EXISTING_USERID') {
      // Collision — regenerate credentials and try once more
      const fresh = generateWlCreds();
      userid = fresh.userid; wlPass = fresh.password;
      wlResult = await wlApi(buildPayload(userid, wlPass));
      entry = interpretResult(wlResult.ResultCode, `register retry: ${email}`);
    }

    // DUPLICATE_USER means same first+last+email exists under a different UID
    if (wlResult.ResultCode === 'DUPLICATE_USER') {
      return res.status(409).json({ error: entry.msg });
    }

    // Hard failures from invalid credentials / banned IP — abort
    if (entry.alert) {
      return res.status(503).json({ error: 'Service temporarily unavailable. Please try again later.' });
    }

    // For any other non-OK code, we store locally and sync later
    const wlCreated = (wlResult.ResultCode === 'OK') ? 1 : 0;
    if (!wlCreated) {
      console.warn('[WL] create_user returned:', wlResult.ResultCode, '— storing locally, will sync on first launch');
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

  // ── Ensure WL account exists (lazy creation / re-creation) ──────────────────
  const ensureWlUser = async () => {
    const r = await wlApi({
      CMD: 'create_user',
      USERID: user.wl_userid, PASSWORD: user.wl_password,
      FIRST_NAME: user.first_name, LAST_NAME: user.last_name,
      EMAIL: user.email, COUNTRY: user.country,
      ...(user.stateprov && { STATEPROV: user.stateprov }),
      MEM_YEARS: '1', TEST_USER: 'N'
    });
    // OK = created, EXISTING_USERID = already there — both are fine
    if (r.ResultCode === 'OK' || r.ResultCode === 'EXISTING_USERID') {
      db.prepare("UPDATE wl_users SET wl_created=1 WHERE id=?").run(user.id);
      return true;
    }
    interpretResult(r.ResultCode, `ensureWlUser: ${user.email}`);
    return false;
  };

  if (!user.wl_created) await ensureWlUser();

  try {
    // ── Helper: full encrypt + validate cycle, returns {encUserId, encPassword} ─
    const encryptAndValidate = async () => {
      const [encUserId, encPassword] = await Promise.all([
        wlEncrypt(user.wl_userid),
        wlEncrypt(user.wl_password)
      ]);
      const validation = await wlApi({
        CMD: 'validate_login',
        USERID: encUserId,
        PASSWORD: encPassword,
        SERVICE_NAME: service_name.toLowerCase()
      });
      return { encUserId, encPassword, code: validation.ResultCode };
    };

    let { encUserId, encPassword, code } = await encryptAndValidate();
    let entry = interpretResult(code, `launch: ${user.email} → ${service_name}`);

    // ── Auto-retry cases ──────────────────────────────────────────────────────
    if (code === 'ENCRYPTION_EXPIRED' || code === 'DECRYPTION_FAILURE') {
      // Encrypted values staled — re-encrypt immediately and retry once
      console.log('[WL] Re-encrypting after', code);
      ({ encUserId, encPassword, code } = await encryptAndValidate());
      entry = interpretResult(code, `launch retry (re-encrypt): ${user.email}`);
    }

    if (code === 'NO_SUCH_USERID') {
      // Account vanished from LegalWills DB — recreate and retry
      console.log('[WL] NO_SUCH_USERID — recreating WL account for', user.email);
      const ok = await ensureWlUser();
      if (!ok) return res.status(503).json({ error: 'Could not recreate document account. Please contact support.' });
      ({ encUserId, encPassword, code } = await encryptAndValidate());
      entry = interpretResult(code, `launch retry (recreate): ${user.email}`);
    }

    // ── Hard failures ─────────────────────────────────────────────────────────
    if (entry.alert) {
      return res.status(503).json({ error: 'Service temporarily unavailable. Our team has been alerted.' });
    }

    // ── Non-retriable failures ────────────────────────────────────────────────
    if (!entry.ok && !entry.retry) {
      return res.status(400).json({
        error: entry.msg || 'Could not open document editor.',
        code
      });
    }

    // ── MEM_EXPIRED — allow through but inform frontend to show upsell ────────
    const memExpired = (code === 'MEM_EXPIRED');

    // ── Success — return encrypted credentials for iframe POST form ───────────
    res.json({
      success: true,
      wl_url: WL_URL,
      affiliate_id: AFFILIATE_ID,
      encrypted_userid: encUserId,
      encrypted_password: encPassword,
      service_name: service_name.toLowerCase(),
      mem_expired: memExpired,
      mem_warning: memExpired ? 'Your membership has expired. You can still edit your document, but can only download the first page. Renew to download the full document.' : null
    });
  } catch (err) {
    console.error('[WL Launch Error]', err.message);
    res.status(500).json({ error: 'Failed to open document editor. Please try again.' });
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
