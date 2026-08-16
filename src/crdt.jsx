import * as Y from 'yjs';
import { createContext, useContext, useEffect, useRef } from 'react';

// The websocket endpoint has to be configured to be used. It was previously
// read from `process.env.REACT_APP_WEBSOCKET_ENDPOINT` — a Create React App
// variable name that Vite does not substitute, on a `process` object that does
// not exist in the browser — so the guarded expression always fell through to
// the `ws://localhost:1234` default. In a deployed build that means every page
// load opens a plaintext ws:// socket to the *viewer's own machine*, which is
// blocked twice over (mixed content on an https page, and connect-src in the
// CSP) and then retried on a backoff loop for as long as the tab is open.
// y-websocket reports that failure asynchronously, so the try/catch below never
// saw it and nothing surfaced except console noise and a warm battery.
//
// Unset means single-device: the Y.Doc and its localStorage cache below work
// unchanged, which is exactly what this app has actually been doing in
// production all along.
const ENDPOINT = import.meta.env?.VITE_WEBSOCKET_ENDPOINT || '';

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

    // Connect only when an endpoint is configured. Skipping is not a
    // degradation: the doc above is already live and already persists.
    let provider = null;
    let disconnected = false;
    const tryConnect = async () => {
      if (!ENDPOINT) return;
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
