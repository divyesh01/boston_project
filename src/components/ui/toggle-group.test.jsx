import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

describe("ToggleGroup", () => {
  it("renders toggle group", () => {
    render(
      <ToggleGroup type="single" data-testid="group">
        <ToggleGroupItem value="a">A</ToggleGroupItem>
        <ToggleGroupItem value="b">B</ToggleGroupItem>
      </ToggleGroup>
    );
    expect(screen.getByTestId("group")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <ToggleGroup type="single" className="custom-group" data-testid="group">
        <ToggleGroupItem value="a">A</ToggleGroupItem>
      </ToggleGroup>
    );
    expect(screen.getByTestId("group")).toHaveClass("custom-group");
  });

  it("applies sm size to items", () => {
    render(
      <ToggleGroup type="single" size="sm">
        <ToggleGroupItem value="a" data-testid="item">A</ToggleGroupItem>
      </ToggleGroup>
    );
    expect(screen.getByTestId("item")).toHaveClass("h-8");
  });
});

describe("ToggleGroupItem", () => {
  it("renders item text", () => {
    render(
      <ToggleGroup type="single">
        <ToggleGroupItem value="a" data-testid="item">Item A</ToggleGroupItem>
      </ToggleGroup>
    );
    expect(screen.getByTestId("item")).toBeInTheDocument();
  });

  it("can be disabled", () => {
    render(
      <ToggleGroup type="single">
        <ToggleGroupItem value="a" disabled data-testid="item">A</ToggleGroupItem>
      </ToggleGroup>
    );
    expect(screen.getByTestId("item")).toBeDisabled();
  });
});
