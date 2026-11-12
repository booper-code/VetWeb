// Provider-agnostic AI client.
//
// There is no server in this app, so the user supplies their own API key and it
// stays in this browser's localStorage. It is never bundled into the app and
// never written to Firestore, which means shipping the app no longer exposes a
// key to anyone who opens devtools.

export type AIProviderId =
  | 'gemini'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'deepseek'
  | 'mistral'
  | 'ollama'
  | 'custom';

/** How a provider's HTTP API is shaped. */
export type AIWireFormat = 'gemini' | 'openai';

export type AIProvider = {
  id: AIProviderId;
  label: string;
  wire: AIWireFormat;
  baseUrl: string;
  model: string;
  /** Where the user gets a key, shown under the key field. */
  keyHint: string;
  keyRequired: boolean;
};

export type AIConfig = {
  provider: AIProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type AIImageInput = {
  mimeType: string;
  base64: string;
};

export const AI_PROVIDERS: AIProvider[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    wire: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.0-flash',
    keyHint: 'aistudio.google.com/apikey — free tier available',
    keyRequired: true
  },
  {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyHint: 'platform.openai.com/api-keys',
    keyRequired: true
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (Claude, Llama, Gemini…)',
    wire: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    keyHint: 'openrouter.ai/keys — one key for most models',
    keyRequired: true
  },
  {
    id: 'groq',
    label: 'Groq',
    wire: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    keyHint: 'console.groq.com/keys — generous free tier',
    keyRequired: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyHint: 'platform.deepseek.com/api_keys',
    keyRequired: true
  },
  {
    id: 'mistral',
    label: 'Mistral',
    wire: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    keyHint: 'console.mistral.ai/api-keys',
    keyRequired: true
  },
  {
    id: 'ollama',
    label: 'Ollama (local model)',
    wire: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    keyHint: 'Runs on your own machine — no key needed',
    keyRequired: false
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    wire: 'openai',
    baseUrl: '',
    model: '',
    keyHint: 'Any endpoint that speaks /chat/completions',
    keyRequired: false
  }
];

const STORAGE_KEY = 'vetcloudpro.ai';
const MAX_ATTEMPTS = 3;

export const getProvider = (id: AIProviderId): AIProvider =>
  AI_PROVIDERS.find(provider => provider.id === id) ?? AI_PROVIDERS[0];

export const defaultAIConfig = (id: AIProviderId = 'gemini'): AIConfig => {
  const provider = getProvider(id);
  return {
    provider: provider.id,
    model: provider.model,
    baseUrl: provider.baseUrl,
    apiKey: ''
  };
};

export const loadAIConfig = (): AIConfig | null => {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<AIConfig>;
    if (!parsed?.provider) return null;

    return { ...defaultAIConfig(parsed.provider), ...parsed } as AIConfig;
  } catch {
    return null;
  }
};

export const saveAIConfig = (config: AIConfig) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
};

export const clearAIConfig = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORAGE_KEY);
};

const joinUrl = (baseUrl: string, path: string) =>
  `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

const errorMessage = async (response: Response) => {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || '';
  } catch {
    // Non-JSON error body; the status code is all we have.
  }

  const suffix = detail ? ` ${detail}` : '';
  // Providers disagree on how a bad key looks: OpenAI returns 401, Gemini
  // returns 400 with "API key not valid". Treat the wording as authentication.
  const looksLikeBadKey = /api[ _-]?key (is )?(not valid|invalid|missing)|invalid api key/i.test(detail);

  if (response.status === 401 || response.status === 403 || looksLikeBadKey) {
    return `Authentication failed (${response.status}). Check the API key.${suffix}`;
  }
  if (response.status === 404) {
    return `Model or endpoint not found (404). Check the model name and base URL.${suffix}`;
  }
  if (response.status === 429) {
    return `Rate limit reached (429). Wait a moment and retry.${suffix}`;
  }
  return `Request failed (${response.status}).${suffix}`;
};

const shouldRetry = (status: number) => status === 429 || status >= 500;

const buildRequest = (config: AIConfig, prompt: string, image?: AIImageInput, json = false) => {
  const provider = getProvider(config.provider);
  const model = config.model.trim() || provider.model;
  const baseUrl = config.baseUrl.trim() || provider.baseUrl;
  const apiKey = config.apiKey.trim();

  if (!baseUrl) {
    throw new Error('No base URL configured. Add one in Clinic Setup.');
  }
  if (!model) {
    throw new Error('No model configured. Add one in Clinic Setup.');
  }
  if (provider.keyRequired && !apiKey) {
    throw new Error(`No API key saved for ${provider.label}. Add one in Clinic Setup.`);
  }

  if (provider.wire === 'gemini') {
    const parts = image
      ? [{ text: prompt }, { inline_data: { mime_type: image.mimeType, data: image.base64 } }]
      : [{ text: prompt }];

    return {
      url: joinUrl(baseUrl, `models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {})
        })
      } as RequestInit
    };
  }

  const content = image
    ? [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }
      ]
    : prompt;

  return {
    url: joinUrl(baseUrl, 'chat/completions'),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        ...(json ? { response_format: { type: 'json_object' } } : {})
      })
    } as RequestInit
  };
};

type AIResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  choices?: { message?: { content?: unknown } }[];
};

const readText = (config: AIConfig, data: AIResponse): string => {
  const provider = getProvider(config.provider);

  if (provider.wire === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.map(part => part?.text ?? '').join('')
      : '';
    if (!text) throw new Error('The model returned an empty response.');
    return text;
  }

  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text) {
    throw new Error('The model returned an empty response.');
  }
  return text;
};

const request = async (config: AIConfig, prompt: string, image?: AIImageInput, json = false) => {
  const { url, init } = buildRequest(config, prompt, image, json);

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, init);
    } catch (err) {
      // Network/CORS failure: worth one more try, then surface it.
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      continue;
    }

    if (response.ok) {
      return readText(config, await response.json());
    }

    const message = await errorMessage(response);
    lastError = new Error(message);

    if (!shouldRetry(response.status) || attempt === MAX_ATTEMPTS) break;
    await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error('The AI request failed.');
};

/** Send a prompt (optionally with an image) and return the model's plain text. */
export const generateText = (config: AIConfig, prompt: string, image?: AIImageInput) =>
  request(config, prompt, image, false);

/** Same as generateText, but asks the provider for a JSON object. */
export const generateJSON = async <T = unknown>(
  config: AIConfig,
  prompt: string,
  image?: AIImageInput
): Promise<T> => {
  const text = await request(config, prompt, image, true);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('The model did not return valid JSON.');
  }
};
