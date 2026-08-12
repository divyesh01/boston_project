import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Textarea } from "./textarea";

describe("Textarea", () => {
  it("renders textarea element", () => {
    render(<Textarea data-testid="textarea" />);
    expect(screen.getByTestId("textarea")).toBeInTheDocument();
  });

  it("is a textarea element", () => {
    render(<Textarea data-testid="textarea" />);
    expect(screen.getByTestId("textarea").tagName).toBe("TEXTAREA");
  });

  it("applies custom className", () => {
    render(<Textarea className="custom-textarea" data-testid="textarea" />);
    expect(screen.getByTestId("textarea")).toHaveClass("custom-textarea");
  });

  it("accepts placeholder", () => {
    render(<Textarea placeholder="Enter text" data-testid="textarea" />);
    expect(screen.getByTestId("textarea")).toHaveAttribute("placeholder", "Enter text");
  });

  it("is disabled when disabled prop is set", () => {
    render(<Textarea disabled data-testid="textarea" />);
    expect(screen.getByTestId("textarea")).toBeDisabled();
  });

  it("accepts defaultValue", () => {
    render(<Textarea defaultValue="default content" data-testid="textarea" />);
    expect(screen.getByTestId("textarea")).toHaveValue("default content");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Textarea ref={ref} />);
  });

  it("supports rows attribute", () => {
    render(<Textarea rows={5} data-testid="textarea" />);
    expect(screen.getByTestId("textarea")).toHaveAttribute("rows", "5");
  });
});
