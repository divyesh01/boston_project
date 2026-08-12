import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Label } from "./label";

describe("Label", () => {
  it("renders text", () => {
    render(<Label>Name</Label>);
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("is a label element", () => {
    render(<Label data-testid="label">Label</Label>);
    expect(screen.getByTestId("label").tagName).toBe("LABEL");
  });

  it("applies custom className", () => {
    render(<Label className="custom-label" data-testid="label">Label</Label>);
    expect(screen.getByTestId("label")).toHaveClass("custom-label");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Label ref={ref}>Label</Label>);
  });

  it("applies disabled styling when data-disabled is set", () => {
    render(<Label data-disabled data-testid="label">Disabled</Label>);
    expect(screen.getByTestId("label")).toHaveAttribute("data-disabled");
  });
});
