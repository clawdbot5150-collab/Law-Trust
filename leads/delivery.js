'use strict';
const db = require('../database');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8659195374:AAGVydpl_rMlw-O-Y3dgTNMsvhMq8Bi25WE';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6928347196';
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_eH8YHZH8_Kp2uba6VCoQ2ZkB6rhgWEQHZ';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// --- Helpers ---

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', (e) => { console.error('Telegram error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function callResend(payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', (e) => { console.error('Resend error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function callClaude(prompt) {
  return new Promise((resolve) => {
    if (!ANTHROPIC_API_KEY) return resolve('');
    const body = JSON.stringify({
      model: 'claude-haiku-20240307',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch(e) { resolve(''); }
      });
    });
    req.on('error', (e) => { console.error('Claude error:', e.message); resolve(''); });
    req.write(body);
    req.end();
  });
}

function getLeadValue(score) {
  if (score >= 80) return 120;
  if (score >= 60) return 80;
  if (score >= 40) return 50;
  return 30;
}

function getMatchedProducts(docType, country) {
  try {
    const products = db.prepare('SELECT * FROM products ORDER BY rating DESC').all();
    return products
      .filter(p => {
        const countries = JSON.parse(p.countries || '[]');
        const ct = (country || 'US').toUpperCase();
        return countries.some(c => c.toUpperCase() === ct || ct.includes(c.toUpperCase()));
      })
      .slice(0, 3)
      .map(p => ({ ...p, features: JSON.parse(p.features || '[]') }));
  } catch(e) {
    return [];
  }
}

async function deliverLead(leadId) {
  let lead;
  try {
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
    if (!lead) { console.error('Lead not found:', leadId); return; }
  } catch(e) {
    console.error('Error fetching lead:', e.message); return;
  }

  const score = lead.score || 0;
  const value = getLeadValue(score);
  const ts = new Date().toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC';

  // 1. Telegram notification to Matt
  const tgMsg = `🔥 <b>NEW LEAD — Law-Trust.com</b>

<b>Name:</b> ${lead.name || 'Unknown'}
<b>Email:</b> ${lead.email}
<b>Phone:</b> ${lead.phone || 'not provided'}
<b>Document:</b> ${lead.doc_type}
<b>Country:</b> ${lead.country || ''} ${lead.state || ''}
<b>Timeline:</b> ${lead.timeline || 'Unknown'}
<b>Budget:</b> ${lead.budget || lead.budget_detail || 'Unknown'}
<b>Score:</b> ${score}/100
<b>Est. Value:</b> $${value}

<b>Lead ID:</b> #${lead.id}
<b>Time:</b> ${ts}`;

  sendTelegram(tgMsg).catch(e => console.error('TG error:', e));

  // 2. Email to lead via Resend with Claude personalization
  try {
    const products = getMatchedProducts(lead.doc_type, lead.country);
    const productCount = products.length;

    let emailBody = '';
    try {
      const prompt = `Write a short, warm, professional HTML email body (no <html>/<body> tags, just inner HTML content) for someone who submitted a legal document inquiry.
Details:
- Name: ${lead.name || 'there'}
- Document type: ${lead.doc_type}
- Country: ${lead.country || 'US'}
- Budget: ${lead.budget || lead.budget_detail || 'not specified'}
- Timeline: ${lead.timeline || 'not specified'}

Show 2-3 top services. Keep it under 300 words. Include a friendly opener, a brief explanation of why these services match their needs, and 2-3 service cards.
Services available: ${products.map(p => `${p.name} (from ${p.price_from}) - ${p.tagline}`).join('; ')}

End with: "Our team will follow up within 24 hours if you need personalized guidance."
Use inline CSS for styling. Navy (#1a2744) headers, gold (#c9a84c) accents.`;

      emailBody = await callClaude(prompt);
    } catch(e) {}

    if (!emailBody || emailBody.length < 50) {
      // Fallback email
      emailBody = `<p style="color:#1a2744;font-size:16px;">Hi ${lead.name || 'there'},</p>
<p>Thank you for your inquiry about <strong>${lead.doc_type}</strong>! We've found ${productCount} great option${productCount !== 1 ? 's' : ''} for you.</p>
${products.map(p => `
<div style="border:1px solid #c9a84c;border-radius:8px;padding:16px;margin:12px 0;">
  <h3 style="color:#1a2744;margin:0 0 8px;">${p.name} — from ${p.price_from}</h3>
  <p style="margin:0 0 8px;color:#555;">${p.tagline}</p>
  <a href="https://law-trust.com/go/${p.slug}/email-lead" style="background:#c9a84c;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-weight:bold;">Get Started →</a>
</div>`).join('')}
<p style="color:#555;">Our team will follow up within 24 hours if you need personalized guidance.</p>`;
    }

    await callResend({
      from: 'Law-Trust.com <support@law-trust.com>',
      to: lead.email,
      subject: `Your ${lead.doc_type} options — we found ${productCount} match${productCount !== 1 ? 'es' : ''}`,
      html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:#1a2744;padding:20px;border-radius:8px 8px 0 0;text-align:center;">
  <h1 style="color:#c9a84c;margin:0;font-size:24px;">Law-Trust.com</h1>
  <p style="color:#fff;margin:8px 0 0;">Your Legal Document Matches</p>
</div>
<div style="background:#fff;padding:24px;border:1px solid #eee;border-top:none;border-radius:0 0 8px 8px;">
${emailBody}
</div>
<p style="text-align:center;color:#999;font-size:12px;margin-top:16px;">© 2026 Law-Trust.com | <a href="https://law-trust.com" style="color:#c9a84c;">Visit Site</a></p>
</body></html>`
    });
    console.log('✅ Lead email sent to:', lead.email);
  } catch(e) {
    console.error('Email error:', e.message);
  }

  // 3. Log delivery to analytics
  try {
    db.prepare('INSERT INTO analytics (event, page, ref, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('lead_delivered', 'lead-form', `lead_${leadId}`, '', new Date().toISOString());
  } catch(e) {}

  // 4. Auto-assign to buyer if score >= 60
  if (score >= 60) {
    try {
      const buyers = db.prepare('SELECT * FROM lead_buyers WHERE active = 1').all();
      let matched = null;
      for (const buyer of buyers) {
        let prefs = {};
        try { prefs = JSON.parse(buyer.preferences || '{}'); } catch(e) {}
        const docTypes = prefs.docTypes || [];
        const wantedCountries = prefs.countries || [];
        const pricePerLead = prefs.pricePerLead || 80;

        const docMatch = docTypes.length === 0 || docTypes.some(d =>
          (lead.doc_type || '').toLowerCase().includes(d.toLowerCase()) ||
          d.toLowerCase().includes((lead.doc_type || '').toLowerCase())
        );
        const countryMatch = wantedCountries.length === 0 || wantedCountries.some(c =>
          (lead.country || '').toUpperCase().includes(c.toUpperCase())
        );

        if (docMatch && countryMatch && buyer.balance >= pricePerLead) {
          matched = { buyer, pricePerLead };
          break;
        }
      }

      if (matched) {
        const { buyer, pricePerLead } = matched;
        const now = new Date().toISOString();
        db.prepare('UPDATE leads SET buyer_id = ?, sold_at = ?, sold_price = ?, status = ? WHERE id = ?')
          .run(buyer.id, now, pricePerLead, 'sold', leadId);
        db.prepare('UPDATE lead_buyers SET balance = balance - ? WHERE id = ?')
          .run(pricePerLead, buyer.id);

        // Email buyer
        await callResend({
          from: 'Law-Trust.com <support@law-trust.com>',
          to: buyer.email,
          subject: `🔥 New Lead Delivered: ${lead.doc_type} — ${lead.country}`,
          html: `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
<div style="background:#1a2744;padding:20px;border-radius:8px 8px 0 0;">
  <h1 style="color:#c9a84c;margin:0;">New Lead Delivered</h1>
</div>
<div style="background:#fff;padding:24px;border:1px solid #eee;">
<table style="width:100%;border-collapse:collapse;">
<tr><td style="padding:8px;color:#555;width:140px;"><strong>Name</strong></td><td style="padding:8px;">${lead.name || 'N/A'}</td></tr>
<tr style="background:#f9f9f9;"><td style="padding:8px;"><strong>Email</strong></td><td style="padding:8px;">${lead.email}</td></tr>
<tr><td style="padding:8px;"><strong>Phone</strong></td><td style="padding:8px;">${lead.phone || 'Not provided'}</td></tr>
<tr style="background:#f9f9f9;"><td style="padding:8px;"><strong>Document</strong></td><td style="padding:8px;">${lead.doc_type}</td></tr>
<tr><td style="padding:8px;"><strong>Location</strong></td><td style="padding:8px;">${lead.country || ''} ${lead.state || ''}</td></tr>
<tr style="background:#f9f9f9;"><td style="padding:8px;"><strong>Timeline</strong></td><td style="padding:8px;">${lead.timeline || 'N/A'}</td></tr>
<tr><td style="padding:8px;"><strong>Budget</strong></td><td style="padding:8px;">${lead.budget || lead.budget_detail || 'N/A'}</td></tr>
<tr style="background:#f9f9f9;"><td style="padding:8px;"><strong>Lead Score</strong></td><td style="padding:8px;"><strong style="color:#c9a84c;">${score}/100</strong></td></tr>
<tr><td style="padding:8px;"><strong>Lead ID</strong></td><td style="padding:8px;">#${lead.id}</td></tr>
</table>
<p style="margin-top:16px;color:#555;font-size:14px;">Amount charged: $${pricePerLead} from your balance.</p>
</div>
</body></html>`
        });

        sendTelegram(`💰 Lead #${lead.id} auto-sold to ${buyer.name} for $${pricePerLead}`).catch(() => {});
        console.log(`✅ Lead ${leadId} auto-sold to buyer ${buyer.name}`);
      }
    } catch(e) {
      console.error('Auto-assign error:', e.message);
    }
  }
}

module.exports = { deliverLead };
