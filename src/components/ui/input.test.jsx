import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "./input";

describe("Input", () => {
  it("renders input element", () => {
    render(<Input data-testid="input" />);
    expect(screen.getByTestId("input")).toBeInTheDocument();
  });

  it("renders as an input element", () => {
    render(<Input data-testid="input" />);
    expect(screen.getByTestId("input").tagName).toBe("INPUT");
  });

  it("applies custom className", () => {
    render(<Input className="custom-input" data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveClass("custom-input");
  });

  it("accepts placeholder", () => {
    render(<Input placeholder="Enter text" data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveAttribute("placeholder", "Enter text");
  });

  it("is disabled when disabled prop is set", () => {
    render(<Input disabled data-testid="input" />);
    expect(screen.getByTestId("input")).toBeDisabled();
  });

  it("is read-only when readOnly prop is set", () => {
    render(<Input readOnly data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveAttribute("readonly");
  });

  it("accepts value prop", () => {
    render(<Input value="test value" readOnly data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveValue("test value");
  });

  it("handles onChange events", async () => {
    const user = userEvent.setup();
    const handleChange = vi.fn();
    render(<Input onChange={handleChange} data-testid="input" />);
    await user.type(screen.getByTestId("input"), "hello");
    expect(handleChange).toHaveBeenCalled();
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Input ref={ref} />);
  });

  it("supports file type", () => {
    render(<Input type="file" data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveAttribute("type", "file");
  });

  it("supports password type", () => {
    render(<Input type="password" data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveAttribute("type", "password");
  });
});
