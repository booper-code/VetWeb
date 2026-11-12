"use client";

import React from 'react';
import { Menu } from 'lucide-react';

export const Header = ({
  toggleSidebar,
  searchQuery,
  setSearchQuery,
  currentUser
}: {
  toggleSidebar: () => void;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  currentUser: string | null;
}) =>
<header className="bg-white border-b border-slate-200 h-20 flex items-center justify-between px-4 sm:px-8 sticky top-0 z-40">
  <div className="flex items-center gap-4">
    <button onClick={toggleSidebar} className="md:hidden p-2 text-slate-500 hover:bg-slate-100 rounded-lg">
      <Menu className="w-6 h-6" />
    </button>
    <div>
    <h1 className="text-xl font-bold text-slate-800 hidden sm:block">
      {currentUser ? currentUser.split(' (')[0] : 'VetCloudPro'}
    </h1>
      <p className="text-sm text-slate-500 hidden sm:block">Unified Practice Management Platform</p>
    </div>
  </div>
</header>
