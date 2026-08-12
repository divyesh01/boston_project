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
