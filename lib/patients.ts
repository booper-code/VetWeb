import type { PatientRecord } from '@/types';

/**
 * Next sequential patient id, e.g. `PAT-00104`.
 *
 * The id used to be derived from `patients.length`, which reuses ids after a
 * deletion: with three patients the next id is `PAT-00104`, but delete one and
 * the following admission becomes `PAT-00103` and silently overwrites the
 * patient that already owns it. Walking the highest existing id instead keeps
 * ids unique for as long as the record they belong to exists.
 */
export const nextPatientId = (existing: PatientRecord[]): string => {
  const highest = existing.reduce((max, patient) => {
    const match = /^PAT-(\d+)$/.exec(patient.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 100);

  return `PAT-${String(highest + 1).padStart(5, '0')}`;
};
