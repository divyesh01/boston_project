import { useEffect, useRef, useState } from "react";

export function usePullToRefresh(refetch) {
  const [pullDist, setPullDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const refreshingRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let active = false;
    let startY = 0;
    let distance = 0;
    const threshold = 70;
    const cancel = () => {
      active = false;
      distance = 0;
      if (!refreshingRef.current) setPullDist(0);
    };
    const onTouchStart = (event) => {
      cancel();
      if (window.scrollY > 0 || refreshingRef.current || event.touches.length !== 1) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest('input, textarea, select, button, a, [role="dialog"], [contenteditable="true"]')) return;
      // Nested scrolling belongs to that surface, not the page refresh gesture.
      for (let node = target; node && node !== document.body; node = node.parentElement) {
        if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(window.getComputedStyle(node).overflowY)) return;
      }
      active = true;
      startY = event.touches[0].clientY;
    };
    const onTouchMove = (event) => {
      if (!active) return;
      if (event.touches.length !== 1 || window.scrollY > 0) { cancel(); return; }
      distance = Math.max(0, Math.min((event.touches[0].clientY - startY) * 0.5, threshold));
      setPullDist(distance);
    };
    const onTouchEnd = async () => {
      if (!active) return;
      active = false;
      const shouldRefresh = distance >= threshold && !refreshingRef.current;
      distance = 0;
      if (!shouldRefresh) { setPullDist(0); return; }
      refreshingRef.current = true;
      setRefreshing(true);
      setPullDist(threshold);
      try {
        await refetchRef.current();
      } catch {
        // Query errors are displayed by the calling page.
      } finally {
        refreshingRef.current = false;
        if (mounted) { setRefreshing(false); setPullDist(0); }
      }
    };
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });
    window.addEventListener("touchcancel", cancel, { passive: true });
    return () => {
      mounted = false;
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", cancel);
    };
  }, []);
  return { pullDist, refreshing };
}
