"use client";

import type { ComponentType } from 'react';
import {
  Activity, Briefcase, Building2, CalendarDays, ChevronDown, LayoutDashboard,
  LogOut, Package, PawPrint, Settings, TestTube, UserCog, Users
} from 'lucide-react';
import type { ClinicRole } from '@/types';

type NavItem = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
};

export const Sidebar = ({
  activeTab,
  setActiveTab,
  isOpen,
  setIsOpen,
  currentUser,
  currentClinicName,
  currentClinicRole,
  isDemo,
  aiEnabled,
  onSwitchClinic,
  onLogout
}: {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  currentUser: string | null;
  currentClinicName: string;
  currentClinicRole: ClinicRole | null;
  isDemo: boolean;
  aiEnabled: boolean;
  onSwitchClinic: () => void;
  onLogout: () => void;
}) => {
  const currentEmail = currentUser?.match(/\((.*?)\)/)?.[1] || '';
  const displayName = currentUser?.split(' (')[0] || 'Clinic Account';
  const initial = (displayName.trim()[0] || 'V').toUpperCase();

  const everydayItems: NavItem[] = [
    { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
    { id: 'patients', label: 'Patients', icon: PawPrint },
    { id: 'appointments', label: 'Appointments', icon: CalendarDays },
    { id: 'inventory', label: 'Inventory', icon: Package },
  ];

  const clinicItems: NavItem[] = [
    ...(aiEnabled ? [{ id: 'laboratory', label: 'Laboratory & AI', icon: TestTube }] : []),
    { id: 'staff', label: 'Staff & Payroll', icon: Briefcase },
  ];

  const adminItems: NavItem[] = [
    { id: 'settings', label: 'Clinic setup', icon: Settings },
    { id: 'account', label: 'My account', icon: UserCog },
    ...(currentClinicRole === 'owner' ? [{ id: 'team', label: 'Team & invitations', icon: Users }] : []),
    ...(currentClinicRole ? [{ id: 'audit', label: 'Clinical audit', icon: Activity }] : []),
  ];

  const go = (tab: string) => {
    setActiveTab(tab);
    setIsOpen(false);
  };

  const renderItem = (item: NavItem) => {
    const Icon = item.icon;
    const active = activeTab === item.id;
    return (
      <button
        key={item.id}
        type="button"
        onClick={() => go(item.id)}
        aria-current={active ? 'page' : undefined}
        className={`flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2.5 text-left text-[13px] font-semibold transition-colors ${
          active
            ? 'bg-[#144f4c] text-[#c9fff0]'
            : 'text-[#d5dee9] hover:bg-nav-hover hover:text-white'
        }`}
      >
        <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-[#9ef2d8]' : 'text-[#8fa4b8]'}`} aria-hidden="true" />
        <span className="flex-1">{item.label}</span>
      </button>
    );
  };

  return (
    <aside
      aria-label="Main navigation"
      className={`fixed inset-y-0 left-0 z-50 flex w-[246px] shrink-0 flex-col overflow-hidden bg-nav px-3 py-4 text-slate-200 transition-transform duration-200 md:relative md:translate-x-0 ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex items-center gap-2 px-2 pb-5 text-[21px] font-extrabold tracking-[-0.9px] text-white">
        <span
          aria-hidden="true"
          className="grid h-[35px] w-[35px] place-items-center rounded-[10px] bg-[#194e4e] text-[19px] leading-none text-[#b6f4dd]"
        >
          ✚
        </span>
        <span>VetCloud<span className="text-[#91dfc8]">Pro</span></span>
      </div>

      {currentClinicName && (
        isDemo ? (
          <div className="mb-4 w-full rounded-[11px] border border-[#304158] bg-[#1b2c43] px-3 py-2.5">
            <span className="block text-[11px] text-[#b3c7d2]">Current clinic · preview only</span>
            <strong className="mt-0.5 block truncate text-[13px] text-white">{currentClinicName}</strong>
          </div>
        ) : (
          <button
            type="button"
            onClick={onSwitchClinic}
            title="Switch clinic"
            className="mb-4 flex w-full items-center gap-2 rounded-[11px] border border-[#304158] bg-[#1b2c43] px-3 py-2.5 text-left hover:bg-[#22374f]"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[11px] text-[#b3c7d2]">
                <Building2 className="h-3 w-3" aria-hidden="true" /> Current clinic · switch
              </span>
              <strong className="mt-0.5 block truncate text-[13px] text-white">{currentClinicName}</strong>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-[#b3c7d2]" aria-hidden="true" />
          </button>
        )
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-bold uppercase tracking-[1.3px] text-[#92a5bd]">
          Everyday work
        </p>
        <nav aria-label="Everyday work" className="grid gap-[3px]">
          {everydayItems.map(renderItem)}
        </nav>

        <div className="mx-2 my-3 border-t border-[#2b3b51]" />
        <p className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-[1.3px] text-[#92a5bd]">
          Clinic operations
        </p>
        <nav aria-label="Clinic operations" className="grid gap-[3px]">
          {clinicItems.map(renderItem)}
        </nav>
        <div className="mx-2 my-3 border-t border-[#2b3b51]" />
        <p className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-[1.3px] text-[#92a5bd]">
          Administration
        </p>
        <nav aria-label="Administration" className="grid gap-[3px]">
          {adminItems.map(renderItem)}
        </nav>
      </div>

      <div className="mt-4 shrink-0 border-t border-[#2b3b51] bg-nav px-2 pt-4">
        <div className="flex items-center gap-2.5 px-1">
          <span
            aria-hidden="true"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#20524f] text-[13px] font-bold text-[#bdffe8]"
          >
            {initial}
          </span>
          <div className="min-w-0">
            <strong className="block truncate text-[12.5px] font-semibold text-white">{displayName}</strong>
            <p className="truncate text-[11px] text-[#aec2c3]">{currentEmail || (isDemo ? 'Fictional demo account' : 'Active session')}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-[9px] border border-[#3b4d63] bg-transparent px-2 py-2 text-[12px] font-semibold text-[#d6edeb] hover:bg-[#32515b]"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Logout
        </button>
      </div>
    </aside>
  );
};
