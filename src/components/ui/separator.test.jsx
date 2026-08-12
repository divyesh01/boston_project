import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Separator } from "./separator";

describe("Separator", () => {
  it("renders a separator element", () => {
    render(<Separator data-testid="separator" />);
    expect(screen.getByTestId("separator")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Separator className="custom-separator" data-testid="separator" />);
    expect(screen.getByTestId("separator")).toHaveClass("custom-separator");
  });

  it("is horizontal by default", () => {
    render(<Separator data-testid="separator" />);
    expect(screen.getByTestId("separator")).toHaveAttribute("data-orientation", "horizontal");
  });

  it("supports vertical orientation", () => {
    render(<Separator orientation="vertical" data-testid="separator" />);
    expect(screen.getByTestId("separator")).toHaveAttribute("data-orientation", "vertical");
  });

  it("has decorative role by default", () => {
    render(<Separator data-testid="separator" />);
    expect(screen.getByTestId("separator")).toHaveAttribute("role", "none");
  });

  it("has separator role when not decorative", () => {
    render(<Separator decorative={false} data-testid="separator" />);
    expect(screen.getByTestId("separator")).toHaveAttribute("role", "separator");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Separator ref={ref} />);
  });
});
