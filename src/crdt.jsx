import * as Y from 'yjs';
import { createContext, useContext, useEffect, useRef } from 'react';

const ENDPOINT = (typeof process !== 'undefined' && process.env?.REACT_APP_WEBSOCKET_ENDPOINT) || 'ws://localhost:1234';

export const YDocContext = createContext(null);

export function YDocProvider({ name, children }) {
  const docRef = useRef(new Y.Doc());

  useEffect(() => {
    // Load from localStorage for offline support
    try {
      const cached = localStorage.getItem(`__yjs_${name}`);
      if (cached) {
        const { root } = JSON.parse(cached);
        const map = docRef.current.getMap('root');
        for (const [k, v] of Object.entries(root || {})) {
          map.set(k, v);
        }
      }
    } catch (e) {
      // Ignore cache read errors
    }

    // Try to connect WebSocket — gracefully skip if unreachable or unavailable
    let provider = null;
    let disconnected = false;
    const tryConnect = async () => {
      try {
        const { WebsocketProvider } = await import('y-websocket');
        if (disconnected) return; // component already unmounted
        provider = new WebsocketProvider(ENDPOINT, name, docRef.current, {
          connect: true,
          // Don't block the app on reconnects — operate offline if WS fails
          maxBackoffTime: 5000,
        });

        provider.on('update', () => {
          try {
            const map = docRef.current.getMap('root');
            localStorage.setItem(`__yjs_${name}`, JSON.stringify({ root: map.toJSON() }));
          } catch (e) {}
        });
      } catch (e) {
        // WebSocket not available — operate fully offline
      }
    };

    tryConnect();

    return () => {
      disconnected = true;
      try {
        if (provider) provider.disconnect();
      } catch (e) {}
    };
  }, [name]);

  return (
    <YDocContext.Provider value={docRef.current}>
      {children}
    </YDocContext.Provider>
  );
}

export function useYDoc() {
  const doc = useContext(YDocContext);
  if (!doc) throw new Error('useYDoc must be used within YDocProvider');
  return doc;
}
