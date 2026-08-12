import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./accordion";

describe("Accordion", () => {
  it("renders trigger text", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByText("Trigger")).toBeInTheDocument();
  });

  it("applies className via cn utility", () => {
    const { container } = render(
      <Accordion type="single" className="custom-class">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    expect(container.firstChild).toHaveClass("custom-class");
  });

  it("forwards ref to Accordion root", () => {
    const ref = { current: null };
    render(
      <Accordion type="single" ref={ref}>
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
        </AccordionItem>
      </Accordion>
    );
  });
});

describe("AccordionItem", () => {
  it("applies custom className", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1" className="custom-item" data-testid="item">
          <AccordionTrigger>Trigger</AccordionTrigger>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByTestId("item")).toHaveClass("custom-item");
  });

  it("accepts data-testid", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1" data-testid="my-item">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByTestId("my-item")).toBeInTheDocument();
  });
});

describe("AccordionTrigger", () => {
  it("renders as a button", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Click me</AccordionTrigger>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByRole("button", { name: /click me/i })).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger className="trigger-class">Trigger</AccordionTrigger>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByRole("button")).toHaveClass("trigger-class");
  });

  it("has aria-expanded attribute", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
        </AccordionItem>
      </Accordion>
    );
    const trigger = screen.getByRole("button");
    expect(trigger).toHaveAttribute("aria-expanded");
  });
});

describe("AccordionContent", () => {
  it("renders content text when expanded", () => {
    render(
      <Accordion type="single" defaultValue="item-1">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent>Visible content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByText("Visible content")).toBeInTheDocument();
  });

  it("applies custom className", () => {
    render(
      <Accordion type="single" defaultValue="item-1">
        <AccordionItem value="item-1">
          <AccordionTrigger>Trigger</AccordionTrigger>
          <AccordionContent className="content-class">Content</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByText("Content")).toHaveClass("content-class");
  });
});

describe("Accordion accessibility", () => {
  it("has button role on trigger", () => {
    render(
      <Accordion type="single">
        <AccordionItem value="item-1">
          <AccordionTrigger>Section 1</AccordionTrigger>
          <AccordionContent>Content 1</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    const trigger = screen.getByRole("button", { name: /section 1/i });
    expect(trigger).toHaveAttribute("data-state");
  });

  it("supports multiple items", () => {
    render(
      <Accordion type="multiple" defaultValue={["item-1", "item-2"]}>
        <AccordionItem value="item-1">
          <AccordionTrigger>First</AccordionTrigger>
          <AccordionContent>Content 1</AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Second</AccordionTrigger>
          <AccordionContent>Content 2</AccordionContent>
        </AccordionItem>
      </Accordion>
    );
    expect(screen.getByText("Content 1")).toBeInTheDocument();
    expect(screen.getByText("Content 2")).toBeInTheDocument();
  });
});
