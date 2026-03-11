require('dotenv').config();
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many requests, please try again in a minute.' }
});

const SYSTEM_PROMPT = `You are Alex, a friendly legal document guide at law-trust.com. Your personality: warm, helpful, never pushy, like a knowledgeable friend who happens to know about legal documents.

RULES:
- Never give legal advice. Always say "I'm not a lawyer, but..." 
- Keep answers to 60-90 words max.
- Always end with ONE clear next step or question.
- If someone asks about price, give a specific number from our comparison data.
- If someone seems overwhelmed, say "Good news — this is actually simpler than most people think".
- Never mention competitor AI tools.

PRODUCT DATA:
- Trust & Will: $69, all US states, attorney-reviewed. Best for: families wanting comprehensive estate planning.
- LegalZoom: $99, US & UK, 1M+ documents. Best for: comprehensive legal needs.
- Rocket Lawyer: $39.99/mo, US & UK, unlimited docs. Best for: ongoing legal needs with subscription.
- Fabric by Gerber: Free, US only. Best for: parents who want a quick free will.
- Nolo/WillMaker: $59.99 one-time, US. Best for: people who want no subscription.
- Willful: CAD $99, Canada only. Best for: Canadians.

When user asks what document they need, ask these 3 questions ONE AT A TIME:
1. What is your main goal — protecting your family, planning your estate, or setting up a business?
2. What country are you in?
3. Have you worked with a lawyer on this before, or is this your first time?

Then recommend the best matching service.`;

// Helper to get suggested product from reply
function extractSuggestedProduct(reply, country) {
  const lower = reply.toLowerCase();
  if (lower.includes('trust & will') || lower.includes('trust and will')) return 'trust-and-will';
  if (lower.includes('legalzoom') || lower.includes('legal zoom')) return 'legalzoom';
  if (lower.includes('rocket lawyer')) return 'rocket-lawyer';
  if (lower.includes('fabric') || lower.includes('gerber')) return 'fabric';
  if (lower.includes('nolo') || lower.includes('willmaker')) return 'nolo';
  if (lower.includes('willful')) return 'willful';
  
  // Default by country
  if (country === 'CA') return 'willful';
  if (country === 'UK') return 'legalzoom';
  return 'trust-and-will';
}

// POST /api/chat
router.post('/', chatLimiter, async (req, res) => {
  try {
    const { message, context, country, docType } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    const messages = [];
    
    // Add conversation context if provided
    if (context && Array.isArray(context)) {
      messages.push(...context.slice(-6)); // Keep last 6 turns
    }
    
    messages.push({ role: 'user', content: message });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages
    });

    const reply = response.content[0].text;
    const suggestedProduct = extractSuggestedProduct(reply, country);
    
    // Get product for CTA
    const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(suggestedProduct);
    const ctaText = product ? `Compare ${product.name} →` : 'Compare top services →';

    res.json({ reply, suggestedProduct, ctaText });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Chat service temporarily unavailable' });
  }
});

// POST /api/chat/qualify
router.post('/qualify', chatLimiter, async (req, res) => {
  try {
    const { answers } = req.body;
    // answers: { goal, country, experience, budget }
    const { goal, country, experience, budget } = answers || {};

    // Match logic
    let bestSlug = 'trust-and-will';
    let savings = '$200';
    let urgencyLine = 'Prices may increase — lock in today\'s rate';

    if (country === 'CA') {
      bestSlug = 'willful';
      savings = 'CAD $300 vs lawyer fees';
    } else if (country === 'UK') {
      bestSlug = 'legalzoom';
      savings = '£400 vs solicitor fees';
    } else if (budget === 'free') {
      bestSlug = 'fabric';
      savings = '$69+ vs paid alternatives';
      urgencyLine = 'Free while it lasts — Fabric occasionally limits signups';
    } else if (budget === 'one-time') {
      bestSlug = 'nolo';
      savings = 'No subscription fees ever';
    } else if (goal === 'business') {
      bestSlug = 'legalzoom';
      savings = '$500+ vs attorney fees';
    } else if (goal === 'family' && experience === 'first-time') {
      bestSlug = 'trust-and-will';
      savings = '$1,400 vs estate attorney';
    } else if (budget === 'subscription') {
      bestSlug = 'rocket-lawyer';
      savings = '$300 vs per-document pricing';
    }

    const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(bestSlug);
    if (!product) return res.status(404).json({ error: 'No match found' });

    product.features = JSON.parse(product.features || '[]');
    product.countries = JSON.parse(product.countries || '[]');

    // Generate personalized CTA with AI
    const ctaPrompt = `Write a 1-sentence CTA for ${product.name} (${product.price_from}) aimed at someone in ${country || 'US'} who wants to ${goal || 'protect their family'}. Max 15 words. Make it action-oriented and specific.`;
    
    let ctaText = `Start with ${product.name} today — ${product.price_from}`;
    try {
      const ctaResponse = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{ role: 'user', content: ctaPrompt }]
      });
      ctaText = ctaResponse.content[0].text.replace(/^["']|["']$/g, '').trim();
    } catch (e) { /* use default */ }

    res.json({
      bestProduct: product,
      savingsEstimate: savings,
      ctaText,
      urgencyLine
    });
  } catch (err) {
    console.error('Qualify error:', err.message);
    res.status(500).json({ error: 'Service temporarily unavailable' });
  }
});

module.exports = router;
