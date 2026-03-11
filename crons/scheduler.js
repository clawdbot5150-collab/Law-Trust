require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');
const { generateBlogPost } = require('../content/generator');
const { sendTelegram, getDailyReport } = require('../tracking/reporter');
const { processSequences } = require('../email/sequences');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BLOG_TOPICS = [
  'best will maker 2026',
  'LegalZoom vs Trust and Will 2026',
  'how much does a will cost in 2026',
  'power of attorney guide 2026',
  'do I need a living trust in 2026',
  'online trust vs attorney cost 2026',
  'LegalZoom alternatives 2026',
  'estate planning checklist 2026'
];

let topicIndex = 0;

// ── 1. Every 6 hours: check for price changes ──────────────────────────────
cron.schedule('0 */6 * * *', async () => {
  console.log('🔍 Checking affiliate prices...');
  const products = db.prepare('SELECT * FROM products').all();
  
  for (const product of products) {
    try {
      const response = await axios.get(product.affiliate_url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LawTrustBot/1.0)' }
      });
      const $ = cheerio.load(response.data);
      
      // Try to find price on page
      const priceSelectors = ['[data-price]', '.price', '.pricing', '[class*="price"]'];
      let foundPrice = null;
      
      for (const sel of priceSelectors) {
        const el = $(sel).first();
        if (el.length) {
          const text = el.text().trim();
          if (text && text.match(/[\$£€]/)) {
            foundPrice = text.substring(0, 50);
            break;
          }
        }
      }
      
      if (foundPrice && foundPrice !== product.price_from) {
        db.prepare('UPDATE products SET price_from = ?, last_updated = ? WHERE id = ?')
          .run(foundPrice, new Date().toISOString(), product.id);
        await sendTelegram(`💰 Price change detected on ${product.name}: ${product.price_from} → ${foundPrice}`);
      }
    } catch (e) {
      // Silently skip — sites may block scraping
    }
  }
});

// ── 2. Daily 7 AM: morning briefing ───────────────────────────────────────
cron.schedule('0 7 * * *', async () => {
  try {
    const report = getDailyReport();
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    
    const leads = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE created_at LIKE ?`).get(`${yesterday}%`);
    const events = db.prepare(`SELECT page, COUNT(*) as n FROM analytics WHERE created_at LIKE ? GROUP BY page ORDER BY n DESC LIMIT 3`).all(`${yesterday}%`);
    
    const topPages = events.map(e => `  ${e.page || 'home'}: ${e.n} views`).join('\n') || '  No data yet';
    
    const msg = `📊 Law-Trust Morning Report (${yesterday})
━━━━━━━━━━━━━━━━
🔗 Affiliate clicks: ${report.total}
📧 New leads: ${leads.n}
🏆 Top products: ${report.byProduct.slice(0, 3).map(p => `${p.product_slug}(${p.clicks})`).join(', ') || 'none'}
📄 Top pages:
${topPages}`;

    await sendTelegram(msg);
  } catch (e) {
    console.error('Morning briefing error:', e.message);
  }
});

// ── 3. Daily 10 AM: auto-generate blog post ───────────────────────────────
cron.schedule('0 10 * * *', async () => {
  try {
    const topic = BLOG_TOPICS[topicIndex % BLOG_TOPICS.length];
    topicIndex++;
    
    console.log(`📝 Generating blog post: ${topic}`);
    const post = await generateBlogPost(topic, 'US');
    
    await sendTelegram(`📝 New draft: "${post.title}" (ID: ${post.id}) — reply 'publish ${post.id}' to publish`);
  } catch (e) {
    console.error('Blog gen error:', e.message);
    await sendTelegram(`❌ Blog generation failed: ${e.message}`);
  }
});

// ── 4. Daily 6 PM: process email sequences ────────────────────────────────
cron.schedule('0 18 * * *', async () => {
  try {
    console.log('📧 Processing email sequences...');
    const results = await processSequences();
    console.log(`✅ Sent ${results.length} emails`);
  } catch (e) {
    console.error('Email sequence error:', e.message);
  }
});

// ── 5. Weekly Monday 9 AM: SEO audit ─────────────────────────────────────
cron.schedule('0 9 * * 1', async () => {
  try {
    const posts = db.prepare('SELECT COUNT(*) as n FROM blog_posts').get();
    const clicks = db.prepare('SELECT COUNT(*) as n FROM affiliate_clicks WHERE created_at >= datetime("now", "-7 days")').get();
    const leads = db.prepare('SELECT COUNT(*) as n FROM leads WHERE created_at >= datetime("now", "-7 days")').get();
    
    const prompt = `Write a brief weekly SEO and affiliate performance audit for a legal document comparison site with these metrics:
- Total blog posts: ${posts.n}
- Affiliate clicks (last 7 days): ${clicks.n}
- New leads (last 7 days): ${leads.n}
- Products tracked: Trust & Will, LegalZoom, Rocket Lawyer, Fabric, Nolo, Willful

Give 3 specific action items to improve performance this week. Keep it under 200 words.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const report = response.content[0].text;
    await sendTelegram(`📈 Weekly SEO Audit:\n\n${report}`);
  } catch (e) {
    console.error('Weekly audit error:', e.message);
  }
});

// ── 6. First of month: monthly revenue report ─────────────────────────────
cron.schedule('0 9 1 * *', async () => {
  try {
    const month = new Date().toISOString().slice(0, 7);
    const lastMonth = new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().slice(0, 7);
    
    const clicks = db.prepare(`SELECT product_slug, COUNT(*) as n FROM affiliate_clicks WHERE created_at LIKE ? GROUP BY product_slug ORDER BY n DESC`).all(`${lastMonth}%`);
    const leads = db.prepare(`SELECT COUNT(*) as n FROM leads WHERE created_at LIKE ?`).get(`${lastMonth}%`);
    const posts = db.prepare(`SELECT COUNT(*) as n FROM blog_posts WHERE created_at LIKE ?`).get(`${lastMonth}%`);
    
    const metricsText = clicks.map(c => `${c.product_slug}: ${c.n} clicks`).join('\n') || 'No clicks recorded';
    
    const prompt = `Write a monthly revenue report for a legal document affiliate site for ${lastMonth}:
- Total affiliate clicks: ${clicks.reduce((s, c) => s + c.n, 0)}
- By product:\n${metricsText}
- New leads: ${leads.n}
- New blog posts: ${posts.n}

Estimate potential affiliate revenue (assume $20-50 average commission per conversion at 2% conversion rate).
Give 3 recommendations for next month.
Keep it under 300 words.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 768,
      messages: [{ role: 'user', content: prompt }]
    });
    
    const reportText = response.content[0].text;
    
    // Save to file
    const fs = require('fs');
    const path = require('path');
    const reportsDir = path.join(__dirname, '../reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, `monthly_${lastMonth}.txt`), reportText);
    
    await sendTelegram(`📅 Monthly Report (${lastMonth}):\n\n${reportText.substring(0, 800)}`);
  } catch (e) {
    console.error('Monthly report error:', e.message);
  }
});

console.log('⏰ All cron jobs registered');
