import type { PatientRecord } from '@/types';

export type PatientSearchMatch = Pick<PatientRecord, 'id' | 'name' | 'ownerName' | 'status'>;

export function patientSearchMatch(patient: PatientRecord, normalizedQuery: string): PatientSearchMatch | null {
  const { id, name, ownerName, status } = patient;
  return [name, ownerName, id].some(value => value.toLowerCase().includes(normalizedQuery))
    ? { id, name, ownerName, status }
    : null;
}
