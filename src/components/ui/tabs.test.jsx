import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

describe("Tabs", () => {
  it("renders tabs", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole("tab", { name: /tab 1/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /tab 2/i })).toBeInTheDocument();
  });

  it("accepts data-testid", () => {
    render(
      <Tabs defaultValue="tab1" data-testid="tabs">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId("tabs")).toBeInTheDocument();
  });
});

describe("TabsList", () => {
  it("renders tab triggers", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList data-testid="tabs-list">
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    expect(screen.getByTestId("tabs-list")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList className="custom-list" data-testid="tabs-list">
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    expect(screen.getByTestId("tabs-list")).toHaveClass("custom-list");
  });
});

describe("TabsTrigger", () => {
  it("renders trigger text", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">My Tab</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByRole("tab", { name: /my tab/i })).toBeInTheDocument();
  });

  it("is selected when default value matches", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" data-testid="trigger">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId("trigger")).toHaveAttribute("data-state", "active");
  });

  it("can be disabled", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1" disabled data-testid="trigger">Tab</TabsTrigger>
        </TabsList>
      </Tabs>
    );
    expect(screen.getByTestId("trigger")).toBeDisabled();
  });
});

describe("TabsContent", () => {
  it("renders content for active tab", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Active Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByText("Active Content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1" className="custom-content" data-testid="content">Content</TabsContent>
      </Tabs>
    );
    expect(screen.getByTestId("content")).toHaveClass("custom-content");
  });
});
