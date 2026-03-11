require('dotenv').config();
const nodemailer = require('nodemailer');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmail(to, subject, html) {
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      html
    });
    console.log(`✅ Email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`❌ Email failed to ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

const EMAIL_SEQUENCES = [
  {
    day: 0,
    subject: 'Your free legal document guide is here 📋',
    topic: 'welcome and introduce law-trust.com as a free comparison resource for online legal documents'
  },
  {
    day: 2,
    subject: 'The #1 mistake people make with online wills',
    topic: 'the most common mistake people make when creating an online will (not updating it), and how to avoid it'
  },
  {
    day: 5,
    subject: 'How Sarah saved $1,400 on her estate plan',
    topic: 'a story about how an average person saved over $1,400 by using an online will service instead of an attorney'
  },
  {
    day: 10,
    subject: 'Last chance: Limited-time discount on Trust & Will',
    topic: 'a last chance reminder about getting started with estate planning, mentioning Trust & Will special pricing'
  }
];

async function personalizeEmail(topic, country, docType, name) {
  try {
    const prompt = `Write a personalized email body (HTML) about: ${topic}.
The reader is from ${country || 'US'} and is interested in: ${docType || 'estate planning'}.
${name ? `Address them as: ${name}` : 'Use a generic greeting.'}
Keep it to 150-200 words. Friendly, helpful tone. Include 1 clear CTA button to https://law-trust.com.
Return ONLY the HTML body content (no <html>/<body> tags, just the inner content).`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content[0].text;
  } catch (e) {
    // fallback template
    return `<p>Hi there,</p><p>${topic}</p><p><a href="https://law-trust.com" style="background:#0A1628;color:#D4AF37;padding:12px 24px;text-decoration:none;border-radius:4px;">Visit Law-Trust.com →</a></p>`;
  }
}

async function processSequences() {
  const results = [];
  const now = new Date();
  
  for (const seq of EMAIL_SEQUENCES) {
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() - seq.day);
    const targetDateStr = targetDate.toISOString().split('T')[0];
    
    const leads = db.prepare(`
      SELECT * FROM leads WHERE created_at LIKE ? AND email IS NOT NULL
    `).all(`${targetDateStr}%`);
    
    for (const lead of leads) {
      // Check if already sent this sequence
      const alreadySent = db.prepare(`
        SELECT id FROM analytics WHERE event = ? AND ref = ? LIMIT 1
      `).get(`email_sent_day${seq.day}`, lead.email);
      
      if (alreadySent) continue;
      
      const html = await personalizeEmail(seq.topic, lead.country, lead.doc_type, null);
      const fullHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><style>
          body { font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #0A1628, #1a2d4f); padding: 20px; border-radius: 8px 8px 0 0; }
          .header h1 { color: #D4AF37; margin: 0; font-size: 24px; }
          .content { background: #fff; padding: 30px; border: 1px solid #eee; }
          .footer { background: #f9f9f9; padding: 15px; font-size: 12px; color: #666; border-radius: 0 0 8px 8px; }
        </style></head>
        <body>
          <div class="header"><h1>⚖️ Law-Trust</h1></div>
          <div class="content">${html}</div>
          <div class="footer">You're receiving this because you signed up at law-trust.com. <a href="#">Unsubscribe</a></div>
        </body>
        </html>`;
      
      const result = await sendEmail(lead.email, seq.subject, fullHtml);
      
      if (result.success) {
        db.prepare('INSERT INTO analytics (event, page, ref, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
          `email_sent_day${seq.day}`, 'email', lead.email, '', new Date().toISOString()
        );
        results.push({ email: lead.email, day: seq.day, success: true });
      }
    }
  }
  
  console.log(`📧 Processed ${results.length} email sequences`);
  return results;
}

module.exports = { sendEmail, processSequences };
