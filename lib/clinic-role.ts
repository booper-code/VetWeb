import type { ClinicRole } from '@/types';

/** Editor and viewer are the stored values used before the two-role model. */
export function normalizeClinicRole(role: unknown): ClinicRole | null {
  if (role === 'owner') return 'owner';
  if (role === 'member' || role === 'editor' || role === 'viewer') return 'member';
  return null;
}
