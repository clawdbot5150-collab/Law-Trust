const crypto = require('crypto');
const db = require('../database');
const axios = require('axios');

function logAffiliateClick(slug, source, ip) {
  const ip_hash = crypto.createHash('sha256').update(ip || '').digest('hex');
  db.prepare('INSERT INTO affiliate_clicks (product_slug, source, ip_hash, created_at) VALUES (?, ?, ?, ?)').run(
    slug, source, ip_hash, new Date().toISOString()
  );
}

function getAffiliateUrl(slug, source) {
  const product = db.prepare('SELECT affiliate_url FROM products WHERE slug = ?').get(slug);
  if (!product) return null;
  return `${product.affiliate_url}?utm_source=law-trust&utm_medium=comparison&utm_campaign=${source}`;
}

module.exports = { logAffiliateClick, getAffiliateUrl };
