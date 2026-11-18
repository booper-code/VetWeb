'use client';

import { useSyncExternalStore } from 'react';
import { Moon } from 'lucide-react';
import { getThemePreference, normalizeThemePreference, setThemePreference, subscribeThemePreference } from '@/lib/theme';

export function ThemeSelector({ className = '' }: { className?: string }) {
  const preference = useSyncExternalStore(subscribeThemePreference, getThemePreference, () => 'system');
  return (
    <label className={`vc-appearance ${className}`}>
      <span className="sr-only">Appearance</span>
      <Moon aria-hidden="true" className="h-4 w-4 shrink-0" />
      <select
        title="Appearance"
        value={preference}
        onChange={event => setThemePreference(normalizeThemePreference(event.target.value))}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
