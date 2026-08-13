import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { mockLogin } = vi.hoisted(() => ({ mockLogin: vi.fn() }));

vi.mock("@/components/AuthLayout", () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock("@/components/MFASetup", () => ({
  default: () => null,
}));
vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({ login: mockLogin, isAuthenticated: false }),
}));
vi.mock("@/api/base44Client", () => ({
  db: { users: { initialized: vi.fn().mockResolvedValue(true) } },
}));
vi.mock("@/lib/securityUtils", () => ({
  getCsrfToken: () => "csrf-token",
  validateCsrfToken: () => true,
  rotateCsrfToken: vi.fn(),
}));
vi.mock("@/lib/validator", () => ({
  isValidEmail: (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e)),
}));
vi.mock("@/lib/authReturnTo", () => ({
  safeReturnTo: () => "/dashboard",
}));

import Login from "./Login";

// jsdom does not implement navigation; give window.location a plain stub so the
// success-path `window.location.href = ...` assignment does not throw.
const originalLocation = window.location;
const locationStub = {
  href: "",
  search: "",
  pathname: "/",
  origin: "http://localhost",
};

beforeEach(() => {
  mockLogin.mockReset();
  locationStub.href = "";
  Object.defineProperty(window, "location", {
    value: locationStub,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    value: originalLocation,
    configurable: true,
    writable: true,
  });
});

describe("Login — spec A.1 / C.1 / C.3 / A.3 / B.3", () => {
  it("rejects a malformed identifier before any auth call (A.1 format gate)", async () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "bad email" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(await screen.findByText(/please enter a valid username or email/i)).toBeInTheDocument();
    expect(mockLogin).not.toHaveBeenCalled();
  });

  it("shows a generic error and clears only the password on credential failure (C.1 / A.3)", async () => {
    mockLogin.mockRejectedValue(new Error("Invalid password"));

    render(<MemoryRouter><Login /></MemoryRouter>);
    const emailInput = screen.getByLabelText(/username or email/i);
    const passwordInput = screen.getByLabelText(/^password$/i);

    fireEvent.change(emailInput, { target: { value: "User@Example.com" } });
    fireEvent.change(passwordInput, { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    // Generic message — the real server reason ("Invalid password") must NOT leak.
    expect(await screen.findByText("Invalid email or password")).toBeInTheDocument();
    // Password cleared, email retained.
    expect(passwordInput).toHaveValue("");
    expect(emailInput).toHaveValue("User@Example.com");
    // Identifier is normalized to lowercase before it is sent.
    expect(mockLogin).toHaveBeenCalledWith("user@example.com", "secret123", false);
  });

  it("shows the network message when offline (C.3)", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    mockLogin.mockRejectedValue(new Error("Network Error"));

    render(<MemoryRouter><Login /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    expect(
      await screen.findByText(/unable to reach authentication server/i)
    ).toBeInTheDocument();

    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
  });

  it("clears the password from memory after a successful login (B.3)", async () => {
    mockLogin.mockResolvedValue({});

    render(<MemoryRouter><Login /></MemoryRouter>);
    const passwordInput = screen.getByLabelText(/^password$/i);
    fireEvent.change(screen.getByLabelText(/username or email/i), {
      target: { value: "user@example.com" },
    });
    fireEvent.change(passwordInput, { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: /log in/i }));

    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    // Success path does not navigate in jsdom; password is cleared regardless.
    expect(passwordInput).toHaveValue("");
    expect(locationStub.href).toBe("/dashboard");
  });
});
