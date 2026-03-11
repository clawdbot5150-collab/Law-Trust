const MODEL_ROUTER = {
  haiku: {
    model: 'claude-haiku-4-5-20251001',
    useCases: ['price-scraping', 'email-personalize', 'chat-bot', 'reddit-draft', 'briefing', 'classify', 'summarize']
  },
  sonnet: {
    model: 'claude-sonnet-4-20250514',
    useCases: ['blog-post', 'comparison-page', 'email-sequence', 'state-guide', 'weekly-report', 'content-calendar', 'product-rewrite']
  },
  opus: {
    model: 'claude-opus-4-20250514',
    useCases: ['niche-research', 'conversion-analysis', 'monetization-audit', 'site-architecture']
  }
};

function selectModel(taskType) {
  for (const [tier, config] of Object.entries(MODEL_ROUTER)) {
    if (config.useCases.includes(taskType)) return config.model;
  }
  return MODEL_ROUTER.haiku.model;
}

module.exports = { selectModel, MODEL_ROUTER };
