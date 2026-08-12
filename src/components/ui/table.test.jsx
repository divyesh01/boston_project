import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "./table";

describe("Table", () => {
  it("renders as a table element", () => {
    render(
      <Table data-testid="table">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>John</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByTestId("table").tagName).toBe("TABLE");
  });

  it("applies custom className", () => {
    render(<Table className="custom-table" data-testid="table" />);
    expect(screen.getByTestId("table")).toHaveClass("custom-table");
  });
});

describe("TableHeader", () => {
  it("renders as thead element", () => {
    render(
      <Table>
        <TableHeader data-testid="thead">
          <TableRow><TableHead>Col</TableHead></TableRow>
        </TableHeader>
      </Table>
    );
    expect(screen.getByTestId("thead").tagName).toBe("THEAD");
  });
});

describe("TableBody", () => {
  it("renders as tbody element", () => {
    render(
      <Table>
        <TableBody data-testid="tbody">
          <TableRow><TableCell>Cell</TableCell></TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByTestId("tbody").tagName).toBe("TBODY");
  });
});

describe("TableFooter", () => {
  it("renders as tfoot element", () => {
    render(
      <Table>
        <TableFooter data-testid="tfoot">
          <TableRow><TableCell>Footer</TableCell></TableRow>
        </TableFooter>
      </Table>
    );
    expect(screen.getByTestId("tfoot").tagName).toBe("TFOOT");
  });
});

describe("TableHead", () => {
  it("renders text", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow><TableHead>Header</TableHead></TableRow>
        </TableHeader>
      </Table>
    );
    expect(screen.getByText("Header")).toBeInTheDocument();
  });
});

describe("TableRow", () => {
  it("renders as tr element", () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-testid="row"><TableCell>Cell</TableCell></TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByTestId("row").tagName).toBe("TR");
  });
});

describe("TableCell", () => {
  it("renders text", () => {
    render(
      <Table>
        <TableBody>
          <TableRow><TableCell>Cell data</TableCell></TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByText("Cell data")).toBeInTheDocument();
  });
});

describe("TableCaption", () => {
  it("renders caption text", () => {
    render(
      <Table>
        <TableCaption>Table caption</TableCaption>
      </Table>
    );
    expect(screen.getByText("Table caption")).toBeInTheDocument();
  });
});

describe("Table full composition", () => {
  it("renders a complete table", () => {
    render(
      <Table>
        <TableCaption>Employee List</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Role</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>John Doe</TableCell>
            <TableCell>Engineer</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Jane Smith</TableCell>
            <TableCell>Manager</TableCell>
          </TableRow>
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>Total: 2 employees</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    );
    expect(screen.getByText("Employee List")).toBeInTheDocument();
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByText("Total: 2 employees")).toBeInTheDocument();
  });
});
