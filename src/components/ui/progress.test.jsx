import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Progress } from "./progress";

describe("Progress", () => {
  it("renders progress bar", () => {
    render(<Progress data-testid="progress" />);
    expect(screen.getByTestId("progress")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Progress className="custom-progress" data-testid="progress" />);
    expect(screen.getByTestId("progress")).toHaveClass("custom-progress");
  });

  it("has role progressbar", () => {
    render(<Progress data-testid="progress" />);
    expect(screen.getByTestId("progress")).toHaveAttribute("role", "progressbar");
  });

  it("has aria-valuemax of 100 by default", () => {
    render(<Progress data-testid="progress" />);
    expect(screen.getByTestId("progress")).toHaveAttribute("aria-valuemax", "100");
  });

  it("has aria-valuemin of 0", () => {
    render(<Progress data-testid="progress" />);
    expect(screen.getByTestId("progress")).toHaveAttribute("aria-valuemin", "0");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Progress ref={ref} />);
  });
});
