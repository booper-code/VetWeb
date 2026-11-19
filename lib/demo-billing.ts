import type { BillingCommit, BillingEntry, BillingOperation, BillingPage, PaymentReceipt } from '@/lib/billing';
import { BILLING_TIME_ZONE, billingDayStartMs, calculateBillingTransition, readLegacyBalance, type ResolvedBillingDraft } from '@/lib/billing-values';
import type { InventoryItem, PatientRecord } from '@/types';

/** A demo-only ledger; the app owns its lifetime and never sends its contents to Firebase. */
export function createDemoBilling() {
  const entries = new Map<string, { operation: BillingOperation; entry: BillingEntry }>();
  const startingBalances = new Map<string, Pick<PatientRecord, 'balance' | 'legacyBillingBalance'>>();
  const stockDeltas = new Map<string, number>();
  const conflict = () => Object.assign(new Error('This demo record changed.'), { name: 'ClinicalConflictError' });

  return {
    startingBalances,
    stockDeltas,
    allEntries: () => Array.from(entries.values(), row => row.entry),
    history(patientId: string): BillingPage {
      return { entries: Array.from(entries.values()).map(row => row.entry).filter(entry => entry.patientId === patientId).sort((a, b) => b.seq - a.seq), next: null };
    },
    receipt(patientId: string, entryId: string): PaymentReceipt {
      const entry = entries.get(entryId)?.entry;
      if (entry?.kind !== 'payment' || entry.patientId !== patientId) throw new Error('No matching demo receipt.');
      return { ...entry, reversed: entries.has(`reverse_${entryId}`) };
    },
    commit(input: BillingOperation, patient: PatientRecord, inventory: InventoryItem[], clinicName: string, uid: string, now = Date.now()): BillingCommit {
      const { draft, operationId, expectedPatientRevision } = input;
      const previous = entries.get(operationId);
      if (previous) {
        if (previous.entry.actorUid !== uid || JSON.stringify(previous.operation) !== JSON.stringify(input) || !patient.billing) throw conflict();
        return { entry: previous.entry, state: patient.billing, patientRevision: patient.revision ?? 0, stock: [] };
      }
      if ((patient.revision ?? 0) !== expectedPatientRevision) throw conflict();
      let resolved: ResolvedBillingDraft;
      if (draft.kind === 'charge') {
        const lines = draft.lines.map(line => {
          const item = inventory.find(row => row.itemCode === line.itemCode);
          const price = readLegacyBalance(item?.sellingPrice);
          if (!item || (item.revision ?? 0) !== line.expectedRevision || price.kind !== 'valid' || price.minor !== line.unitPriceMinor) throw conflict();
          return { ...line, category: item.category, stock: item.stock, itemName: item.itemName };
        });
        resolved = { kind: 'charge', lines };
      } else if (draft.kind === 'reversal') {
        const original = entries.get(draft.originalEntryId)?.entry;
        if (!original || original.patientId !== patient.id || (original.kind !== 'payment' && original.kind !== 'charge' && original.kind !== 'unitemized-settlement')
          || operationId !== `reverse_${draft.originalEntryId}`) throw new Error('Choose a posted entry for this patient.');
        if (draft.returnStock) for (const move of original.stockMoves) {
          const item = inventory.find(row => row.itemCode === move.itemCode);
          if (!item || (item.revision ?? 0) !== draft.expectedStockRevisions[move.itemCode]) throw conflict();
        }
        resolved = { ...draft, original };
      } else resolved = draft;

      const raw = patient.legacyBillingBalance === undefined ? patient.balance : patient.legacyBillingBalance;
      const transition = calculateBillingTransition(patient.billing ?? null, raw, resolved, now);
      const state = { ...transition.next, lastEntryId: operationId };
      const common = { id: operationId, clinicId: input.clinicId, patientId: patient.id, actorUid: uid, recordedAtMs: now,
        seq: state.seq, balanceBeforeMinor: patient.billing?.balanceMinor ?? 0, balanceAfterMinor: state.balanceMinor, stockMoves: transition.stockMoves };
      let entry: BillingEntry;
      switch (resolved.kind) {
        case 'opening': {
          const legacy = readLegacyBalance(raw);
          entry = { ...common, kind: 'opening', amountMinor: resolved.verifiedMinor, source: resolved.source,
            cutoffMs: resolved.cutoffMs, reason: resolved.reason ?? '', legacyOriginalMinor: legacy.kind === 'valid' ? legacy.minor : null };
          break;
        }
        case 'opening-correction':
          entry = { ...common, kind: 'opening-correction', amountMinor: resolved.verifiedMinor, source: resolved.source, reason: resolved.reason };
          break;
        case 'payment':
          entry = { ...common, ...resolved, reference: resolved.reference ?? '', note: resolved.note ?? '',
            clinicName, patientName: patient.name, timeZone: BILLING_TIME_ZONE, businessDayMs: billingDayStartMs(resolved.occurredAtMs) };
          break;
        case 'charge':
          entry = { ...common, kind: 'charge', lines: resolved.lines, amountMinor: transition.deltaMinor };
          break;
        case 'unitemized-settlement':
          entry = { ...common, ...resolved };
          break;
        case 'reversal':
          entry = { ...common, kind: 'reversal', originalEntryId: resolved.originalEntryId, reason: resolved.reason,
            returnStock: resolved.returnStock, amountMinor: resolved.original.amountMinor };
          break;
      }
      const stock = transition.stockMoves.map(({ itemCode, quantityDelta }) => {
        const item = inventory.find(row => row.itemCode === itemCode);
        if (!item || !Number.isSafeInteger(item.stock + quantityDelta) || item.stock + quantityDelta < 0) throw conflict();
        return { itemCode, stock: item.stock + quantityDelta, revision: (item.revision ?? 0) + 1, billingStockEntryId: operationId };
      });
      if (!startingBalances.has(patient.id)) startingBalances.set(patient.id, { balance: patient.balance, legacyBillingBalance: patient.legacyBillingBalance });
      for (const move of transition.stockMoves) stockDeltas.set(move.itemCode, (stockDeltas.get(move.itemCode) ?? 0) + move.quantityDelta);
      entries.set(operationId, { operation: input, entry });
      return { entry, state, patientRevision: expectedPatientRevision + 1, stock };
    },
  };
}
