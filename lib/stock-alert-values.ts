import type { InventoryItem } from '@/types';

type StockAlertReason = 'reorder' | 'expired' | 'expires-today' | 'expiring-soon';
export type StockAlert = Pick<InventoryItem, 'itemCode' | 'itemName' | 'stock' | 'threshold' | 'expiryDate'> & {
  reasons: StockAlertReason[];
};

const MS_PER_DAY = 86_400_000;
const EXPIRY_WARNING_DAYS = 30;
const manilaDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function isStockedCategory(category: unknown): boolean {
  return category === 'Medicine' || category === 'Supplies';
}

export function isReorderDue(stock: number, threshold: number): boolean {
  return threshold > 0 && stock <= threshold;
}

export function isExpiryDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function manilaStockDay(now: Date): string {
  const parts = Object.fromEntries(manilaDate.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

export function stockAlertFor(item: InventoryItem, today: string): StockAlert | null {
  if (!isStockedCategory(item.category)) return null;
  const { itemCode, itemName, stock, threshold, expiryDate } = item;
  const reasons: StockAlertReason[] = [];
  if (isReorderDue(stock, threshold)) reasons.push('reorder');
  const date = isExpiryDate(expiryDate) ? expiryDate : null;
  if (stock > 0 && date) {
    // Date-only values are compared as calendar days, not hours left in Manila.
    const days = (Date.parse(date) - Date.parse(today)) / MS_PER_DAY;
    if (days < 0) reasons.push('expired');
    else if (days === 0) reasons.push('expires-today');
    else if (days <= EXPIRY_WARNING_DAYS) reasons.push('expiring-soon');
  }
  return reasons.length ? { itemCode, itemName, stock, threshold, ...(date ? { expiryDate: date } : {}), reasons } : null;
}
