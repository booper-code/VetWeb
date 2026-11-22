import { initializeFirebase } from '@/lib/firebase';

const CLINIC_COLLECTIONS = [
  'patients',
  'inventory',
  'consultations',
  'appointments',
  'billingEntries',
  'staff',
  'payProfiles',
  'payrollPeriods',
  'payrollLedger',
  'payrollMeta',
  'auditHeads',
  'auditEvents'
] as const;

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'clinic';

/**
 * Downloads selected clinic records. Pages are read from the server, but
 * the export is not a transaction or a point-in-time recovery artifact.
 */
export const exportClinicBackup = async ({
  clinicId,
  clinicName
}: {
  clinicId: string;
  clinicName: string;
}): Promise<{ collectionCount: number; documentCount: number }> => {
  const { db, firestore: fs } = await initializeFirebase();
  if (!db || !fs) throw new Error('Firebase is not available.');

  const requireServerData = ({ fromCache, hasPendingWrites }: import('firebase/firestore').SnapshotMetadata) => {
    if (fromCache || hasPendingWrites) throw new Error('Export stopped: reconnect and let local changes sync before trying again.');
  };

  const readAll = async (path: string[]) => {
    const records: Record<string, unknown>[] = [];
    let cursor: import('firebase/firestore').QueryDocumentSnapshot | undefined;
    for (;;) {
      const constraints: import('firebase/firestore').QueryConstraint[] = [fs.orderBy(fs.documentId()), fs.limit(200)];
      if (cursor) constraints.push(fs.startAfter(cursor));
      const snapshot = await fs.getDocsFromServer(fs.query(fs.collection(db, path[0], ...path.slice(1)), ...constraints));
      requireServerData(snapshot.metadata);
      records.push(...snapshot.docs.map(document => ({ ...document.data(), id: document.id })));
      if (snapshot.size < 200) return records;
      cursor = snapshot.docs.at(-1);
    }
  };

  const clinicSnapshot = await fs.getDocFromServer(fs.doc(db, 'clinics', clinicId));
  requireServerData(clinicSnapshot.metadata);
  if (!clinicSnapshot.exists()) throw new Error('Export stopped: the clinic could not be found.');
  const members = await readAll(['clinics', clinicId, 'members']);
  const invitations = await readAll(['clinics', clinicId, 'invitations']);

  const collections: Record<string, unknown[]> = {};
  for (const name of CLINIC_COLLECTIONS) collections[name] = await readAll(['clinics', clinicId, name]);

  const backup = {
    format: 'vetcloudpro-clinic-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    clinicId,
    clinicName,
    clinic: { ...clinicSnapshot.data(), id: clinicSnapshot.id },
    members,
    invitations,
    collections
  };

  const documentCount = Object.values(collections).reduce((total, items) => total + items.length, 0);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slugify(clinicName)}-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);

  return { collectionCount: CLINIC_COLLECTIONS.length, documentCount };
};
