import "@testing-library/jest-dom/vitest";

// jsdom does not implement ResizeObserver, which Radix UI primitives (e.g. the
// Checkbox used on the Login page) rely on. Provide a no-op stub.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver || ResizeObserverStub;

