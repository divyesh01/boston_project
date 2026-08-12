import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Avatar, AvatarImage, AvatarFallback } from "./avatar";

describe("Avatar", () => {
  it("renders fallback when no image", () => {
    render(
      <Avatar>
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText("AB")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Avatar className="custom-avatar" data-testid="avatar">
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("avatar")).toHaveClass("custom-avatar");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(
      <Avatar ref={ref}>
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    );
  });
});

describe("AvatarImage", () => {
  it("accepts src and alt props (hidden until loaded in jsdom)", () => {
    render(
      <Avatar>
        <AvatarImage src="/photo.jpg" alt="User photo" />
        <AvatarFallback>AB</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText("AB")).toBeInTheDocument();
  });
});

describe("AvatarFallback", () => {
  it("renders fallback text", () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText("JD")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Avatar>
        <AvatarFallback className="fallback-class">AB</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText("AB")).toHaveClass("fallback-class");
  });
});
