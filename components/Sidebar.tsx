"use client";

import { LayoutDashboard, PawPrint, Package, TestTube, Settings, Activity, User, Lock, Users, Building2, UserCog, Briefcase } from 'lucide-react';
import type { ClinicRole } from '@/types';

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

  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'patients', label: 'Admission & Medical', icon: PawPrint },
    { id: 'inventory', label: 'Inventory Control', icon: Package },
    ...(aiEnabled ? [{ id: 'laboratory', label: 'Laboratory & AI', icon: TestTube }] : []),
    { id: 'settings', label: 'Clinic Setup', icon: Settings },
    { id: 'account', label: 'Account Settings', icon: UserCog },
    { id: 'staff', label: 'Staff & Payroll', icon: Briefcase },
    ...(currentClinicRole === 'owner' ? [{ id: 'team', label: 'Team & Invitations', icon: Users }] : []),
  ];

  return (
    <div className={`fixed inset-y-0 left-0 z-50 w-64 bg-slate-900 text-slate-300 transition-transform duration-300 ease-in-out transform ${isOpen ? 'translate-x-0' : '-translate-x-full'} md:relative md:translate-x-0 flex flex-col`}>
      <div className="flex items-center justify-center h-20 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Activity className="w-8 h-8 text-teal-400" />
          <span className="text-xl font-bold text-white tracking-wide">VetCloud<span className="text-teal-400">Pro</span></span>
        </div>
      </div>

      {!isDemo && currentClinicName && (
        <div className="px-4 pt-4">
          <button
            type="button"
            onClick={onSwitchClinic}
            className="w-full rounded-xl border border-slate-700 bg-slate-800/70 px-3 py-3 text-left hover:bg-slate-800"
          >
            <span className="flex items-center gap-2 text-[10px] uppercase tracking-wider font-black text-slate-500">
              <Building2 className="w-3.5 h-3.5" /> Current clinic · switch
            </span>
            <span className="block mt-1 truncate text-sm font-bold text-white">{currentClinicName}</span>
          </button>
        </div>
      )}
      
      <div className="flex-1 overflow-y-auto py-6 px-4">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4 px-2">Core Clinical Hub</p>
        <ul className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <li key={item.id}>
                <button
                  onClick={() => { setActiveTab(item.id); setIsOpen(false); }}
                  className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all ${isActive ? 'bg-teal-500/10 text-teal-400 font-medium' : 'hover:bg-slate-800 hover:text-white'}`}
                >
                <Icon className={`w-5 h-5 ${isActive ? 'text-teal-400' : 'text-slate-400'}`} />
                {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="p-4 border-t border-slate-800">
  <button
    type="button"
    onClick={() => { setActiveTab('account'); setIsOpen(false); }}
    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl hover:bg-slate-800 transition-all text-left"
  >
    <div className="w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center overflow-hidden">
      <User className="w-6 h-6 text-slate-400" />
    </div>

    <div className="flex flex-col text-left min-w-0">
      <span className="text-sm font-medium text-white truncate">
        {currentUser?.split(' (')[0] || 'Clinic Account'}
      </span>
      <span className="text-xs text-slate-500 truncate">
        {currentEmail || 'Active Session'}
      </span>
    </div>
  </button>

  <button
    type="button"
    onClick={onLogout}
    className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:text-red-200 border border-red-500/20 transition-all text-xs font-bold"
  >
    <Lock className="w-4 h-4" />
    Logout
  </button>
</div>
    </div>
  );
};
