import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./button";

describe("Button", () => {
  it("renders with text content", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: /click me/i })).toBeInTheDocument();
  });

  it("applies base classes", () => {
    render(<Button data-testid="btn">Test</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("inline-flex", "items-center");
  });

  it("applies destructive variant", () => {
    render(<Button variant="destructive" data-testid="btn">Delete</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("bg-destructive");
  });

  it("applies outline variant", () => {
    render(<Button variant="outline" data-testid="btn">Outline</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("border");
  });

  it("applies secondary variant", () => {
    render(<Button variant="secondary" data-testid="btn">Secondary</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("bg-secondary");
  });

  it("applies ghost variant", () => {
    render(<Button variant="ghost" data-testid="btn">Ghost</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("hover:bg-accent");
  });

  it("applies link variant", () => {
    render(<Button variant="link" data-testid="btn">Link</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("text-primary");
  });

  it("applies sm size", () => {
    render(<Button size="sm" data-testid="btn">Small</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("rounded-md");
  });

  it("applies lg size", () => {
    render(<Button size="lg" data-testid="btn">Large</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("rounded-md");
  });

  it("applies icon size", () => {
    render(<Button size="icon" data-testid="btn">Icon</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("h-9", "w-9");
  });

  it("is disabled when disabled prop is set", () => {
    render(<Button disabled data-testid="btn">Disabled</Button>);
    expect(screen.getByTestId("btn")).toBeDisabled();
  });

  it("applies custom className", () => {
    render(<Button className="custom-btn" data-testid="btn">Custom</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("custom-btn");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Button ref={ref}>Ref test</Button>);
  });

  it("handles click events", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole("button"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire click when disabled", async () => {
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<Button disabled onClick={handleClick}>Click</Button>);
    await user.click(screen.getByRole("button"));
    expect(handleClick).not.toHaveBeenCalled();
  });
});

describe("Button as child", () => {
  it("renders as child element", () => {
    render(
      <Button asChild>
        <a href="/test">Link Button</a>
      </Button>
    );
    expect(screen.getByRole("link", { name: /link button/i })).toHaveAttribute("href", "/test");
  });
});

describe("Button luxury 3D system", () => {
  it("applies GPU transform and scoped transition base classes", () => {
    render(<Button data-testid="btn">Base</Button>);
    const btn = screen.getByTestId("btn");
    expect(btn).toHaveClass("transform-gpu", "select-none", "rounded-md");
    expect(btn.className).toContain("transition-[transform,box-shadow,background-color,border-color]");
  });

  it("uses the emerald brand focus ring with no hardcoded offset color", () => {
    render(<Button data-testid="btn">Focus</Button>);
    const btn = screen.getByTestId("btn");
    expect(btn).toHaveClass("focus-visible:ring-2", "focus-visible:ring-[#00E096]");
    expect(btn.className).not.toContain("ring-offset-[#040D1A]");
  });

  it("primary variant layers a violet gradient over the bg-primary token", () => {
    render(<Button data-testid="btn">Primary</Button>);
    const btn = screen.getByTestId("btn");
    expect(btn).toHaveClass("bg-primary");
    expect(btn.className).toContain("[background-image:linear-gradient(to_bottom,#7C5CFF,#5B3FE0)]");
  });

  it("destructive variant layers a ruby gradient over the bg-destructive token", () => {
    render(<Button variant="destructive" data-testid="btn">Delete</Button>);
    const btn = screen.getByTestId("btn");
    expect(btn).toHaveClass("bg-destructive");
    expect(btn.className).toContain("[background-image:linear-gradient(to_bottom,#E0435B,#B21E38)]");
  });

  it("secondary variant layers a slate gradient over the bg-secondary token", () => {
    render(<Button variant="secondary" data-testid="btn">Secondary</Button>);
    const btn = screen.getByTestId("btn");
    expect(btn).toHaveClass("bg-secondary");
    expect(btn.className).toContain("[background-image:linear-gradient(to_bottom,#1B2230,#10141B)]");
  });

  it("applies hover elevation and tactile pressed state on primary", () => {
    render(<Button data-testid="btn">Press</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("hover:-translate-y-px", "active:translate-y-[1px]");
  });

  it("flattens on disabled with no transform and preserves opacity-50", () => {
    render(<Button disabled data-testid="btn">Disabled</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("disabled:opacity-50", "disabled:shadow-none", "disabled:translate-y-0");
  });

  it("neutralizes motion for reduced-motion users", () => {
    render(<Button data-testid="btn">Reduced</Button>);
    expect(screen.getByTestId("btn")).toHaveClass("motion-reduce:transition-none", "motion-reduce:transform-none");
  });

  it("keeps ghost and link variants flat (no lift transform)", () => {
    const { rerender } = render(<Button variant="ghost" data-testid="btn">Ghost</Button>);
    expect(screen.getByTestId("btn")).not.toHaveClass("hover:-translate-y-px");
    rerender(<Button variant="link" data-testid="btn">Link</Button>);
    expect(screen.getByTestId("btn")).not.toHaveClass("hover:-translate-y-px");
  });
});
