// Optional answer synthesis with Claude over GraphRAG context. Disabled unless a KM admin sets
// llm.provider = 'anthropic' and an API key in the admin panel (or ANTHROPIC_API_KEY is set).
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SYSTEM = `You answer questions for employees using ONLY the knowledge-base excerpts provided.
Cite sources inline as [n] using the excerpt numbers. If the excerpts do not contain the answer,
say so plainly and suggest which pages or people might know. Be concise.`;

export function llmConfigured(settings) {
  const cfg = settings.get('llm', {});
  return cfg.provider === 'anthropic' && !!(cfg.apiKey || process.env.ANTHROPIC_API_KEY);
}

export async function synthesize(settings, question, context) {
  const cfg = settings.get('llm', {});
  const client = new Anthropic({ apiKey: cfg.apiKey || process.env.ANTHROPIC_API_KEY, baseURL: cfg.baseUrl || undefined });
  const params = {
    model: cfg.model || DEFAULT_MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: cfg.effort || 'medium' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Knowledge-base excerpts:\n\n${context}\n\nQuestion: ${question}` }],
  };
  let response;
  try {
    response = cfg.fallbacks === false
      ? await client.messages.create(params)
      : await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: 'LLM authentication failed — check the API key in Admin › Settings.' };
    if (e instanceof Anthropic.RateLimitError) return { error: 'LLM rate limited — try again shortly.' };
    if (e instanceof Anthropic.APIError) return { error: `LLM error ${e.status}: ${e.message}` };
    return { error: `LLM unavailable: ${e.message}` };
  }
  if (response.stop_reason === 'refusal') return { error: 'The model declined to answer this question.', model: response.model };
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { answer: text, model: response.model, usage: response.usage };
}
