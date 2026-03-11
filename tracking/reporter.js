require('dotenv').config();
const db = require('../database');
const axios = require('axios');

function getDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  const rows = db.prepare(`
    SELECT product_slug, COUNT(*) as clicks
    FROM affiliate_clicks
    WHERE created_at LIKE ?
    GROUP BY product_slug
    ORDER BY clicks DESC
  `).all(`${today}%`);
  
  return {
    date: today,
    total: rows.reduce((s, r) => s + r.clicks, 0),
    byProduct: rows
  };
}

async function checkDropAlert() {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const todayCount = db.prepare(`SELECT COUNT(*) as n FROM affiliate_clicks WHERE created_at LIKE ?`).get(`${today}%`).n;
  const yestCount = db.prepare(`SELECT COUNT(*) as n FROM affiliate_clicks WHERE created_at LIKE ?`).get(`${yesterday}%`).n;

  if (yestCount > 0 && todayCount < yestCount * 0.7) {
    const drop = Math.round((1 - todayCount / yestCount) * 100);
    const msg = `⚠️ Law-Trust alert: affiliate clicks dropped ${drop}% today (${todayCount} vs ${yestCount} yesterday)`;
    await sendTelegram(msg);
    return { alert: true, drop, todayCount, yestCount };
  }
  return { alert: false, todayCount, yestCount };
}

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text
    });
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
}

module.exports = { getDailyReport, checkDropAlert, sendTelegram };
