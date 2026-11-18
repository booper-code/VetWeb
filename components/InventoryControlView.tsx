"use client";

import React, { useState } from 'react';
import { Package, AlertCircle, TrendingUp, PlusCircle, X, Trash2, Download, Loader2 } from 'lucide-react';
import type { InventoryItem } from '@/types';
import { exportInventoryPdf } from '@/lib/pdf';

export const InventoryControlView = ({ 
  inventory, 
  clinicName,
  onAddInventoryItem,
  onUpdateInventoryItem,
  onDeleteInventoryItem,
  searchQuery,
  triggerToast,
  partialData = false,
  canEdit = true
}: { 
  inventory: InventoryItem[]; 
  clinicName: string;
  onAddInventoryItem: (item: InventoryItem) => Promise<void>;
  onUpdateInventoryItem: (item: InventoryItem) => Promise<void>;
  onDeleteInventoryItem: (itemCode: string) => Promise<void>;
  searchQuery: string;
  triggerToast: (msg: string) => void;
  partialData?: boolean;
  canEdit?: boolean;
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [isExporting, setIsExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const handleExportPdf = async () => {
    setIsExporting(true);
    try {
      await exportInventoryPdf({ clinicName, items: inventory });
      triggerToast('Inventory PDF exported.');
    } catch (error) {
      console.error('[Inventory] PDF export failed:', error);
      triggerToast('Could not export the inventory PDF.');
    } finally {
      setIsExporting(false);
    }
  };
  
  // Clean, dark-mode protected input form values
  const [itemName, setItemName] = useState('');
  const [category, setCategory] = useState<'Medicine' | 'Supplies' | 'Service' | 'Grooming'>('Medicine');
  const [stock, setStock] = useState<number | ''>('');
  const [buyingPrice, setBuyingPrice] = useState<number | ''>('');
  const [sellingPrice, setSellingPrice] = useState<number | ''>('');
  const [threshold, setThreshold] = useState<number | ''>('');

  // States for the Inventory Edit Slide-out Drawer
  const [selectedItemSnapshot, setSelectedItem] = useState<InventoryItem | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<InventoryItem | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const selectedItem = selectedItemSnapshot && !isEditing
    ? inventory.find(item => item.itemCode === selectedItemSnapshot.itemCode) ?? selectedItemSnapshot
    : selectedItemSnapshot;

  
const filteredInventory = inventory.filter(item => {
    const matchesCategory = selectedCategory === 'All' ? true : item.category === selectedCategory;
    const matchesSearch = searchQuery.trim().length === 0 ? true : item.itemName.toLowerCase().includes(searchQuery.toLowerCase()) || item.itemCode.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canEdit || saving) return;
    setSaveError('');

    const isService = category === 'Service' || category === 'Grooming';

    if (!itemName.trim() || sellingPrice === '') return;

    if (!isService && buyingPrice === '') return;
    if (![sellingPrice, isService ? 0 : buyingPrice, stock || 0, threshold || 0]
      .every(value => Number.isFinite(Number(value)) && Number(value) >= 0)) {
      setSaveError('Prices, stock and thresholds must be non-negative numbers.');
      return;
    }

    const finalStock = isService ? 999 : Number(stock) || 0;
    const finalThreshold = isService ? 0 : Number(threshold) || 0;
    const prefix = isService ? 'SRV' : 'ITM';
    const nextCode = `${prefix}-${crypto.randomUUID()}`;

    const newItem: InventoryItem = {
      itemCode: nextCode,
      itemName,
      category,
      stock: finalStock,
      buyingPrice: isService ? 0 : Number(buyingPrice),
      sellingPrice: Number(sellingPrice),
      threshold: finalThreshold
    };

    console.log('[UI] submitting new inventory', newItem.itemCode);
    setSaving(true);
    try { await onAddInventoryItem(newItem); }
    catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save. Your input has been kept.');
      return;
    } finally { setSaving(false); }

    // Reset Form
    setItemName('');
    setStock('');
    setBuyingPrice('');
    setSellingPrice('');
    setThreshold('');
  };

  const handleSaveEdits = async () => {
    if (!editForm || !canEdit || saving) return;
    setSaveError('');
    console.log('[UI] saving edits for', editForm.itemCode);
    setSaving(true);
    try { await onUpdateInventoryItem(editForm); }
    catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not save. Your input has been kept.');
      return;
    } finally { setSaving(false); }
    setSelectedItem(editForm);
    setIsEditing(false);
  };

  const handleDeleteItem = async () => {
    if (!selectedItem || !canEdit || saving) return;
    console.log('[UI] deleting', selectedItem.itemCode);
    setSaving(true);
    try { await onDeleteInventoryItem(selectedItem.itemCode); }
    catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Could not delete. Nothing was removed.');
      return;
    } finally { setSaving(false); }
    setSelectedItem(null);
    setIsEditing(false);
    setShowDeleteConfirm(false);
  };



  return (
    <div className="space-y-6 relative">
      {!canEdit && <p role="status" className="rounded-xl border border-warning-stroke bg-warning-wash p-3 text-sm text-warning-text-deep">Inventory is read-only. Changes require an online owner or editor.</p>}
      {saveError && <p role="alert" className="rounded-xl bg-danger-wash p-3 text-sm text-danger-text-deep">{saveError}</p>}
      {partialData && <p role="note" className="rounded-xl border border-warning-stroke bg-warning-wash p-3 text-sm text-warning-text-deep">
        Search, counts and PDF exports cover loaded inventory only. Load more items below to expand the list.
      </p>}
        
      {/* --- SLIDE-OUT INVENTORY DETAILS & EDIT DRAWER --- */}
      {selectedItem && 
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop click dismisser */}
          <div 
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" 
            onClick={() => {
              setSelectedItem(null);
              setIsEditing(false);
              setShowDeleteConfirm(false);
            }} 
          />
          
          {/* Sliding Frame Panel */}
          <div className="relative w-full max-w-2xl bg-panel-subtle h-full shadow-2xl flex flex-col border-l border-outline-soft overflow-hidden transform transition-transform duration-300 ease-in-out">
            {/* Drawer Header */}
            <div className="bg-panel border-b border-outline-soft px-6 py-4 flex items-center justify-between sticky top-0 z-10">
              <div>
                <h2 className="text-xl font-bold text-content-heading">
                  {isEditing ? `Editing Catalog Item` : selectedItem.itemName}
                </h2>
                <p className="text-sm text-content-hint">
                  Item Code: {selectedItem.itemCode} | {selectedItem.category}
                </p>
              </div>
              <button 
                onClick={() => {
                  setSelectedItem(null);
                  setIsEditing(false);
                  setShowDeleteConfirm(false);
                }}
                className="p-2 text-content-faint hover:bg-panel-raised hover:text-content-secondary rounded-full transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Drawer Scrollable Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {isEditing && editForm ? (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  
                  <div className="bg-panel rounded-2xl p-5 border border-outline-soft shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-content-faint uppercase tracking-wider flex items-center gap-2">
                      <Package className="w-4 h-4" /> Item Details
                    </h3>
                    <div>
                      <label className="text-xs font-bold text-content-copy block mb-1">Item Name / Description</label>
                      <input 
                        type="text" 
                        className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                        value={editForm.itemName} 
                        onChange={e => setEditForm({ ...editForm, itemName: e.target.value })} 
                      />
                    </div>
                    <div>
                      <label className="text-xs font-bold text-content-copy block mb-1">Category</label>
                      <select 
                        className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                        value={editForm.category}
                        onChange={e => setEditForm({ ...editForm, category: e.target.value as InventoryItem['category'] })}
                      >
                        <option value="Medicine">Medicine</option>
                        <option value="Supplies">Clinical Supplies</option>
                        <option value="Service">Medical Service / Procedure</option>
                        <option value="Grooming">Grooming Service</option>
                      </select>
                    </div>
                    {editForm.category !== 'Service' && editForm.category !== 'Grooming' && (
                      <div>
                        <label className="text-xs font-bold text-content-copy block mb-1">Current Stock Level</label>
                        <input 
                          type="number" 
                          className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                          value={editForm.stock} 
                          onChange={e => setEditForm({ ...editForm, stock: parseInt(e.target.value) || 0 })} 
                        />
                      </div>
                    )}
                  </div>

                  <div className="bg-panel rounded-2xl p-5 border border-outline-soft shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-content-faint uppercase tracking-wider flex items-center gap-2">
                      <TrendingUp className="w-4 h-4" /> Pricing & Thresholds
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="text-xs font-bold text-content-copy block mb-1">Buying Price (PHP)</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                          value={editForm.buyingPrice} 
                          onChange={e => setEditForm({ ...editForm, buyingPrice: parseFloat(e.target.value) || 0 })} 
                        />
                      </div>
                      <div>
                        <label className="text-xs font-bold text-content-copy block mb-1">Selling Price (PHP)</label>
                        <input 
                          type="number" 
                          step="0.01" 
                          className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                          value={editForm.sellingPrice} 
                          onChange={e => setEditForm({ ...editForm, sellingPrice: parseFloat(e.target.value) || 0 })} 
                        />
                      </div>
                      {editForm.category !== 'Service' && editForm.category !== 'Grooming' && (
                        <div className="col-span-2">
                          <label className="text-xs font-bold text-content-copy block mb-1">Low-Stock Alert Threshold</label>
                          <input 
                            type="number" 
                            className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                            value={editForm.threshold} 
                            onChange={e => setEditForm({ ...editForm, threshold: parseInt(e.target.value) || 0 })} 
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-danger-wash rounded-2xl p-5 border border-danger-stroke shadow-sm space-y-3">
                    <h3 className="text-sm font-bold text-danger-text-deep flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 text-danger-icon" /> Danger Zone
                    </h3>
                    <p className="text-xs text-danger-text leading-relaxed">
                      Permanently deleting this item removes it completely from the catalog. This action cannot be undone.
                    </p>
                    
                    {!showDeleteConfirm ? (
                      <button 
                        type="button"
                        onClick={() => setShowDeleteConfirm(true)}
                        className="flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white text-xs font-bold px-4 py-2.5 rounded-xl transition-all shadow-sm"
                      >
                        <Trash2 className="w-4 h-4" /> Delete Catalog Item
                      </button>
                    ) : (
                      <div className="p-3 bg-panel border border-danger-stroke rounded-xl space-y-3">
                        <p className="text-xs font-bold text-danger-icon">Are you absolutely sure you want to delete this item?</p>
                        <div className="flex gap-2">
                          <button 
                            type="button"
                            onClick={() => setShowDeleteConfirm(false)}
                            className="bg-panel-raised text-content-copy hover:bg-panel-pressed px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                          >
                            Cancel
                          </button>
                          <button 
                            type="button"
                            onClick={handleDeleteItem}
                            className="bg-red-600 hover:bg-red-700 text-white px-4 py-1.5 rounded-lg text-xs font-black transition-all shadow-inner"
                          >
                            Yes, Confirm Delete
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
                  <div className="bg-panel rounded-2xl p-5 border border-outline-soft shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-content-faint uppercase tracking-wider flex items-center gap-2">
                      <Package className="w-4 h-4" /> Item Summary
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="col-span-2">
                        <p className="text-xs text-content-hint mb-1">Category</p>
                        <p className="text-sm font-bold text-content-heading">{selectedItem.category}</p>
                      </div>
                      {selectedItem.category !== 'Service' && selectedItem.category !== 'Grooming' ? (
                        <>
                          <div>
                            <p className="text-xs text-content-hint mb-1">In Stock</p>
                            <p className={`text-lg font-black ${selectedItem.stock <= selectedItem.threshold ? 'text-danger-icon' : 'text-content-heading'}`}>
                              {selectedItem.stock} units
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-content-hint mb-1">Alert Threshold</p>
                            <p className="text-lg font-bold text-content-copy">{selectedItem.threshold} units</p>
                          </div>
                        </>
                      ) : (
                        <div className="col-span-2">
                          <p className="text-xs text-content-hint mb-1">Availability</p>
                          <span className="text-sm font-bold text-content-faint">∞ Service (Unlimited)</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="bg-panel rounded-2xl p-5 border border-outline-soft shadow-sm space-y-4">
                    <h3 className="text-xs font-bold text-content-faint uppercase tracking-wider flex items-center gap-2">
                      <TrendingUp className="w-4 h-4" /> Pricing Matrix
                    </h3>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-panel-subtle p-4 rounded-xl border border-hairline">
                        <p className="text-xs text-content-hint mb-1">Cost Price</p>
                        <p className="text-lg font-bold text-content-copy">PHP {selectedItem.buyingPrice.toFixed(2)}</p>
                      </div>
                      <div className="bg-success-wash p-4 rounded-xl border border-success-stroke-soft">
                        <p className="text-xs text-success-icon font-bold mb-1">Selling Price</p>
                        <p className="text-xl font-black text-success-text">PHP {selectedItem.sellingPrice.toFixed(2)}</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Drawer Footer Actions */}
            <div className="p-4 border-t border-outline-soft bg-panel flex gap-3">
              {isEditing ? (
                <>
                  <button onClick={() => setIsEditing(false)} className="flex-1 bg-panel border border-outline text-content-title font-bold py-3 rounded-xl hover:bg-panel-subtle transition-colors shadow-sm">
                    Cancel Edits
                  </button>
                  <button disabled={!canEdit || saving} onClick={handleSaveEdits} className="flex-1 bg-teal-600 text-white font-bold py-3 rounded-xl hover:bg-teal-700 transition-colors shadow-md shadow-teal-600/20">
                    Save Changes
                  </button>
                </>
              ) : (
                <button disabled={!canEdit} onClick={() => { setEditForm(selectedItem); setIsEditing(true); }} className="vc-btn vc-btn-primary w-full py-3">
                  Edit Item Details
                </button>
              )}
            </div>
          </div>
        </div>
                }

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold text-ink">Inventory & Service Control</h2>
          <p className="font-medium text-muted">Consolidates legacy items, medicines, and surgical procedures into one cohesive catalog.</p>
        </div>
        <button
          type="button"
          onClick={handleExportPdf}
          disabled={isExporting || inventory.length === 0}
          className="vc-btn ml-auto"
        >
          {isExporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
          Export PDF
        </button>
      </div>

      {/* Category Toggle Filters */}
      <div className="flex flex-wrap gap-2">
        {['All', 'Medicine', 'Supplies', 'Service', 'Grooming'].map(cat => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${
              selectedCategory === cat
                ? 'border-accent bg-accent text-white shadow-sm'
                : 'border-line bg-panel text-muted hover:bg-soft'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* --- LEFT FORM: ADD ITEM / SERVICE --- */}
        <div className="h-fit rounded-[14px] border border-line bg-panel p-6 shadow-[0_2px_10px_#243e5607]">
          <h3 className="mb-6 flex items-center gap-2 border-b border-line pb-4 text-lg font-bold text-ink">
            <PlusCircle className="text-brand-text w-5 h-5" />
            New Item / Service
          </h3>
          
          <form onSubmit={handleSubmit} className="space-y-4">
            <fieldset disabled={!canEdit || saving} className="contents">
            <div>
              <label className="text-xs font-bold text-content-copy block mb-1">Name / Procedure Description *</label>
              <input 
                type="text" 
                className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                placeholder="e.g. Ketoconazole 200mg" 
                value={itemName} 
                onChange={e => setItemName(e.target.value)} 
                required 
              />
            </div>

            <div>
              <label className="text-xs font-bold text-content-copy block mb-1">Catalog Classification</label>
              <select 
                className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                value={category}
                onChange={e => setCategory(e.target.value as InventoryItem['category'])}
              >
                <option value="Medicine">Medicine</option>
                <option value="Supplies">Clinical Supplies</option>
                <option value="Service">Medical Service / Procedure</option>
                <option value="Grooming">Grooming Service</option>
              </select>
            </div>

            {category !== 'Service' && category !== 'Grooming' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-bold text-content-copy block mb-1">Initial Stock</label>
                  <input 
                    type="number" 
                    className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                    placeholder="e.g. 50" 
                    value={stock} 
                    onChange={e => setStock(e.target.value ? Number(e.target.value) : '')} 
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-content-copy block mb-1">Low-Stock Alert</label>
                  <input 
                    type="number" 
                    className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                    placeholder="e.g. 10" 
                    value={threshold} 
                    onChange={e => setThreshold(e.target.value ? Number(e.target.value) : '')} 
                  />
                </div>
              </div>
            )}

            {category === 'Service' || category === 'Grooming' ? (
              <div className="pt-2">
                <label className="text-xs font-bold text-content-copy block mb-1">
                  Service Fee (PHP) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                  placeholder="0.00"
                  value={sellingPrice}
                  onChange={e => setSellingPrice(e.target.value ? Number(e.target.value) : '')}
                  required
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4 pt-2">
                <div>
                  <label className="text-xs font-bold text-content-copy block mb-1">
                    Buying Price (PHP) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                    placeholder="0.00"
                    value={buyingPrice}
                    onChange={e => setBuyingPrice(e.target.value ? Number(e.target.value) : '')}
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-bold text-content-copy block mb-1">
                    Selling Price (PHP) *
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full p-2.5 bg-field-subtle border border-field-outline rounded-xl text-sm text-content-title font-bold focus:ring-2 focus:ring-teal-500 outline-none"
                    placeholder="0.00"
                    value={sellingPrice}
                    onChange={e => setSellingPrice(e.target.value ? Number(e.target.value) : '')}
                    required
                  />
                </div>
              </div>
            )}

            <button 
              type="submit" 
              className="vc-btn vc-btn-primary mt-4 w-full py-3"
            >
              Add to Catalog
            </button>
            </fieldset>
          </form>
        </div>

        {/* --- RIGHT: DYNAMIC DIRECTORY VIEW --- */}
        <div className="flex flex-col overflow-hidden rounded-[14px] border border-line bg-panel shadow-[0_2px_10px_#243e5607] xl:col-span-2">
          <div className="p-6 border-b border-outline-soft bg-panel-subtle/50 flex justify-between items-center">
            <h3 className="text-lg font-bold text-content-heading">Unified Catalog List</h3>
            <span className="text-xs font-bold text-content-hint bg-panel-pressed px-3 py-1 rounded-full">
              {filteredInventory.length} Items Listed
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-panel-subtle text-content-hint text-xs font-semibold uppercase border-b border-outline-soft">
                  <th className="p-4">Code</th>
                  <th className="p-4">Item description</th>
                  <th className="p-4 text-center">Stock level</th>
                  <th className="p-4 text-right">Cost Price</th>
                  <th className="p-4 text-right">Sale Price</th>
                  <th className="p-4 text-right">Margin %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {filteredInventory.map((item) => {
                  const isService = item.category === 'Service' || item.category === 'Grooming';
                  const marginValue = item.sellingPrice - item.buyingPrice;
                  const marginPct = item.sellingPrice > 0 ? (marginValue / item.sellingPrice) * 100 : 0;

                  return (
                    <tr 
                      key={item.itemCode}
                      onClick={() => {
                        setSelectedItem(item);
                        setEditForm(item);
                        setIsEditing(false);
                        setShowDeleteConfirm(false);
                      }}
                      className="hover:bg-panel-subtle transition-colors cursor-pointer group"
                    >
                      <td className="p-4 text-sm font-bold text-content-heading group-hover:text-brand-text transition-colors">{item.itemCode}</td>
                      <td className="p-4 text-sm font-bold text-content-heading">
                        <div>
                          {item.itemName}
                          <span className="text-[10px] text-content-hint block uppercase font-bold mt-0.5 tracking-wider">{item.category}</span>
                        </div>
                      </td>
                      <td className="p-4 text-center">
                        {isService ? (
                          <span className="text-xs font-bold text-content-faint">∞ Service</span>
                        ) : (
                          <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-black ${
                            item.stock <= item.threshold ? 'bg-danger-tint text-danger-text-deep' : 'bg-panel-raised text-content-heading'
                          }`}>
                            {item.stock} unit/s
                          </span>
                        )}
                      </td>
                      <td className="p-4 text-sm text-content-heading text-right font-medium">
                        PHP {item.buyingPrice.toFixed(2)}
                      </td>
                      <td className="p-4 text-sm text-content-title text-right font-bold">
                        PHP {item.sellingPrice.toFixed(2)}
                      </td>
                      <td className="p-4 text-sm text-right font-bold text-success-icon">
                        {isService ? 'N/A' : `${marginPct.toFixed(0)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
