/**
 * Optional LLM step: send the assembled brief to an Anthropic-Messages-compatible
 * endpoint and get the scenario narrative back.
 *
 * The engine stays zero-dependency — this module speaks the Anthropic Messages API over
 * plain HTTP (node:https), honoring the same environment variables the Anthropic SDK
 * reads, so it works unchanged against api.anthropic.com or any compatible gateway
 * (this project is developed against one configured via ANTHROPIC_BASE_URL).
 *
 * Env (all optional, sensible defaults):
 *   ANTHROPIC_BASE_URL    endpoint base (default https://api.anthropic.com)
 *   ANTHROPIC_AUTH_TOKEN  Authorization: Bearer <token> (takes precedence)
 *   ANTHROPIC_API_KEY     fallback: x-api-key header
 *   ANTHROPIC_MODEL       model id (default claude-opus-5)
 *   RELEASE_IMPACT_MAX_TOKENS  output cap (default 8000)
 */

/** Build the request object for the Messages API. Pure — unit-tested, no network. */
export function buildLlmRequest(prompt, env = {}) {
  const baseUrl = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
  const apiKey = env.ANTHROPIC_API_KEY || '';
  const model = env.ANTHROPIC_MODEL || 'claude-opus-5';
  const maxTokens = Number(env.RELEASE_IMPACT_MAX_TOKENS) || 8000;
  if (!authToken && !apiKey) {
    return { error: 'no credentials: set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY' };
  }
  return {
    url: `${baseUrl}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : { 'x-api-key': apiKey }),
    },
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    },
  };
}

/**
 * Call the endpoint and extract the narrative text. Never throws — failures come back
 * as `{ error }` so a broken LLM step degrades to "no narrative" instead of failing the run.
 */
export async function generateNarrative(prompt, env = process.env) {
  const request = buildLlmRequest(prompt, env);
  if (request.error) return { error: request.error };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000);
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return { error: `HTTP ${response.status}: ${detail}` };
    }
    const payload = await response.json();
    const text = (payload.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (!text) {
      return { error: `empty narrative (stop_reason ${payload.stop_reason ?? 'unknown'})` };
    }
    return {
      text,
      model: payload.model ?? request.body.model,
      stopReason: payload.stop_reason ?? null,
      usage: payload.usage ?? null,
    };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 300) };
  } finally {
    clearTimeout(timeout);
  }
}
