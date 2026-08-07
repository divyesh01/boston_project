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
        active.current = true;
        startY.current = e.touches[0].clientY;
      }
    };

    const onTouchMove = (e) => {
      if (!active.current) return;
      const diff = e.touches[0].clientY - startY.current;
      if (diff > 0) {
        currentPull.current = Math.min(diff * 0.5, threshold);
        setPullDist(currentPull.current);
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
        } catch {}
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
  }, [refetch, refreshing]); // eslint-disable-line react-hooks/exhaustive-deps

  return { pullDist, refreshing };
}