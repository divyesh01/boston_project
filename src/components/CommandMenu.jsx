import React, { useEffect, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import { Search, Building2 } from 'lucide-react';
import { NAV } from '@/lib/navigation';
import { useAuth } from '@/lib/AuthContext';
import { useGlobalFilters } from '@/lib/useGlobalFilters';

export default function CommandMenu() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { canAccessRoute } = useAuth();
  const { accessibleProperties, setPropertyMulti } = useGlobalFilters();

  // Toggle the menu when ⌘K is pressed
  useEffect(() => {
    const down = (e) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        // Only guard against stealing focus if the menu is NOT open
        if (!open) {
          if (
            (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') ||
            e.target.tagName === 'TEXTAREA' || 
            e.target.isContentEditable
          ) {
            return;
          }
        }
        e.preventDefault();
        setOpen((o) => !o);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open]);

  const visibleNav = NAV.filter((n) => canAccessRoute(n.to));

  return (
    <Command.Dialog 
      open={open} 
      onOpenChange={setOpen} 
      label="Global Command Menu"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] sm:pt-[20vh]"
    >
      {/* Backdrop */}
      <div 
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity" 
        onClick={() => setOpen(false)}
      />
      
      {/* Dialog content */}
      <div className="relative z-50 w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 bg-[#0F1F35] text-slate-200 shadow-2xl animate-in fade-in zoom-in-95">
        <div className="flex items-center border-b border-white/10 px-4">
          <Search className="h-5 w-5 text-slate-400" />
          <Command.Input 
            placeholder="Type a command, page, or property..." 
            className="flex h-14 w-full rounded-md bg-transparent py-3 pl-3 pr-4 outline-none placeholder:text-slate-500 text-slate-100"
          />
        </div>
        
        <Command.List className="max-h-[400px] overflow-y-auto overflow-x-hidden p-2">
          <Command.Empty className="py-6 text-center text-sm text-slate-400">
            No results found.
          </Command.Empty>

          <Command.Group heading="Pages" className="text-xs font-medium text-slate-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
            {visibleNav.map((navItem) => (
              <Command.Item
                key={navItem.to}
                onSelect={() => {
                  navigate(navItem.to);
                  setOpen(false);
                }}
                className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2.5 text-sm text-slate-200 transition-colors aria-selected:bg-[#6C63FF]/20 aria-selected:text-white"
              >
                <navItem.icon className="h-4 w-4" />
                {navItem.label}
              </Command.Item>
            ))}
          </Command.Group>

          {accessibleProperties && accessibleProperties.length > 0 && (
            <Command.Group heading="Properties" className="mt-2 text-xs font-medium text-slate-400 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 border-t border-white/5 pt-2">
              <Command.Item
                onSelect={() => {
                  setPropertyMulti([]);
                  setOpen(false);
                }}
                className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2.5 text-sm text-slate-200 transition-colors aria-selected:bg-[#6C63FF]/20 aria-selected:text-white"
              >
                <Building2 className="h-4 w-4" />
                All Properties (Portfolio)
              </Command.Item>
              {accessibleProperties.map((prop) => (
                <Command.Item
                  key={prop.id}
                  onSelect={() => {
                    setPropertyMulti([prop.id]);
                    setOpen(false);
                  }}
                  className="flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-2.5 text-sm text-slate-200 transition-colors aria-selected:bg-[#6C63FF]/20 aria-selected:text-white"
                >
                  <Building2 className="h-4 w-4" />
                  {prop.name} {prop.code ? `(${prop.code})` : ''}
                </Command.Item>
              ))}
            </Command.Group>
          )}
        </Command.List>
      </div>
    </Command.Dialog>
  );
}
