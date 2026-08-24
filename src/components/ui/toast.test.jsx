/**
 * @fileoverview Behaviour tests for the toast system (tracker #52).
 *
 * WHY THIS FILE EXISTS IN THE VITEST TIER AND NOT AS A PROBE
 * ----------------------------------------------------------
 * Every defect this pins is a *runtime* one: a click handler that was never
 * attached, a timer that was never armed, an attribute that was never read. None
 * of it is visible by reading source, and none of it can be reached from the
 * `scripts/probe-*.mjs` tier, because Node cannot import a `.jsx` file --
 * `scripts/resolve-alias.mjs` rewrites specifiers but installs no `load` hook, so
 * every existing probe reads `.jsx` as text. Proving that clicking the X removes
 * a toast needs a renderer, which means jsdom, which means here, alongside the 18
 * other `src/components/ui/*.test.jsx` files.
 *
 * The companion `scripts/probe-toast-lifecycle.mjs` covers what *is* checkable
 * from source: the literal constants and the wiring between the three files.
 *
 * WHY THE TIMINGS ARE HARD-CODED HERE
 * -----------------------------------
 * 3 / 200 / 5000 / 10000 are duplicated from use-toast.jsx rather than imported.
 * Exporting them purely for a test would put a test-shaped hole in a production
 * module, and an imported constant cannot fail: a test that reads
 * `TOAST_REMOVE_DELAY` from the source and then advances by exactly that much
 * passes whatever the value is, including a regression back to 1_000_000. These
 * numbers are pinned to their source literals by the probe instead, so changing
 * one file without the other fails the gate.
 *
 * WHAT WAS BROKEN, IN THE ORDER THE TESTS BELOW CHECK IT
 * -----------------------------------------------------
 *   1. `<ToastClose />` was rendered with no `onClick` at all, so the X was a
 *      decoration -- clicking it did nothing.
 *   2. Nothing in the app ever dispatched DISMISS_TOAST, so no toast this site
 *      has ever shown left the screen without a page reload.
 *   3. `TOAST_LIMIT` was 20 with nothing removing toasts, so it was a permanent
 *      ceiling rather than a burst allowance.
 *   4. `open` was spread onto a plain <div> as a literal DOM attribute and
 *      `onOpenChange` produced "Unknown event handler property" on every toast.
 *   5. `ToastProvider` and `ToastViewport` were byte-identical fixed containers,
 *      leaving one empty 32px z-100 strip that swallowed clicks on every page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { Toaster } from "./toaster";
import { ToastProvider } from "./toast";
import { useToast, toast } from "./use-toast";

// Mirrors of use-toast.jsx. See the note above on why these are copied.
const TOAST_LIMIT = 3;
const REMOVE_DELAY = 200;
const DEFAULT_MS = 5000;
const DESTRUCTIVE_MS = 10000;

/**
 * The toast store is a module-level singleton -- one queue for the whole app,
 * which is the correct design for something rendered once in the layout. That
 * means state survives between tests in this file, so every test drains it.
 */
let api = null;

function Capture() {
  api = useToast();
  return null;
}

/** Renders the real Toaster plus a hook probe, exactly as the app mounts it. */
function renderToaster() {
  return render(
    <>
      <Capture />
      <Toaster />
    </>
  );
}

/** Pushes a toast through the real public API, inside act(). */
function show(props) {
  let handle;
  act(() => {
    handle = toast(props);
  });
  return handle;
}

function advance(ms) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function closeButton() {
  return screen.getByRole("button", { name: /close notification/i });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain through the public API, then let the removal timers run, so the store
  // is empty for the next test. `api.dismiss` is a plain dispatch closure and
  // works whether or not the component is still mounted.
  if (api) {
    act(() => {
      api.dismiss();
    });
    advance(REMOVE_DELAY + 1);
  }
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("Toaster rendering", () => {
  it("renders a toast's title and description", () => {
    renderToaster();
    show({ title: "User created", description: "divyesh can now sign in." });

    expect(screen.getByText("User created")).toBeInTheDocument();
    expect(screen.getByText("divyesh can now sign in.")).toBeInTheDocument();
  });

  it("marks a live toast data-state=open so its animation classes apply", () => {
    renderToaster();
    show({ title: "User created" });

    // Nothing in the app carried a data-state attribute before this. Every
    // animate-in / animate-out / fade-out-80 / slide-out-to-right-full rule in
    // toastVariants keys off it, so all of them were dead.
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "open");
  });

  it("announces a confirmation politely and a failure assertively", () => {
    renderToaster();
    show({ title: "User created" });
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");

    show({ title: "Could not save", variant: "destructive" });
    expect(screen.getByRole("alert")).toHaveAttribute("aria-live", "assertive");
  });
});

describe("Toast dismissal by click", () => {
  it("removes the toast when the close button is clicked", () => {
    renderToaster();
    show({ title: "User created" });
    expect(screen.getByText("User created")).toBeInTheDocument();

    fireEvent.click(closeButton());

    // Starts closing immediately...
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "closed");
    // ...and unmounts once the 150ms exit animation has had time to play.
    advance(REMOVE_DELAY);
    expect(screen.queryByText("User created")).toBeNull();
  });

  it("gives the close button type=button so it cannot submit a host form", () => {
    renderToaster();
    show({ title: "User created" });

    // A toast renders over the Add User dialog, which is a form. A <button> with
    // no type attribute defaults to type=submit, so dismissing a validation
    // toast would have submitted the form it was complaining about.
    expect(closeButton()).toHaveAttribute("type", "button");
  });

  it("leaves no timer behind when a toast is closed early", () => {
    renderToaster();
    const base = vi.getTimerCount();

    show({ title: "User created" });
    expect(vi.getTimerCount()).toBe(base + 1); // auto-dismiss armed

    fireEvent.click(closeButton());
    // Still one: the pending auto-dismiss was cleared and a removal armed in its
    // place. Two would mean the auto-dismiss is still queued against an id that
    // is about to stop existing.
    expect(vi.getTimerCount()).toBe(base + 1);

    advance(REMOVE_DELAY);
    expect(vi.getTimerCount()).toBe(base);
  });
});

describe("Toast expiry", () => {
  it("expires a confirmation on its own", () => {
    renderToaster();
    show({ title: "User created" });

    advance(DEFAULT_MS - 1);
    expect(screen.queryByText("User created")).not.toBeNull();

    advance(1);
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "closed");

    advance(REMOVE_DELAY);
    expect(screen.queryByText("User created")).toBeNull();
  });

  it("keeps a failure up twice as long as a confirmation", () => {
    renderToaster();
    show({ title: "Could not save", variant: "destructive" });

    advance(DEFAULT_MS + REMOVE_DELAY);
    expect(screen.queryByText("Could not save")).not.toBeNull();

    advance(DESTRUCTIVE_MS - DEFAULT_MS - REMOVE_DELAY);
    expect(screen.getByRole("alert")).toHaveAttribute("data-state", "closed");

    advance(REMOVE_DELAY);
    expect(screen.queryByText("Could not save")).toBeNull();
  });

  it("honours an explicit duration and never leaks it to the DOM", () => {
    renderToaster();
    show({ title: "Read me", duration: 1500 });

    // `duration` is destructured out inside toast(), so it never reaches the
    // rendered object and cannot be spread onto the div as an attribute.
    expect(screen.getByRole("status")).not.toHaveAttribute("duration");

    advance(1499);
    expect(screen.queryByText("Read me")).not.toBeNull();
    advance(1 + REMOVE_DELAY);
    expect(screen.queryByText("Read me")).toBeNull();
  });

  it("lets a caller opt out of expiry with a non-finite duration", () => {
    renderToaster();
    show({ title: "Act on me", duration: Infinity });

    advance(60_000);
    expect(screen.queryByText("Act on me")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("data-state", "open");
  });
});

describe("Toast queue limit", () => {
  it("keeps the newest TOAST_LIMIT toasts and drops the oldest", () => {
    renderToaster();
    ["first", "second", "third", "fourth"].forEach((title) => show({ title }));

    expect(screen.getAllByRole("status")).toHaveLength(TOAST_LIMIT);
    expect(screen.queryByText("first")).toBeNull();
    ["second", "third", "fourth"].forEach((title) => {
      expect(screen.queryByText(title)).not.toBeNull();
    });
  });

  it("clears the timers of a toast the limit pushed off screen", () => {
    renderToaster();
    const base = vi.getTimerCount();

    ["first", "second", "third"].forEach((title) => show({ title }));
    expect(vi.getTimerCount()).toBe(base + TOAST_LIMIT);

    show({ title: "fourth" });

    // The invariant ADD_TOAST documents: a timer exists only for a toast that is
    // still on screen. Four toasts have been created and three are rendered, so
    // there must be three timers. A fourth would fire DISMISS_TOAST against a
    // toast nobody can see, arming a removal for nothing.
    expect(vi.getTimerCount()).toBe(base + TOAST_LIMIT);
  });
});

describe("Toast DOM hygiene", () => {
  it("puts neither open nor onOpenChange on the DOM node", () => {
    renderToaster();
    show({ title: "User created" });
    const el = screen.getByRole("status");

    expect(el).not.toHaveAttribute("open");
    expect(el).not.toHaveAttribute("onopenchange");
  });

  it("logs no React warning when a toast is shown", () => {
    const errors = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });

    renderToaster();
    show({ title: "User created", variant: "destructive" });
    fireEvent.click(closeButton());
    advance(REMOVE_DELAY);

    spy.mockRestore();
    // React reports a handler it cannot attach to a plain div as
    // "Unknown event handler property: `onOpenChange`". That fired for every
    // toast the app showed.
    expect(errors).toEqual([]);
  });

  it("renders exactly one fixed positioning container", () => {
    renderToaster();

    // ToastProvider and ToastViewport used to carry byte-identical class strings,
    // with the toasts inside the provider and the viewport left empty. An empty
    // `fixed ... p-4` div is still 32px tall and still accepts pointer events, so
    // every page carried an invisible z-100 strip that ate clicks.
    expect(document.querySelectorAll('div[class*="z-[100]"]')).toHaveLength(1);
  });

  it("makes the viewport transparent to clicks and each toast opaque to them", () => {
    renderToaster();
    const viewport = screen.getByRole("region", { name: "Notifications" });
    expect(viewport).toHaveClass("pointer-events-none");

    show({ title: "User created" });
    // The pairing the original code was missing: the container ignores pointer
    // events, each toast re-enables them for its own box.
    expect(screen.getByRole("status")).toHaveClass("pointer-events-auto");
  });

  it("ToastProvider renders no element of its own", () => {
    const { container } = render(
      <ToastProvider>
        <span data-testid="child" />
      </ToastProvider>
    );
    expect(container.firstChild).toBe(screen.getByTestId("child"));
  });
});
