require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

async function generateBlogPost(topic, country = 'US') {
  const prompt = `Write a comprehensive SEO blog post about: "${topic}" for an audience in ${country}.

Requirements:
- Length: 1000-1200 words
- Include a compelling H1 title
- Use H2 subheadings throughout  
- Include a FAQ section at the end with 5 Q&A pairs
- SEO-optimized: include the main keyword naturally 4-6 times
- Tone: helpful, authoritative but approachable
- Include specific pricing data where relevant (Trust & Will from $69, LegalZoom from $99, Rocket Lawyer $39.99/mo, Fabric free, Nolo $59.99, Willful CAD $99 for Canada)
- End with a clear CTA to compare services at law-trust.com
- Do NOT use markdown code blocks — just plain text with # for H1, ## for H2

Format your response as JSON:
{
  "title": "...",
  "slug": "...",
  "metaDescription": "...(150-160 chars)",
  "content": "full article with # H1, ## H2 headers..."
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  let result;
  try {
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch[0]);
  } catch (e) {
    // fallback: build from raw text
    const text = response.content[0].text;
    result = {
      title: topic,
      slug: slugify(topic),
      metaDescription: `Complete guide to ${topic}. Compare the best options, prices, and features for ${country} residents.`,
      content: text
    };
  }

  if (!result.slug) result.slug = slugify(result.title || topic);

  // Save to DB
  try {
    db.prepare(`
      INSERT OR REPLACE INTO blog_posts (slug, title, content, meta_desc, published, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(result.slug, result.title, result.content, result.metaDescription, new Date().toISOString());
    
    const saved = db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(result.slug);
    result.id = saved?.id;
  } catch (e) {
    console.error('DB save error:', e.message);
  }

  return result;
}

async function generateComparisonPage(product1, product2, country = 'US') {
  const prompt = `Write a 1200-word comparison article: "${product1} vs ${product2}" for ${country} readers.

Requirements:
- Objective, data-driven comparison
- H1 title, H2 sections: Overview, Pricing, Features, Pros/Cons, Verdict
- Include specific prices: Trust & Will $69, LegalZoom $99, Rocket Lawyer $39.99/mo, Fabric free, Nolo $59.99, Willful CAD $99
- End with a recommendation and CTA to law-trust.com
- Tone: neutral review site

Format as JSON:
{
  "title": "...",
  "slug": "...",
  "metaDescription": "...(150-160 chars)",
  "content": "full article..."
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }]
  });

  let result;
  try {
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    result = JSON.parse(jsonMatch[0]);
  } catch (e) {
    const text = response.content[0].text;
    result = {
      title: `${product1} vs ${product2}`,
      slug: slugify(`${product1} vs ${product2}`),
      metaDescription: `${product1} vs ${product2}: Full comparison of features, pricing, and which is right for you in ${country}.`,
      content: text
    };
  }

  if (!result.slug) result.slug = slugify(result.title || `${product1} vs ${product2}`);

  try {
    db.prepare(`
      INSERT OR REPLACE INTO blog_posts (slug, title, content, meta_desc, published, created_at)
      VALUES (?, ?, ?, ?, 0, ?)
    `).run(result.slug, result.title, result.content, result.metaDescription, new Date().toISOString());
    
    const saved = db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(result.slug);
    result.id = saved?.id;
  } catch (e) {
    console.error('DB save error:', e.message);
  }

  return result;
}

async function generateFAQ(topic, country = 'US') {
  const prompt = `Generate exactly 8 FAQ items about "${topic}" for ${country} residents.

Return ONLY valid JSON (no extra text):
{
  "faqs": [
    {"question": "...", "answer": "..."},
    ...
  ],
  "jsonLd": {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [...]
  }
}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }]
  });

  try {
    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { faqs: [], jsonLd: null, error: 'Parse failed' };
  }
}

module.exports = { generateBlogPost, generateComparisonPage, generateFAQ };
