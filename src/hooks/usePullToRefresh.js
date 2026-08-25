import { useEffect, useRef, useState } from "react";

export function usePullToRefresh(refetch) {
  const [pullDist, setPullDist] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef(0);
  const currentPull = useRef(0);
  const active = useRef(false);
  const threshold = 70;

  useEffect(() => {
    const onTouchStart = (e) => {
      if (window.scrollY <= 0 && !refreshing) {
        if (e.touches && e.touches[0]) {
          active.current = true;
          startY.current = e.touches[0].clientY;
        }
      }
    };

    const onTouchMove = (e) => {
      if (!active.current) return;
      if (e.touches && e.touches[0]) {
        const diff = e.touches[0].clientY - startY.current;
        if (diff > 0) {
          currentPull.current = Math.min(diff * 0.5, threshold);
          setPullDist(currentPull.current);
        }
      }
    };

    const onTouchEnd = async () => {
      if (!active.current) return;
      active.current = false;
      if (currentPull.current >= threshold && !refreshing) {
        setRefreshing(true);
        setPullDist(threshold);
        try {
          await refetch();
        } catch {
          // Silent by design, given what the three callers actually pass.
          // Dashboard and OtaChannels pass a Promise.all of react-query refetch
          // functions; Payments passes one directly. react-query's refetch
          // RESOLVES with a result object when the query fails rather than
          // rejecting (throwOnError is off), so a failed reload arrives here as
          // an ordinary return and this branch is close to unreachable. The
          // pages surface the failure from the query's own isError state —
          // Payments destructures `isError, error` for exactly that — so there
          // is nothing to report here that the screen is not already saying.
          //
          // What must not happen is a spinner that never stops, and that is why
          // setRefreshing(false) below sits OUTSIDE this catch: the pull resets
          // even if the promise rejects. If a future caller passes a plain async
          // function that can reject, the honest answer changes — surface the
          // error to that caller instead of widening this swallow.
        }
        setRefreshing(false);
      }
      currentPull.current = 0;
      setPullDist(0);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [refetch, refreshing]);  

  return { pullDist, refreshing };
}