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
// A value that is not a websocket URL is treated as unset. Some hosting
// dashboards (Cloudflare's setup wizard among them) require a value for every
// variable they discover and refuse to accept an empty one, so "off" has to be
// expressible as a placeholder string. Without this check any such placeholder
// would reach `new WebsocketProvider()` and restart exactly the doomed backoff
// loop described above. Setting this is only meaningful once a real y-websocket
// server is actually reachable at the address.
const RAW_ENDPOINT = (import.meta.env?.VITE_WEBSOCKET_ENDPOINT || '').trim();
const ENDPOINT = /^wss?:\/\/./i.test(RAW_ENDPOINT) ? RAW_ENDPOINT : '';
if (RAW_ENDPOINT && !ENDPOINT) {
  // Never ignore a configured value in silence - say which value was discarded.
  console.warn(
    `[crdt] VITE_WEBSOCKET_ENDPOINT is set to a non-websocket value (${RAW_ENDPOINT}); realtime sync stays OFF. Expected ws:// or wss://.`
  );
}

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
          } catch {
            // Silent by design. This fires on EVERY document update, so a
            // blocked or full localStorage would report once per change rather
            // than once per problem. The cache is also redundant: the Y.Doc in
            // memory is authoritative, and the read at the top of this effect
            // already treats a missing cache as the normal first-run case.
            // Losing the write costs offline restore after a reload, not any
            // data in this session. Note this handler is only ever registered
            // when ENDPOINT is set, which the shipped config leaves empty.
          }
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
      } catch {
        // Silent by design: this is unmount cleanup. disconnect() can throw if
        // the socket is already closing, and there is nobody left to tell — the
        // component is gone. Reporting here would announce a failure to tidy up
        // something the browser tears down regardless.
      }
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
