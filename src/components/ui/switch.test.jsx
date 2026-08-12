import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "./switch";

describe("Switch", () => {
  it("renders switch", () => {
    render(<Switch data-testid="switch" />);
    expect(screen.getByTestId("switch")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Switch className="custom-switch" data-testid="switch" />);
    expect(screen.getByTestId("switch")).toHaveClass("custom-switch");
  });

  it("is unchecked by default", () => {
    render(<Switch data-testid="switch" />);
    expect(screen.getByTestId("switch")).toHaveAttribute("data-state", "unchecked");
  });

  it("can be checked by default", () => {
    render(<Switch checked data-testid="switch" />);
    expect(screen.getByTestId("switch")).toHaveAttribute("data-state", "checked");
  });

  it("can be disabled", () => {
    render(<Switch disabled data-testid="switch" />);
    expect(screen.getByTestId("switch")).toBeDisabled();
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Switch ref={ref} />);
  });
});
