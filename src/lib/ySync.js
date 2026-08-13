import { useEffect, useState } from 'react';
import { useYDoc } from '@/crdt';

/**
 * Subscribes to a Yjs map and propagates changes to a remote backend.
 * @param {string} name - Yjs document name.
 * @param {(map:Object)=>Promise<void>} persist - Called when local map changes.
 */
export function useYSync(name, persist) {
  const doc = useYDoc();
  const map = doc.getMap('root');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // initial load: nothing to do; map is already in sync when provider connects.
    setLoading(false);
  }, []);

  const set = (key, value) => {
    map.set(key, value);
    // persist the whole map after each change
    persist?.(Object.fromEntries(map.entries()));
  };

  return { value: Object.fromEntries(map.entries()), set, loading };
}
