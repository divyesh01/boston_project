import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const { mockRegister, mockLogin } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockLogin: vi.fn(),
}));

vi.mock("@/components/AuthLayout", () => ({
  default: ({ children }) => <div>{children}</div>,
}));
vi.mock("@/lib/AuthContext", () => ({
  useAuth: () => ({ login: mockLogin, isAuthenticated: false }),
}));
vi.mock("@/api/base44Client", () => ({
  db: {
    users: { initialized: vi.fn().mockResolvedValue(false) },
    auth: { registerUser: mockRegister },
  },
}));
vi.mock("@/lib/security", () => ({
  validatePasswordStrength: () => null,
}));
vi.mock("@/lib/securityUtils", () => ({
  getCsrfToken: () => "csrf-token",
  validateCsrfToken: () => true,
  rotateCsrfToken: vi.fn(),
  sensitiveActionRateLimiter: { check: () => ({ allowed: true, retryAfter: 0 }) },
  sanitizeAlphanumeric: (v) => v,
  sanitizeEmail: (v) => String(v).trim().toLowerCase(),
  sanitizeText: (v) => v,
  sanitizeCsvCell: (v) => v,
}));
vi.mock("@/lib/validator", () => ({
  isValidEmail: (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e)),
}));

import Setup from "./Setup";

beforeEach(() => {
  mockRegister.mockReset();
  mockLogin.mockReset();
});

const submitForm = () => {
  const form = screen.getByRole("button", { name: /create owner account/i }).closest("form");
  fireEvent.submit(form);
};

describe("Setup — spec 2.A.1 email format gate", () => {
  it("blocks registration with a malformed email before any network request", async () => {
    mockRegister.mockResolvedValue({});

    render(
      <MemoryRouter>
        <Setup />
      </MemoryRouter>
    );
    const emailInput = await screen.findByLabelText(/email/i);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "owner" } });
    fireEvent.change(emailInput, { target: { value: "not-an-email" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "Passw0rd!" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "Passw0rd!" } });
    submitForm();

    expect(await screen.findByText(/please enter a valid email address/i)).toBeInTheDocument();
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it("allows a well-formed email through to registration", async () => {
    mockRegister.mockResolvedValue({});
    mockLogin.mockResolvedValue({});

    render(
      <MemoryRouter>
        <Setup />
      </MemoryRouter>
    );
    const emailInput = await screen.findByLabelText(/email/i);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "owner" } });
    fireEvent.change(emailInput, { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "Passw0rd!" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "Passw0rd!" } });
    submitForm();

    await waitFor(() => expect(mockRegister).toHaveBeenCalled());
    expect(mockRegister.mock.calls[0][0].email).toBe("owner@example.com");
  });
});
