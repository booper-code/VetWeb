"use client";

import React, { useState } from 'react';
import { Sparkles, FileSpreadsheet, Database } from 'lucide-react';
import type { InventoryItem } from '@/types';
import { AIProviderSettings } from '@/components/AIProviderSettings';

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
  onAddInventoryItem: (item: InventoryItem, csvBatchId?: string) => Promise<void>;
  aiEnabled: boolean;
  canManageAI: boolean;
  isDemo: boolean;
  onSetAIEnabled: (enabled: boolean) => Promise<void>;
  triggerToast: (msg: string) => void; 
}) => {
  const [isSavingToggle, setIsSavingToggle] = useState(false);
  const [toggleError, setToggleError] = useState('');

  const parseCSVLine = (line: string) => {
    const result: string[] = [];
    let current = '';
    let insideQuotes = false;
    let closedQuote = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (char === '"' && insideQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        if (insideQuotes) {
          insideQuotes = false;
          closedQuote = true;
        } else {
          if (closedQuote || current.trim()) return null;
          insideQuotes = true;
        }
      } else if (char === ',' && !insideQuotes) {
        result.push(current.trim());
        current = '';
        closedQuote = false;
      } else if (closedQuote) {
        if (char.trim()) return null;
      } else {
        current += char;
      }
    }

    if (insideQuotes) return null;
    result.push(current.trim());
    return result;
  };

  const normalizeCategory = (value: string): InventoryItem['category'] => {
    const cleaned = value.toLowerCase().trim();

    if (cleaned.includes('supply') || cleaned.includes('supplies')) return 'Supplies';
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
          .map((row, index) => ({ text: row.trim(), line: index + 1 }))
          .filter(row => row.text);

        if (rows.length < 2) {
          triggerToast("CSV import failed. File has no data rows.");
          return;
        }

        const headerValues = parseCSVLine(rows[0].text);
        if (!headerValues) {
          triggerToast(`CSV row ${rows[0].line}: invalid field quoting. Nothing was imported.`);
          return;
        }
        const headers = headerValues.map(header =>
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
        for (const row of rows.slice(1)) {
          const values = parseCSVLine(row.text);
          if (!values) {
            triggerToast(`CSV row ${row.line}: invalid field quoting. Nothing was imported.`);
            return;
          }

          const itemName = getValue(values, ['itemname', 'name', 'description']);
          if (!itemName) continue;

          const category = normalizeCategory(
            getValue(values, ['category', 'type', 'classification'])
          );

          const isService = category === 'Service' || category === 'Grooming';
          const rawStock = getValue(values, ['stock', 'quantity', 'qty']);
          const stock = isService ? 999 : Number(rawStock);
          if (!isService && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawStock) || !Number.isFinite(stock))) {
            triggerToast(`CSV row ${row.line}: stock must be a non-negative number. Nothing was imported.`);
            return;
          }

          const rawCode = getValue(values, ['itemcode', 'code', 'sku']);
          const prefix = isService ? 'SRV' : 'ITM';
          const generatedCode = `${prefix}-CSV-${crypto.randomUUID()}`;
          const itemCode = rawCode || generatedCode;

          if (existingCodes.has(itemCode)) continue;

          existingCodes.add(itemCode);

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
        }

        if (importedItems.length === 0) {
          triggerToast("No new valid inventory items found in CSV.");
          return;
        }

        const batchId = process.env.NEXT_PUBLIC_CSV_IMPORT_RECEIPTS === '1' && !isDemo ? crypto.randomUUID() : undefined;
        for (const item of importedItems) {
          await onAddInventoryItem(item, batchId);
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
              <p className="text-xs font-bold text-warning-text">Lab extraction and summaries are currently demonstrations with example data, not real AI analysis. Do not use them for clinical decisions.</p>
              {isDemo
                ? <p className="vc-note">Provider connections are unavailable in the offline demo.</p>
                : <AIProviderSettings triggerToast={triggerToast} />}
            </>}
          </div>
        </div>

        {/* Legacy Data Ingestion Block */}
        <div className="bg-panel p-6 rounded-2xl border border-outline-soft shadow-sm space-y-4 flex flex-col justify-between">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="text-success-icon w-5 h-5" />
              <h3 className="text-lg font-bold text-content-heading">Legacy Data Migration</h3>
            </div>
            <p className="text-sm text-content-secondary leading-relaxed">
              Import medicines, supplies, services, and grooming items from a CSV file. Give medicines and supplies an explicit stock quantity (use 0 for none).
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
