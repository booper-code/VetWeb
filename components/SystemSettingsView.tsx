"use client";

import React, { useState } from 'react';
import { Sparkles, Loader2, FileSpreadsheet, Database } from 'lucide-react';
import type { InventoryItem } from '@/types';
import {
  AI_PROVIDERS,
  defaultAIConfig,
  getProvider,
  loadAIConfig,
  saveAIConfig,
  clearAIConfig,
  generateText,
  type AIConfig,
  type AIProviderId
} from '@/lib/ai';

export const SystemSettingsView = ({
  inventory, 
  onAddInventoryItem,
  aiEnabled,
  canManageAI,
  isDemo,
  onSetAIEnabled,
  triggerToast 
}: { 
  inventory: InventoryItem[]; 
  onAddInventoryItem: (item: InventoryItem) => Promise<void>;
  aiEnabled: boolean;
  canManageAI: boolean;
  isDemo: boolean;
  onSetAIEnabled: (enabled: boolean) => Promise<void>;
  triggerToast: (msg: string) => void; 
}) => {
  const [apiStatus, setApiStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [apiResponse, setApiResponse] = useState('');
  const [isSavingToggle, setIsSavingToggle] = useState(false);
  const [toggleError, setToggleError] = useState('');
  const [aiConfig, setAIConfig] = useState<AIConfig>(() => loadAIConfig() ?? defaultAIConfig());

  const provider = getProvider(aiConfig.provider);
  const isConfigured = Boolean(aiConfig.model.trim()) && (!provider.keyRequired || aiConfig.apiKey.trim());

  const handleProviderChange = (id: AIProviderId) => {
    // Keys are provider-specific, so start clean instead of reusing another one.
    setAIConfig(defaultAIConfig(id));
    setApiStatus('idle');
    setApiResponse('');
  };

  const handleSaveAI = () => {
    saveAIConfig(aiConfig);
    triggerToast('AI settings saved to this browser.');
  };

  const handleClearAI = () => {
    clearAIConfig();
    setAIConfig(defaultAIConfig());
    setApiStatus('idle');
    setApiResponse('');
    triggerToast('AI settings cleared from this browser.');
  };

  const handleTestConnection = async () => {
    setApiStatus('testing');
    setApiResponse('');

    try {
      // Sends a lightweight greeting to verify the key and endpoint are reachable
      saveAIConfig(aiConfig);
      const response = await generateText(
        aiConfig,
        "Hello! This is Biñan Animal Clinic testing your connection. Please reply with a short, friendly one sentence greeting."
      );
      setApiResponse(response);
      setApiStatus('success');
      triggerToast(`${provider.label} connection verified successfully!`);
    } catch (error) {
      setApiStatus('error');
      setApiResponse(error instanceof Error ? error.message : "Connection failed. Please verify your API key.");
      triggerToast(`${provider.label} connection failed.`);
    }
  };

  const parseCSVLine = (line: string) => {
    const result: string[] = [];
    let current = '';
    let insideQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"' && insideQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        insideQuotes = !insideQuotes;
      } else if (char === ',' && !insideQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    result.push(current.trim());
    return result;
  };

  const normalizeCategory = (value: string): InventoryItem['category'] => {
    const cleaned = value.toLowerCase().trim();

    if (cleaned.includes('supply')) return 'Supplies';
    if (cleaned.includes('service') || cleaned.includes('procedure')) return 'Service';
    if (cleaned.includes('groom')) return 'Grooming';

    return 'Medicine';
  };

  const handleCSVFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      triggerToast('CSV files must be at most 2 MB. Nothing was imported.');
      e.target.value = '';
      return;
    }

    const reader = new FileReader();

    reader.onload = async () => {
      let savedCount = 0;
      try {
        const text = String(reader.result || '');
        const rows = text
          .split(/\r?\n/)
          .map(row => row.trim())
          .filter(Boolean);

        if (rows.length < 2) {
          triggerToast("CSV import failed. File has no data rows.");
          return;
        }

        const headers = parseCSVLine(rows[0]).map(header =>
          header.toLowerCase().replace(/\s+/g, '').trim()
        );

        const getValue = (values: string[], possibleHeaders: string[]) => {
          for (const header of possibleHeaders) {
            const index = headers.indexOf(header);
            if (index !== -1) return values[index] || '';
          }
          return '';
        };

        const existingCodes = new Set(inventory.map(item => item.itemCode));
        const importedItems: InventoryItem[] = [];

        if (rows.length > 501) throw new Error('Import at most 500 inventory rows at a time.');
        rows.slice(1).forEach(row => {
          const values = parseCSVLine(row);

          const itemName = getValue(values, ['itemname', 'name', 'description']);
          if (!itemName) return;

          const category = normalizeCategory(
            getValue(values, ['category', 'type', 'classification'])
          );

          const isService = category === 'Service' || category === 'Grooming';

          const rawCode = getValue(values, ['itemcode', 'code', 'sku']);
          const prefix = isService ? 'SRV' : 'ITM';
          const generatedCode = `${prefix}-CSV-${crypto.randomUUID()}`;
          const itemCode = rawCode || generatedCode;

          if (existingCodes.has(itemCode)) return;

          existingCodes.add(itemCode);

          const stock = isService
            ? 999
            : Number(getValue(values, ['stock', 'quantity', 'qty'])) || 0;

          const buyingPrice = isService
            ? 0
            : Number(getValue(values, ['buyingprice', 'buying', 'cost'])) || 0;

          const sellingPrice =
            Number(getValue(values, ['sellingprice', 'selling', 'price', 'servicefee', 'fee'])) || 0;

          const threshold = isService
            ? 0
            : Number(getValue(values, ['threshold', 'alertthreshold', 'lowstockalert'])) || 0;

          importedItems.push({
            itemCode,
            itemName,
            category,
            stock,
            buyingPrice,
            sellingPrice,
            threshold
          });
        });

        if (importedItems.length === 0) {
          triggerToast("No new valid inventory items found in CSV.");
          return;
        }

        for (const item of importedItems) {
          await onAddInventoryItem(item);
          savedCount += 1;
        }

        triggerToast(`Imported ${importedItems.length} inventory item/s from CSV.`);
      } catch (error) {
        console.error("CSV import failed:", error);
        triggerToast(`CSV import stopped after ${savedCount} saved item(s). ${error instanceof Error ? error.message : 'Check the file and retry.'}`);
      } finally {
        e.target.value = '';
      }
    };

    reader.readAsText(file);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-content-heading">Clinic Settings & Import Portal</h2>
        <p className="text-content-hint font-medium font-medium">Configure clinic variables, manage security rules, and migrate records from old software platforms.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* AI PROVIDER CONFIGURATION */}
        <div className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="text-brand-mark w-5 h-5 animate-pulse" />
              <h3 className="text-lg font-bold text-content-heading">AI Provider Connection</h3>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-xl border border-outline-soft bg-panel-subtle p-3">
              <div>
                <label htmlFor="aiEnabled" className="text-sm font-bold text-content-heading">Enable AI features</label>
                <p className="text-xs text-content-hint">
                  {isDemo ? 'Applies to this offline demo session.' : 'The clinic owner controls this setting for all members.'}
                  {' '}Turning it off hides AI features without deleting saved summaries or provider settings.
                </p>
              </div>
              <input
                id="aiEnabled"
                type="checkbox"
                role="switch"
                checked={aiEnabled}
                disabled={!canManageAI || isSavingToggle}
                onChange={async event => {
                  setIsSavingToggle(true);
                  setToggleError('');
                  try {
                    await onSetAIEnabled(event.target.checked);
                  } catch (error) {
                    console.error('[Settings] Could not update AI setting:', error);
                    setToggleError('Could not update the AI setting. Check your connection and that the latest Firestore rules are published.');
                  } finally {
                    setIsSavingToggle(false);
                  }
                }}
                className="h-5 w-5 accent-teal-600 disabled:opacity-50"
              />
            </div>
            {toggleError && <p role="alert" className="text-xs font-bold text-danger-text">{toggleError}</p>}
            {aiEnabled && <>
            <p className="text-sm text-content-secondary leading-relaxed">
              Bring your own key for any provider. It is saved in this browser only and never written to the clinic database.
            </p>
            <p className="text-xs font-bold text-warning-text">Lab extraction and summaries are currently demonstrations with example data, not real AI analysis. Do not use them for clinical decisions.</p>

            <div className="space-y-2">
              <label htmlFor="aiProvider" className="text-[10px] font-bold text-content-faint uppercase tracking-wider block">
                Provider
              </label>
              <select
                id="aiProvider"
                value={aiConfig.provider}
                onChange={e => handleProviderChange(e.target.value as AIProviderId)}
                className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-xs font-bold text-content-title outline-none"
              >
                {AI_PROVIDERS.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>

              <label htmlFor="aiModel" className="text-[10px] font-bold text-content-faint uppercase tracking-wider block pt-1">
                Model
              </label>
              <input
                id="aiModel"
                type="text"
                value={aiConfig.model}
                placeholder={provider.model || 'model-name'}
                onChange={e => setAIConfig(prev => ({ ...prev, model: e.target.value }))}
                className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-xs font-mono text-content-title outline-none"
              />

              <label htmlFor="aiKey" className="text-[10px] font-bold text-content-faint uppercase tracking-wider block pt-1">
                API Key
              </label>
              <input
                id="aiKey"
                type="password"
                value={aiConfig.apiKey}
                placeholder={provider.keyRequired ? 'Paste your key' : 'Not required'}
                onChange={e => setAIConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-xs font-mono text-content-title outline-none"
              />
              <p className="text-[10px] text-content-faint font-medium">{provider.keyHint}</p>

              <details className="pt-1">
                <summary className="text-[10px] font-bold text-content-faint uppercase tracking-wider cursor-pointer">
                  Advanced: base URL
                </summary>
                <input
                  type="text"
                  value={aiConfig.baseUrl}
                  placeholder={provider.baseUrl || 'https://host/v1'}
                  onChange={e => setAIConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                  className="mt-2 w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-xs font-mono text-content-title outline-none"
                />
              </details>
            </div>

            {apiStatus !== 'idle' && (
              <div className={`p-4 rounded-xl border text-sm leading-relaxed transition-all ${
                apiStatus === 'testing' ? 'bg-panel-subtle border-outline-soft text-content-hint' :
                apiStatus === 'success' ? 'bg-success-wash border-success-stroke text-content-title font-medium' :
                'bg-danger-wash border-danger-stroke text-danger-text-deep font-medium'
              }`}>
                {apiStatus === 'testing' && (
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-brand-mark" />
                    <span>Contacting {provider.label}…</span>
                  </div>
                )}
                {apiStatus === 'success' && (
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-success-icon block mb-1">Model Response:</span>
                    <span className="text-content-title font-bold">{apiResponse}</span>
                  </div>
                )}
                {apiStatus === 'error' && (
                  <div>
                    <span className="text-[10px] uppercase font-bold tracking-wider text-danger-icon block mb-1">Error Details:</span>
                    <span>{apiResponse}</span>
                  </div>
                )}
              </div>
            )}
            </>}
          </div>

          {aiEnabled && <div className="space-y-2">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleSaveAI}
                className="flex-1 bg-slate-900 text-white font-bold py-3 rounded-xl hover:bg-slate-800 text-sm transition-all"
              >
                Save AI Settings
              </button>
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={apiStatus === 'testing' || !isConfigured}
                className="flex-1 bg-teal-600 text-white font-bold py-3 rounded-xl hover:bg-teal-700 text-sm transition-all flex items-center justify-center gap-2 shadow-md shadow-teal-600/10 disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4 text-yellow-300" />
                Test Connection
              </button>
            </div>
            {isConfigured ? (
              <button
                type="button"
                onClick={handleClearAI}
                className="w-full text-[11px] font-bold text-content-faint hover:text-danger-icon transition-colors"
              >
                Clear saved AI settings
              </button>
            ) : (
              <p className="text-[11px] text-content-faint text-center font-medium">
                Add a {provider.keyRequired ? 'key' : 'model'} to enable the connection test.
              </p>
            )}
          </div>}
        </div>

        {/* Legacy Data Ingestion Block */}
        <div className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="text-success-icon w-5 h-5" />
              <h3 className="text-lg font-bold text-content-heading">Legacy Data Migration</h3>
            </div>
            <p className="text-sm text-content-secondary leading-relaxed">
              Import existing inventory records from a CSV file. Use this to bulk-load medicines, supplies, services, and grooming items for testing or migration.
            </p>
          </div>
          <input
            type="file"
            id="inventoryCsvUpload"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleCSVFileImport}
          />

          <label
            htmlFor="inventoryCsvUpload"
            className="w-full bg-slate-950 text-white font-bold py-3 rounded-xl hover:bg-slate-800 text-sm transition-all flex items-center justify-center gap-2 shadow-sm mt-4 cursor-pointer"
          >
            <Database className="w-4 h-4 text-teal-400" />
            Import Inventory CSV
          </label>
        </div>

      </div>
    </div>
  );
};
