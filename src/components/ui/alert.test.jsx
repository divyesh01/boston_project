import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Alert, AlertTitle, AlertDescription } from "./alert";

describe("Alert", () => {
  it("renders alert", () => {
    render(<Alert data-testid="alert">Alert content</Alert>);
    expect(screen.getByTestId("alert")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Alert className="custom-alert" data-testid="alert">Alert</Alert>);
    expect(screen.getByTestId("alert")).toHaveClass("custom-alert");
  });

  it("applies default variant styling", () => {
    render(<Alert data-testid="alert">Alert</Alert>);
    expect(screen.getByTestId("alert")).toHaveClass("bg-background");
  });

  it("applies destructive variant styling", () => {
    render(<Alert variant="destructive" data-testid="alert">Error</Alert>);
    expect(screen.getByTestId("alert")).toHaveClass("text-destructive");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Alert ref={ref}>Alert</Alert>);
  });
});

describe("AlertTitle", () => {
  it("renders title text", () => {
    render(
      <Alert>
        <AlertTitle>Error Title</AlertTitle>
      </Alert>
    );
    expect(screen.getByText("Error Title")).toBeInTheDocument();
  });
});

describe("AlertDescription", () => {
  it("renders description text", () => {
    render(
      <Alert>
        <AlertDescription>Something went wrong</AlertDescription>
      </Alert>
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});

describe("Alert composition", () => {
  it("renders a complete alert", () => {
    render(
      <Alert>
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>Your session has expired. Please log in again.</AlertDescription>
      </Alert>
    );
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("Your session has expired. Please log in again.")).toBeInTheDocument();
  });
});
