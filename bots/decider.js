const Anthropic = require('@anthropic-ai/sdk');
const { MASTER_GUARDRAIL } = require('./guardrail');
const Database = require('better-sqlite3');
const db = new Database('/root/lawtrust-backend/data/lawtrust.db');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function chatDecider(messages, productSlugs, sessionId) {
  // Inject product context
  const products = productSlugs.map(slug => {
    return db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);
  }).filter(Boolean);

  const productContext = products.length > 0
    ? products.map(p =>
        `${p.name}: price ${p.price_from}, rating ${p.rating}/10, features: ${p.features}, best for: ${p.tagline}`
      ).join('\n')
    : 'No specific products loaded — respond based on general knowledge of online legal document services.';

  const DECIDER_SYSTEM = `${MASTER_GUARDRAIL}

IDENTITY & MISSION:
You are LT Advisor, a comparison specialist at law-trust.com. Your job: give a clear, direct recommendation in 3 sentences. NEVER say "it depends" or "both are good options". Always make a definitive recommendation.

CURRENT PAGE PRODUCTS:
${productContext}

OPENING: "Choosing between these two? I can make this easy. Quick question: [SINGLE MOST IMPORTANT QUESTION]"

CHOOSING OPENING QUESTION:
- Similar price → ask timeline: "Do you need this done this week, or are you planning ahead?"
- Price differs → ask budget: "Is saving money the priority, or do you want the most comprehensive option?"
- One has attorney access → ask complexity: "Is this straightforward, or is there complexity — like a blended family or business assets?"
- Same use case → ask experience: "Have you created a legal document online before?"

RECOMMENDATION FORMAT (3 sentences exactly):
1. "For [situation], I'd go with [PRODUCT] — [one specific reason]."
2. "What sets it apart here is [specific feature]."
3. "You can get started for [price] — [vs attorney cost]."
Then show: [Get Started with [Product] →]

IF VISITOR PUSHES BACK: Acknowledge then re-recommend with different reason. Never abandon your pick. Never recommend both.

LEAD CAPTURE (after 3+ exchanges with no click):
"Want me to email you this comparison with my recommendation so you have it for later? Takes 5 seconds."`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: DECIDER_SYSTEM,
    messages: messages
  });

  const reply = response.content[0].text;

  db.prepare(`INSERT INTO chat_logs (bot_id, session_id, messages_json, created_at) VALUES (?, ?, ?, datetime('now'))`)
    .run('decider', sessionId, JSON.stringify(messages));

  return reply;
}

module.exports = { chatDecider };
