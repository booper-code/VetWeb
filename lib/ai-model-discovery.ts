import { getProvider, type AIConfig, type AIProvider } from '@/lib/ai';

export type AIModel = { id: string; name: string };

export type AIModelDiscovery = {
  keyStatus: 'accepted' | 'not-verified' | 'not-required';
  source: 'authenticated' | 'catalog' | 'local';
  models: AIModel[];
};

const MAX_GEMINI_PAGES = 20;
const DISCOVERY_TIMEOUT_MS = 15_000;
const unexpectedList = 'The endpoint returned an unexpected model list. You can enter a model ID manually.';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function containsKey(value: string, apiKey: string): boolean {
  if (!apiKey) return false;
  // Keys are ASCII. Check ordinary and percent-escaped forms without decoding an entire URL.
  for (let pass = 0; pass < 3; pass++) {
    if (value.includes(apiKey)) return true;
    const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    if (decoded === value) break;
    value = decoded;
  }
  return false;
}

function discoveryBase(provider: AIProvider, input: string, apiKey: string): string {
  const raw = input.trim() || provider.baseUrl;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('Enter a valid model endpoint URL.'); }

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || /[?#]/.test(raw) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !apiKey))) {
    throw new Error('Use an HTTPS endpoint without embedded credentials, query parameters or fragments. Only keyless local endpoints may use HTTP.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  const base = `${url.origin}${path}`;
  if (containsKey(`${url.host}${path}`, apiKey)) {
    throw new Error('Put the API key only in the key field, not in the model endpoint URL.');
  }
  if (provider.id === 'ollama') {
    if (!loopback || path !== '/v1' || apiKey) throw new Error('Use a keyless local Ollama endpoint, or choose Custom.');
  } else if (provider.id !== 'custom' && base !== provider.baseUrl &&
      !(provider.id === 'deepseek' && base === 'https://api.deepseek.com')) {
    throw new Error('Use the official endpoint for this provider, or choose Custom for an alternate endpoint.');
  }
  return base;
}

function checkActive(signal: AbortSignal, caller?: AbortSignal) {
  if (caller?.aborted) throw new DOMException('Model discovery was cancelled.', 'AbortError');
  if (signal.aborted) throw new Error('Model discovery timed out. Retry or enter a model ID manually.');
}

async function readJson(response: Response, signal: AbortSignal, caller?: AbortSignal) {
  let body: unknown;
  try { body = await response.json(); }
  catch {
    checkActive(signal, caller);
    throw new Error(unexpectedList);
  }
  checkActive(signal, caller);
  return record(body);
}

async function requireOk(response: Response, provider: AIProvider, sentKey: boolean, signal: AbortSignal, caller?: AbortSignal) {
  if (response.ok) return;
  if (response.status === 401) {
    throw new Error(sentKey ? 'The provider rejected the API key.' : 'The provider requires an API key to list models.');
  }
  if (response.status === 403) throw new Error('The provider denied model discovery. Check the API key permissions or enter a model ID manually.');
  if (response.status === 429) throw new Error('The provider rate limit was reached. Retry later.');
  if (response.status === 404 || response.status === 405) {
    throw new Error('The endpoint does not support model discovery. You can enter a model ID manually.');
  }
  if (provider.wire === 'gemini' && response.status === 400) {
    const body = await readJson(response, signal, caller);
    const error = record(body?.error);
    if (Array.isArray(error?.details) && error.details.some(detail => record(detail)?.reason === 'API_KEY_INVALID')) {
      throw new Error('The provider rejected the API key.');
    }
  }
  throw new Error(`Model discovery failed (HTTP ${response.status}). Retry or enter a model ID manually.`);
}

function addModels(rows: unknown, provider: AIProvider, apiKey: string, models: Map<string, AIModel>) {
  if (!Array.isArray(rows)) throw new Error(unexpectedList);
  let validEntries = 0;
  for (const raw of rows) {
    const entry = record(raw);
    if (!entry) continue;
    const gemini = provider.wire === 'gemini';
    const id = gemini
      ? (typeof entry.name === 'string' && entry.name.startsWith('models/') ? entry.name.slice(7).trim() : '')
      : (typeof entry.id === 'string' ? entry.id.trim() : '');
    if (!id || id.length > 512 || /\s|[\u0000-\u001f\u007f]/.test(id)) continue;
    const methods = entry.supportedGenerationMethods;
    if (gemini && !Array.isArray(methods)) continue;
    validEntries++;
    if (containsKey(id, apiKey)) continue;
    if (gemini && Array.isArray(methods) && !methods.includes('generateContent')) continue;
    if (provider.id === 'groq' && entry.active === false) continue;
    if (provider.id === 'mistral' && (entry.archived === true || record(entry.capabilities)?.completion_chat === false)) continue;
    const output = provider.id === 'openrouter' ? record(entry.architecture)?.output_modalities : entry.output_modalities;
    if (Array.isArray(output) && output.length && !output.includes('text')) continue;

    const label = gemini ? entry.displayName : entry.name;
    const name = typeof label === 'string' && !containsKey(label, apiKey)
      ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 256) : '';
    if (!models.has(id)) models.set(id, { id, name: name || id });
  }
  if (rows.length && !validEntries) throw new Error(unexpectedList);
}

export async function discoverAIModels(
  config: Pick<AIConfig, 'provider' | 'baseUrl' | 'apiKey'>,
  caller?: AbortSignal,
): Promise<AIModelDiscovery> {
  const provider = getProvider(config.provider);
  if (provider.id !== config.provider) throw new Error('Choose a supported provider.');
  const apiKey = config.apiKey.trim();
  if ((provider.keyRequired && !apiKey) || (apiKey && !/^[!-~]+$/.test(apiKey))) {
    throw new Error('Enter a valid API key for this provider.');
  }
  const base = discoveryBase(provider, config.baseUrl, apiKey);
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;

  async function request(path: string, { authenticated = true, pageToken = '' } = {}) {
    checkActive(signal, caller);
    const url = new URL(`${base}/${path}`);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const headers = new Headers({ Accept: 'application/json' });
    if (authenticated && apiKey) {
      if (provider.wire === 'gemini') headers.set('x-goog-api-key', apiKey);
      else headers.set('Authorization', `Bearer ${apiKey}`);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET', headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      });
    } catch {
      checkActive(signal, caller);
      throw new Error('Could not reach the model endpoint. Check the connection or browser cross-origin settings, or enter a model ID manually.');
    }
    checkActive(signal, caller);
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error('The model endpoint redirected the request. Enter the direct endpoint instead.');
    }
    return response;
  }

  const models = new Map<string, AIModel>();
  const readList = async (response: Response, field: 'data' | 'models', sentKey = Boolean(apiKey)) => {
    await requireOk(response, provider, sentKey, signal, caller);
    const body = await readJson(response, signal, caller);
    addModels(body?.[field], provider, apiKey, models);
    return body;
  };

  if (provider.wire === 'gemini') {
    const seenTokens = new Set<string>();
    let pageToken = '';
    for (let page = 0; page < MAX_GEMINI_PAGES; page++) {
      const body = await readList(await request('models', { pageToken }), 'models');
      const next = body?.nextPageToken;
      if (next === undefined || next === '') {
        return { keyStatus: 'accepted', source: 'authenticated', models: [...models.values()] };
      }
      if (typeof next !== 'string' || next.length > 4096 || seenTokens.has(next) || containsKey(next, apiKey)) break;
      seenTokens.add(next);
      pageToken = next;
    }
    throw new Error('The provider returned incomplete model pagination. Retry or enter a model ID manually.');
  }

  if (provider.id === 'openrouter') {
    const verification = await request('key');
    await requireOk(verification, provider, true, signal, caller);
    const keyDetails = record((await readJson(verification, signal, caller))?.data);
    if (!keyDetails || typeof keyDetails.is_management_key !== 'boolean') {
      throw new Error('The provider did not return a recognizable API key status.');
    }
    if (keyDetails.is_management_key || keyDetails.is_provisioning_key === true) {
      throw new Error('Use a regular API key for model discovery, not a management key.');
    }
    const filtered = await request('models/user');
    if ([403, 404, 405].includes(filtered.status)) {
      await readList(await request('models', { authenticated: false }), 'data', false);
      return { keyStatus: 'accepted', source: 'catalog', models: [...models.values()] };
    }
    await readList(filtered, 'data');
  } else {
    await readList(await request('models'), 'data');
  }
  if (provider.id === 'custom') return { keyStatus: 'not-verified', source: 'catalog', models: [...models.values()] };
  if (provider.id === 'ollama') return { keyStatus: 'not-required', source: 'local', models: [...models.values()] };
  return { keyStatus: 'accepted', source: 'authenticated', models: [...models.values()] };
}
