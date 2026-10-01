import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

class CommandMenuBoundary extends React.Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div role="alert" className="fixed bottom-4 right-4 z-50 rounded-lg bg-slate-900 p-4 text-white shadow-xl">
          <p>Command menu could not load. Close it and press Ctrl/Cmd+K to retry.</p>
          <button type="button" onClick={this.props.onClose} className="mt-2 underline">Close</button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Keep only the shortcut listener on the startup path. cmdk, its dialog, and
// property options are downloaded when the user first opens the menu.
export default function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const previousFocus = useRef(null);
  // A fresh lazy instance on each opening also permits retry after a failed load.
  const Dialog = useMemo(() => lazy(() => import('./CommandMenuDialog')), [attempt]);

  useEffect(() => {
    if (!open && previousFocus.current) {
      const element = previousFocus.current;
      previousFocus.current = null;
      if (element.isConnected) element.focus();
    }
  }, [open]);

  useEffect(() => {
    const down = (e) => {
      if (open && e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'k' || !(e.metaKey || e.ctrlKey)) return;
      if (!open && (
        (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'radio') ||
        e.target.tagName === 'TEXTAREA' || e.target.isContentEditable
      )) return;

      e.preventDefault();
      if (!open) {
        previousFocus.current = document.activeElement;
        setAttempt((value) => value + 1);
      }
      setOpen((value) => !value);
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [open]);

  if (!open) return null;

  return (
    <CommandMenuBoundary key={attempt} onClose={() => setOpen(false)}>
      <Suspense fallback={
        <div role="status" className="fixed bottom-4 right-4 z-50 rounded-lg bg-slate-900 p-4 text-white shadow-xl">
          Loading command menu…
          <button type="button" onClick={() => setOpen(false)} className="ml-3 underline">Cancel</button>
        </div>
      }>
        <Dialog open={open} onOpenChange={setOpen} />
      </Suspense>
    </CommandMenuBoundary>
  );
}
