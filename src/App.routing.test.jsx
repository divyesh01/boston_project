import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const authState = vi.hoisted(() => ({
  isAuthenticated: true,
  isLoadingAuth: false,
  authChecked: true,
  canAccessRoute: () => true,
  user: { id: "owner-1", username: "owner", role: "owner" },
  navigateToLogin: vi.fn(),
}));
const queryClientStub = vi.hoisted(() => ({ invalidateQueries: vi.fn() }));
const hydrationMock = vi.hoisted(() => ({ run: vi.fn(async () => ({})) }));

vi.mock("@/lib/AuthContext", () => ({
  AuthProvider: ({ children }) => children,
  useAuth: () => authState,
}));
vi.mock("@/crdt", () => ({ YDocProvider: ({ children }) => children }));
vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }) => children,
  useQueryClient: () => queryClientStub,
}));
vi.mock("@/api/base44Client", () => ({ businessData: { hydrateFromServer: vi.fn() } }));
vi.mock("@/lib/dailyAggregates", () => ({ rebuildDailyAggregates: vi.fn() }));
vi.mock("@/lib/bulkHydrationService", () => ({ syncBulkBundles: vi.fn() }));
vi.mock("@/lib/startupHydration", () => ({ hydrateAuthenticatedData: () => hydrationMock.run() }));
vi.mock("@/lib/query-client", () => ({ queryClientInstance: {} }));
vi.mock("@/components/Layout", async () => {
  const { Outlet } = await import("react-router-dom");
  return { default: () => <Outlet /> };
});
vi.mock("@/components/ScrollToTop", () => ({ default: () => null }));
vi.mock("@/lib/sound", () => ({ attachClickSounds: vi.fn() }));
vi.mock("@/lib/auditLogger", () => ({ logAuditEvent: vi.fn() }));
vi.mock("@/lib/permissions", () => ({ isRouteMapped: () => true }));
vi.mock("@/components/ui/toaster", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ Toaster: () => null }));
vi.mock("@/pages/Dashboard", () => ({
  default: () => <div>Executive Dashboard</div>,
}));
vi.mock("./lib/PageNotFound", () => ({
  default: () => <div>Application 404</div>,
}));

import App from "./App";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  authState.isAuthenticated = true;
  authState.isLoadingAuth = false;
  authState.authChecked = true;
  authState.navigateToLogin.mockClear();
  hydrationMock.run.mockReset().mockResolvedValue({});
});

describe("production route compatibility", () => {
  it("opens the Dashboard when an authenticated browser loads /dashboard directly", async () => {
    window.history.replaceState({}, "", "/dashboard");
    render(<App />);

    expect(await screen.findByText("Executive Dashboard")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(screen.queryByText("Application 404")).not.toBeInTheDocument();
  });

  it("keeps authenticated pages hidden until authoritative hydration completes", async () => {
    let finishHydration;
    hydrationMock.run.mockImplementation(() => new Promise((resolve) => { finishHydration = resolve; }));
    render(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent("Preparing your hotel data");
    expect(screen.queryByText("Executive Dashboard")).not.toBeInTheDocument();
    await act(async () => { finishHydration({}); });
    expect(await screen.findByText("Executive Dashboard")).toBeInTheDocument();
  });

  it("keeps pages hidden after hydration fails and retries on request", async () => {
    hydrationMock.run.mockRejectedValueOnce(new Error("temporary bundle failure")).mockResolvedValueOnce({});
    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not refresh hotel data");
    expect(screen.queryByText("Executive Dashboard")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry data refresh" }));
    expect(await screen.findByText("Executive Dashboard")).toBeInTheDocument();
    expect(hydrationMock.run).toHaveBeenCalledTimes(2);
  });

  it("sends a fresh unauthenticated /dashboard visit through the normal login flow", async () => {
    authState.isAuthenticated = false;
    window.history.replaceState({}, "", "/dashboard");
    render(<App />);

    await waitFor(() => expect(authState.navigateToLogin).toHaveBeenCalledWith("/"));
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByText("Application 404")).not.toBeInTheDocument();
  });

  it("keeps a genuine unknown route on the application 404", async () => {
    window.history.replaceState({}, "", "/genuine-missing-page");
    render(<App />);

    expect(await screen.findByText("Application 404")).toBeInTheDocument();
  });
});
