// src/components/dashboard/SidebarNav.jsx
// Luxury tech sidebar navigation with high-contrast typography, live status badges,
// and grouped owner intelligence workflows.

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  TrendingUp,
  FileSpreadsheet,
  ShieldCheck,
  Building2,
  DollarSign,
  Users,
  Settings,
  Sliders,
  ChevronRight,
  Database,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';

export default function SidebarNav({ currentProperty = 'All Properties' }) {
  const location = useLocation();

  let canAccess = (_path) => true;
  try {
    const auth = useAuth();
    if (auth && typeof auth.canAccessRoute === 'function') {
      canAccess = auth.canAccessRoute;
    }
  } catch {
    canAccess = (_path) => true;
  }

  const navSections = [
    {
      title: 'Executive Intelligence',
      items: [
        { label: 'Executive Dashboard', path: '/dashboard', icon: LayoutDashboard },
        { label: 'OTA & Channel Economics', path: '/ota-channels', icon: Sliders },
        { label: 'Variance & Forecasts', path: '/forecasting', icon: TrendingUp },
      ],
    },
    {
      title: 'Ledgers & Operations',
      items: [
        { label: 'Transactions Ledger', path: '/transactions', icon: DollarSign },
        { label: 'Operating Expenses', path: '/expenses', icon: BarChart3 },
        { label: 'Payroll & Shifts', path: '/payroll', icon: Users },
      ],
    },
    {
      title: 'Data Governance & Audit',
      items: [
        { label: 'Import & Lineage', path: '/import', icon: Database, badge: 'D1' },
        { label: 'Data Intelligence', path: '/data-intelligence', icon: ShieldCheck, badge: '100%' },
        { label: 'Portfolio Settings', path: '/settings', icon: Settings },
      ],
    },
  ];

  const canonicalRoute = (path) => {
    if (path === '/dashboard') return '/';
    if (path === '/ota-channels') return '/ota';
    if (path === '/import') return '/upload';
    return path;
  };

  return (
    <nav className="flex flex-col space-y-6 px-3 py-4" aria-label="Sidebar Navigation">
      {/* Property Context Pill */}
      <div className="rounded-xl border border-white/5 bg-slate-900/60 p-2.5">
        <div className="text-[10px] uppercase font-mono tracking-wider text-slate-500">Active Scope</div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs font-semibold text-slate-200 truncate">{currentProperty}</span>
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
      </div>

      {/* Nav Sections */}
      {navSections.map((sec) => {
        const visibleItems = sec.items.filter((item) => canAccess(canonicalRoute(item.path)));
        if (visibleItems.length === 0) return null;
        return (
          <div key={sec.title} className="space-y-1">
            <div className="px-3 text-[10px] font-mono uppercase tracking-wider text-slate-500 font-semibold">
              {sec.title}
            </div>
            <div className="mt-1 space-y-0.5">
              {visibleItems.map((item) => {
                const Icon = item.icon;
                const targetPath = canonicalRoute(item.path);
                const isActive = location.pathname === targetPath || location.pathname === item.path;

              return (
                <Link
                  key={item.path}
                  to={targetPath}
                  className={`flex items-center justify-between rounded-xl px-3 py-2 text-xs font-medium transition-all ${
                    isActive
                      ? 'bg-gradient-to-r from-emerald-500/15 to-transparent text-emerald-400 font-semibold border-l-2 border-emerald-400'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className={`h-4 w-4 ${isActive ? 'text-emerald-400' : 'text-slate-400'}`} />
                    <span>{item.label}</span>
                  </div>

                  {item.badge && (
                    <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-[10px] font-mono text-slate-400 border border-white/5">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      );
    })}
  </nav>
);
}
