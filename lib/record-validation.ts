import type { PatientRecord, InventoryItem } from '@/types';
import { isExpiryDate, isStockedCategory } from '@/lib/stock-alert-values';

export function patientValidationError(record: PatientRecord): string | null {
  if (!record.name.trim() || record.name.length > 150) return 'Enter a patient name of up to 150 characters.';
  if (!['Male', 'Female', 'Unknown'].includes(record.gender)) return 'Choose a valid gender.';
  if (!['Waiting', 'In Treatment', 'Confined', 'Ready for Pickup', 'Discharged'].includes(record.status)) return 'Choose a valid clinical status.';
  if (!Number.isFinite(record.weight) || record.weight < 0 || !Number.isFinite(record.balance) || record.balance < 0) {
    return 'Weight and balance must be non-negative finite numbers.';
  }
  const digits = record.ownerContact.replace(/\D/g, '');
  if (record.ownerContact && (digits.length < 7 || digits.length > 15)) return 'Enter a valid owner contact number.';
  if (record.ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.ownerEmail)) return 'Enter a valid owner email address.';
  return null;
}

export function inventoryValidationError(item: InventoryItem): string | null {
  if (!item.itemName.trim() || item.itemName.length > 200) return 'Enter an item name of up to 200 characters.';
  if (!['Medicine', 'Supplies', 'Service', 'Grooming'].includes(item.category)) return 'Choose a valid inventory category.';
  if (![item.stock, item.buyingPrice, item.sellingPrice, item.threshold].every(value => Number.isFinite(value) && value >= 0)) {
    return 'Stock, prices and thresholds must be non-negative finite numbers.';
  }
  if (item.expiryDate !== undefined && (!isStockedCategory(item.category) || !isExpiryDate(item.expiryDate))) {
    return 'Enter a valid expiry date for a medicine or supply item, or leave it blank.';
  }
  return null;
}
