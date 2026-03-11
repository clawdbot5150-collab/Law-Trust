const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { chatAlex } = require('../bots/alex');
const { chatQualifier } = require('../bots/qualifier');
const { chatDecider } = require('../bots/decider');

const alexLimiter = rateLimit({ windowMs: 60000, max: 15, message: { error: 'Too many messages' } });
const qualifyLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: 'Too many messages' } });

// BOT 1 — Alex
router.post('/alex', alexLimiter, async (req, res) => {
  try {
    const { messages, sessionId = 'anon' } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    const reply = await chatAlex(messages, sessionId);
    res.json({ reply, bot: 'alex' });
  } catch (e) {
    console.error('Alex error:', e.message);
    res.status(500).json({ error: 'Bot unavailable', reply: "I'm having a moment — please try again in a second!" });
  }
});

// BOT 2 — Qualifier
router.post('/qualify', qualifyLimiter, async (req, res) => {
  try {
    const { messages, sessionData = {}, sessionId = 'anon' } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    const reply = await chatQualifier(messages, sessionData, sessionId);
    res.json({ reply, bot: 'qualifier' });
  } catch (e) {
    console.error('Qualifier error:', e.message);
    res.status(500).json({ error: 'Bot unavailable' });
  }
});

// BOT 3 — Decider
router.post('/decide', qualifyLimiter, async (req, res) => {
  try {
    const { messages, products = [], sessionId = 'anon' } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
    const reply = await chatDecider(messages, products, sessionId);
    res.json({ reply, bot: 'decider' });
  } catch (e) {
    console.error('Decider error:', e.message);
    res.status(500).json({ error: 'Bot unavailable' });
  }
});

module.exports = router;
