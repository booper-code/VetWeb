'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AI_PROVIDERS, clearAIConfig, defaultAIConfig, getProvider, loadAIConfig, saveAIConfig, type AIConfig, type AIProviderId } from '@/lib/ai';
import { discoverAIModels, type AIModelDiscovery } from '@/lib/ai-model-discovery';

type DiscoveryState = { kind: 'idle' | 'loading' } | { kind: 'error'; message: string } |
  { kind: 'ready'; result: AIModelDiscovery };
const emptyConfig = (provider?: AIProviderId): AIConfig => ({ ...defaultAIConfig(provider), model: '' });
const labelClass = 'block text-[10px] font-bold uppercase tracking-wider text-content-faint';
const fieldClass = 'w-full min-w-0 rounded-xl border border-field-outline bg-field-subtle p-2.5 text-xs text-content-title';

export function AIProviderSettings({ triggerToast }: { triggerToast: (message: string) => void }) {
  const id = useId();
  const [saved, setSaved] = useState(() => Boolean(loadAIConfig()));
  const [config, setConfig] = useState(() => loadAIConfig() ?? emptyConfig());
  const [state, setState] = useState<DiscoveryState>({ kind: 'idle' });
  const [search, setSearch] = useState('');
  const pending = useRef<AbortController | null>(null);
  const provider = getProvider(config.provider);
  const done = state.kind === 'ready' ? state.result : null;
  const query = search.trim().toLowerCase();
  const visible = done?.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query)) ?? [];
  const hasEndpoint = Boolean(config.baseUrl.trim() || provider.baseUrl);
  const hasKey = Boolean(config.apiKey.trim());
  const canDiscover = hasEndpoint && (!provider.keyRequired || hasKey);

  useEffect(() => () => { pending.current?.abort(); }, []);

  function invalidateDiscovery() {
    pending.current?.abort();
    pending.current = null;
    setState({ kind: 'idle' });
    setSearch('');
  }

  async function discover() {
    if (!canDiscover || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setSearch('');
    setState({ kind: 'loading' });
    try {
      const result = await discoverAIModels(config, request.signal);
      if (pending.current === request && !request.signal.aborted) setState({ kind: 'ready', result });
    } catch (error) {
      if (pending.current === request && !request.signal.aborted) {
        setState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not load models. Enter a model ID manually.' });
      }
    } finally {
      if (pending.current === request) pending.current = null;
    }
  }

  function save() {
    try {
      saveAIConfig(config);
      setSaved(true);
      triggerToast('AI settings saved to this browser.');
    } catch { triggerToast('This browser did not allow saving AI settings.'); }
  }

  function clear() {
    invalidateDiscovery();
    try {
      clearAIConfig();
      setSaved(false);
      setConfig(emptyConfig());
      triggerToast('AI settings cleared from this browser.');
    } catch { triggerToast('This browser did not allow clearing AI settings.'); }
  }

  const endpointField = <div className="space-y-1">
    <label htmlFor={`${id}-endpoint`} className={labelClass}>Endpoint URL</label>
    <input id={`${id}-endpoint`} type="url" className={fieldClass} value={config.baseUrl}
      placeholder={provider.baseUrl || 'https://host/v1'} onChange={event => {
        const baseUrl = event.target.value;
        invalidateDiscovery();
        setConfig(prev => ({ ...prev, baseUrl, apiKey: '' }));
      }} />
    <p className="vc-note">Changing the endpoint clears the key. Use Custom for a different hosted endpoint.</p>
  </div>;

  return <div className="min-w-0 space-y-3">
    <p className="text-sm text-content-secondary">
      Connect to list models. No prompts or patient data are sent. Settings are saved in this browser only when you select Save.
    </p>
    <div className="space-y-1">
      <label htmlFor={`${id}-provider`} className={labelClass}>Provider</label>
      <select id={`${id}-provider`} className={fieldClass} value={config.provider} onChange={event => {
        invalidateDiscovery();
        setConfig(emptyConfig(event.target.value as AIProviderId));
      }}>
        {AI_PROVIDERS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </div>
    {provider.id === 'custom' ? endpointField : <details>
      <summary className={`${labelClass} cursor-pointer`}>Advanced: base URL</summary>
      <div className="mt-2">{endpointField}</div>
    </details>}
    {provider.id !== 'ollama' && <div className="space-y-1">
      <label htmlFor={`${id}-key`} className={labelClass}>API Key</label>
      <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false}
        className={`${fieldClass} font-mono`} value={config.apiKey} placeholder={provider.keyRequired ? 'Paste your key' : 'Optional'}
        onChange={event => {
          const apiKey = event.target.value;
          invalidateDiscovery();
          setConfig(prev => ({ ...prev, apiKey }));
        }} />
      <p className="vc-note">{provider.keyHint}</p>
    </div>}
    <button type="button" className="vc-btn" disabled={!canDiscover || state.kind === 'loading'} onClick={() => void discover()}>
      {state.kind === 'loading' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
      {provider.keyRequired ? 'Validate & load models' : 'Load models'}
    </button>
    {state.kind === 'loading' && <p role="status" className="vc-note">Loading models…</p>}
    {state.kind === 'error' && <p role="alert" className="text-sm text-danger-text-deep">{state.message}</p>}
    {done && <div role="status" className="space-y-1 text-sm text-content-copy">
      {done.keyStatus === 'accepted' && <p>
        {done.source === 'catalog' ? 'API key recognized.' : 'API key accepted for model discovery.'}
      </p>}
      {done.source === 'catalog' && <p className="font-semibold">Provider catalog — access not verified</p>}
      {done.source === 'local' && <p>Installed models reported by the local Ollama endpoint.</p>}
      {done.models.length === 0
        ? <p>No compatible models were reported. You can enter a model ID manually.</p>
        : <p className="vc-note">A listing does not guarantee that a model can run or that it is free to use.</p>}
    </div>}
    {done && done.models.length > 0 && <div className="space-y-1">
      <label htmlFor={`${id}-search`} className={labelClass}>Search models</label>
      <input id={`${id}-search`} type="search" className={fieldClass} value={search}
        onChange={event => setSearch(event.target.value)} placeholder="Filter by name or ID" />
      <label htmlFor={`${id}-picker`} className={labelClass}>Discovered model</label>
      <select id={`${id}-picker`} className={fieldClass}
        value={visible.some(model => model.id === config.model) ? config.model : ''}
        onChange={event => { const model = event.target.value; setConfig(prev => ({ ...prev, model })); }}>
        <option value="" disabled>Choose a model</option>
        {visible.map(model => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} — ${model.id}`}</option>)}
      </select>
      {visible.length === 0 && <p className="vc-note">No models match your search.</p>}
    </div>}
    <div className="space-y-1">
      <label htmlFor={`${id}-model`} className={labelClass}>Model ID</label>
      <input id={`${id}-model`} type="text" className={`${fieldClass} font-mono`} value={config.model}
        placeholder={provider.model || 'model-name'} spellCheck={false} onChange={event => {
          const model = event.target.value;
          setConfig(prev => ({ ...prev, model }));
        }} />
      <p className="vc-note">Select a listed model or enter its ID manually.</p>
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="vc-btn" onClick={save}>Save AI Settings</button>
      {saved && <button type="button" className="vc-btn" onClick={clear}>Clear saved AI settings</button>}
    </div>
  </div>;
}
