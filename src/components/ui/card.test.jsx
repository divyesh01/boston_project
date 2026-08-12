import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "./card";

describe("Card", () => {
  it("renders children", () => {
    render(<Card data-testid="card">Content</Card>);
    expect(screen.getByTestId("card")).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Card className="custom-card" data-testid="card" />);
    expect(screen.getByTestId("card")).toHaveClass("custom-card");
  });

  it("forwards ref", () => {
    const ref = { current: null };
    render(<Card ref={ref} />);
  });
});

describe("CardHeader", () => {
  it("renders children", () => {
    render(<Card><CardHeader data-testid="header">Header Content</CardHeader></Card>);
    expect(screen.getByText("Header Content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Card><CardHeader className="custom-header" data-testid="header" /></Card>);
    expect(screen.getByTestId("header")).toHaveClass("custom-header");
  });
});

describe("CardTitle", () => {
  it("renders text", () => {
    render(<Card><CardTitle>My Title</CardTitle></Card>);
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Card><CardTitle className="title-class">Title</CardTitle></Card>);
    expect(screen.getByText("Title")).toHaveClass("title-class");
  });
});

describe("CardDescription", () => {
  it("renders text", () => {
    render(<Card><CardDescription>Description text</CardDescription></Card>);
    expect(screen.getByText("Description text")).toBeInTheDocument();
  });
});

describe("CardContent", () => {
  it("renders children", () => {
    render(<Card><CardContent>Content here</CardContent></Card>);
    expect(screen.getByText("Content here")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Card><CardContent className="content-class">Content</CardContent></Card>);
    expect(screen.getByText("Content")).toHaveClass("content-class");
  });
});

describe("CardFooter", () => {
  it("renders children", () => {
    render(<Card><CardFooter>Footer content</CardFooter></Card>);
    expect(screen.getByText("Footer content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(<Card><CardFooter className="footer-class">Footer</CardFooter></Card>);
    expect(screen.getByText("Footer")).toHaveClass("footer-class");
  });
});

describe("Card composition", () => {
  it("renders a complete card", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Card Title</CardTitle>
          <CardDescription>Card Description</CardDescription>
        </CardHeader>
        <CardContent>Card Body</CardContent>
        <CardFooter>Card Footer</CardFooter>
      </Card>
    );
    expect(screen.getByText("Card Title")).toBeInTheDocument();
    expect(screen.getByText("Card Description")).toBeInTheDocument();
    expect(screen.getByText("Card Body")).toBeInTheDocument();
    expect(screen.getByText("Card Footer")).toBeInTheDocument();
  });
});
