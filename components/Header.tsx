"use client";

import React from 'react';
import { Menu, Plus } from 'lucide-react';
import type { ClinicRole } from '@/types';

type WorkspaceView = 'quick' | 'advanced';

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
  mode,
  onModeChange,
  onRecordVisit,
  canEdit
}: {
  toggleSidebar: () => void;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  currentClinicRole: ClinicRole | null;
  mode: WorkspaceView;
  onModeChange: (mode: WorkspaceView) => void;
  onRecordVisit: () => void;
  canEdit: boolean;
}) => (
  <header className="sticky top-0 z-40 border-b border-line bg-white">
    <div className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-end gap-2 px-3 py-2.5 md:flex md:flex-wrap md:items-center md:gap-3 md:px-6 md:py-3">
      <button
        type="button"
        aria-label="Toggle navigation"
        onClick={toggleSidebar}
        className="col-start-1 row-start-1 grid h-10 w-10 place-items-center rounded-[9px] border border-[#d0e8da] bg-[#eaf5ed] text-[#156350] md:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <div className="col-start-2 row-start-1 min-w-0 md:order-3 md:w-[171px] md:shrink-0">
        <span className="block pb-1 text-[10px] font-bold uppercase tracking-[0.8px] text-[#526765]">Workspace view</span>
        <div role="group" aria-label="Workspace view" className="flex gap-0.5 rounded-[9px] border border-[#d6e0e8] bg-[#f1f4f7] p-[3px]">
          {(['quick', 'advanced'] as const).map(value => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => onModeChange(value)}
              className={`min-h-[30px] flex-1 rounded-[7px] px-2 py-1 text-[12px] font-extrabold ${
                mode === value
                  ? 'bg-white text-[#0a6e66] shadow-[0_1px_5px_#163e3424]'
                  : 'text-[#3b5553] hover:bg-white/60'
              }`}
            >
              {value === 'quick' ? 'Quick' : 'Advanced'}
            </button>
          ))}
        </div>
      </div>

      <div className="col-start-3 row-start-1 w-[96px] md:order-4 md:w-[108px] md:shrink-0">
        <span className="block pb-1 text-[10px] font-bold uppercase tracking-[0.8px] text-[#526765]">Your role</span>
        <div
          className="flex min-h-[36px] items-center rounded-[9px] border border-[#d6e0e8] bg-white px-2 py-1.5 text-[12px] font-semibold text-[#314d52]"
          title="Roles and permissions are managed by the clinic owner"
        >
          {roleLabel(currentClinicRole)}
        </div>
      </div>

      <label
        htmlFor="workspace-search"
        className="col-span-2 col-start-1 row-start-2 block min-w-0 text-[11px] leading-tight text-[#4d6264] md:order-1 md:col-auto md:row-auto md:min-w-[220px] md:max-w-[470px] md:flex-1"
      >
        Search records
        <input
          id="workspace-search"
          type="search"
          value={searchQuery}
          maxLength={100}
          onChange={event => setSearchQuery(event.target.value)}
          placeholder="Search a patient, appointment or item…"
          className="mt-1 min-h-[38px] w-full rounded-[9px] border border-[#dae3eb] bg-[#f7f9fb] px-3 py-1.5 text-[13px] text-ink placeholder:text-[#7b8b97]"
        />
      </label>

      <button
        type="button"
        onClick={onRecordVisit}
        disabled={!canEdit}
        title={canEdit ? 'Record a visit for a patient' : 'An online owner or editor session is required to record a visit.'}
        className="vc-btn vc-btn-primary col-start-3 row-start-2 md:order-2 md:col-auto md:row-auto"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Record visit
      </button>
    </div>
  </header>
);
