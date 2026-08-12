import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders text", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("applies default variant", () => {
    render(<Badge data-testid="badge">Badge</Badge>);
    expect(screen.getByTestId("badge")).toHaveClass("border-transparent");
  });

  it("applies secondary variant", () => {
    render(<Badge variant="secondary" data-testid="badge">Secondary</Badge>);
    expect(screen.getByTestId("badge")).toHaveClass("border-transparent");
  });

  it("applies destructive variant", () => {
    render(<Badge variant="destructive" data-testid="badge">Destructive</Badge>);
    expect(screen.getByTestId("badge")).toHaveClass("border-transparent");
  });

  it("applies outline variant", () => {
    render(<Badge variant="outline" data-testid="badge">Outline</Badge>);
    expect(screen.getByTestId("badge")).not.toHaveClass("bg-primary");
  });

  it("applies custom className", () => {
    render(<Badge className="custom-badge" data-testid="badge">Custom</Badge>);
    expect(screen.getByTestId("badge")).toHaveClass("custom-badge");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Badge ref={ref}>Ref</Badge>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });
});
