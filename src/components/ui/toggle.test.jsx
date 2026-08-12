import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Toggle } from "./toggle";

describe("Toggle", () => {
  it("renders toggle button", () => {
    render(<Toggle data-testid="toggle">B</Toggle>);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Toggle className="custom-toggle" data-testid="toggle">Toggle</Toggle>);
    expect(screen.getByTestId("toggle")).toHaveClass("custom-toggle");
  });

  it("is pressed when defaultPressed is true", () => {
    render(<Toggle defaultPressed data-testid="toggle">Toggle</Toggle>);
    expect(screen.getByTestId("toggle")).toHaveAttribute("data-state", "on");
  });

  it("is not pressed by default", () => {
    render(<Toggle data-testid="toggle">Toggle</Toggle>);
    expect(screen.getByTestId("toggle")).toHaveAttribute("data-state", "off");
  });

  it("can be disabled", () => {
    render(<Toggle disabled data-testid="toggle">Toggle</Toggle>);
    expect(screen.getByTestId("toggle")).toBeDisabled();
  });

  it("applies sm size", () => {
    render(<Toggle size="sm" data-testid="toggle">Toggle</Toggle>);
    expect(screen.getByTestId("toggle")).toHaveClass("h-8");
  });

  it("applies lg size", () => {
    render(<Toggle size="lg" data-testid="toggle">Toggle</Toggle>);
    expect(screen.getByTestId("toggle")).toHaveClass("h-10");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Toggle ref={ref}>Toggle</Toggle>);
  });
});
