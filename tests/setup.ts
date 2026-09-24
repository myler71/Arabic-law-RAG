/**
 * Vitest Global Test Setup for HAKMDAR
 *
 * Polyfills native WebSocket in environments where it is missing (e.g. Node 20 on CI)
 * to ensure @supabase/realtime-js and @supabase/ssr run cleanly without warnings or errors.
 */

if (typeof globalThis.WebSocket === 'undefined') {
  class MockWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;

    readyState = 1;
    url = '';

    constructor(url?: string) {
      this.url = url || '';
    }

    send() {}
    close() {
      this.readyState = 3;
    }
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return true;
    }
  }

  (globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
}

// Suppress known upstream warnings in test output
process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true';
