import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("renders checkbox input", () => {
    render(<Checkbox data-testid="checkbox" />);
    expect(screen.getByTestId("checkbox")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Checkbox className="custom-checkbox" data-testid="checkbox" />);
    expect(screen.getByTestId("checkbox")).toHaveClass("custom-checkbox");
  });

  it("is checked by default when defaultChecked", () => {
    render(<Checkbox defaultChecked data-testid="checkbox" />);
    expect(screen.getByTestId("checkbox")).toHaveAttribute("data-state", "checked");
  });

  it("is unchecked by default", () => {
    render(<Checkbox data-testid="checkbox" />);
    expect(screen.getByTestId("checkbox")).toHaveAttribute("data-state", "unchecked");
  });

  it("can be disabled", () => {
    render(<Checkbox disabled data-testid="checkbox" />);
    expect(screen.getByTestId("checkbox")).toBeDisabled();
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Checkbox ref={ref} />);
  });
});
