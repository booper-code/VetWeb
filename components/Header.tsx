"use client";

import React from 'react';
import { Menu, Plus } from 'lucide-react';
import type { ClinicRole } from '@/types';
import { ThemeSelector } from '@/components/ThemeSelector';

const roleLabel = (role: ClinicRole | null) => {
  if (role === 'owner') return 'Owner';
  if (role === 'editor') return 'Editor';
  if (role === 'viewer') return 'Viewer';
  return 'Demo';
};

export const Header = ({
  toggleSidebar,
  searchQuery,
  setSearchQuery,
  currentClinicRole,
  onRecordVisit,
  canEdit,
  assistantAction
}: {
  toggleSidebar: () => void;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  currentClinicRole: ClinicRole | null;
  onRecordVisit: () => void;
  canEdit: boolean;
  assistantAction?: React.ReactNode;
}) => (
  <header className="sticky top-0 z-40 border-b border-line bg-panel">
    <div className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2.5 md:flex md:gap-3 md:px-6 md:py-3">
      <button
        type="button"
        aria-label="Toggle navigation"
        onClick={toggleSidebar}
        className="col-start-1 row-start-1 grid h-10 w-10 place-items-center rounded-[9px] border border-menu-line bg-menu-tint text-menu-text md:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <ThemeSelector className="col-start-2 row-start-1 justify-self-start md:order-4 md:shrink-0" />

      <div
        className="col-start-3 row-start-1 flex h-10 items-center justify-self-end gap-1.5 rounded-[9px] border border-control-line px-2.5 text-[12px] font-semibold text-role-text md:order-3 md:shrink-0"
        title="Roles and permissions are managed by the clinic owner"
      >
        <span className="text-[10px] font-bold uppercase tracking-[0.8px] text-role-label">Role</span>
        {roleLabel(currentClinicRole)}
      </div>

      <label
        htmlFor="workspace-search"
        className="col-span-2 col-start-1 row-start-2 block min-w-0 md:order-1 md:mr-auto md:max-w-[470px] md:flex-1"
      >
        <span className="sr-only">Search records</span>
        <input
          id="workspace-search"
          type="search"
          value={searchQuery}
          maxLength={100}
          onChange={event => setSearchQuery(event.target.value)}
          placeholder="Search a patient, appointment or item…"
          className="block h-10 w-full rounded-[9px] border border-search-line bg-search-field px-3 py-1.5 text-[13px] text-ink placeholder:text-muted"
        />
      </label>

      <div className={`col-start-3 row-start-2 flex items-center justify-end gap-2 md:order-2 ${assistantAction ? 'max-[359px]:col-span-3 max-[359px]:row-start-3' : ''}`}>
        {assistantAction}
        <button
          type="button"
          onClick={onRecordVisit}
          disabled={!canEdit}
          title={canEdit ? 'Record a visit for a patient' : 'An online owner or editor session is required to record a visit.'}
          className="vc-btn vc-btn-primary h-10"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Record visit
        </button>
      </div>
    </div>
  </header>
);
