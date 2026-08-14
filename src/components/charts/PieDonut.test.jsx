import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PieDonut from "@/components/charts/PieDonut";
import { money2 } from "@/lib/hotel";

// jsdom has no layout engine, so recharts' ResponsiveContainer measures 0 and
// renders nothing. We mock recharts just enough to (a) give the chart a fixed
// size and (b) CAPTURE the props the component passes to <Pie>, so we can prove
// the contract: responsive % radius, one slice per segment, inside-only labels.
vi.mock("recharts", async (importActual) => {
  const actual = await importActual();
  const ResponsiveContainer = ({ children, width = 360, height = 300 }) => {
    const arr = React.Children.toArray(children);
    return React.createElement(
      "div",
      { "data-testid": "rc" },
      arr.map((c, i) => React.isValidElement(c) ? React.cloneElement(c, { width, height, key: i }) : c)
    );
  };
  const Pie = (props) => {
    const total = (props.data || []).reduce((a, d) => a + (Number(d.value) || 0), 0) || 1;
    // Expose what the component configured, for assertions.
    globalThis.__lastPieProps = props;
    const { data, nameKey, label } = props;
    return React.createElement(
      "svg",
      { width: props.width, height: props.height, "data-pie": "true" },
      (data || []).map((d, i) => {
        const labelEl = label
          ? label({
              ...d,
              percent: (Number(d.value) || 0) / total,
              cx: 180,
              cy: 150,
              midAngle: 0,
              innerRadius: 40,
              outerRadius: 140,
            })
          : null;
        return React.createElement(
          "g",
          { key: i },
          React.createElement("path", { "data-name": d[nameKey] }),
          labelEl && React.isValidElement(labelEl) ? labelEl : null
        );
      })
    );
  };
  const PieChart = ({ children }) => React.createElement(React.Fragment, null, children);
  const Cell = () => null;
  const Tooltip = () => null;
  return { ...(typeof actual === 'object' ? actual : {}), ResponsiveContainer, Pie, PieChart, Cell, Tooltip };
});

const fmt = (v) => money2(v);
const pieProps = () => globalThis.__lastPieProps;

describe("PieDonut — visible-in-box contract", () => {
  it("renders a 'No data' message instead of an empty ring when there is no data", () => {
    render(<PieDonut data={[]} />);
    expect(screen.getByText(/No data to visualise/i)).toBeInTheDocument();
  });

  it("passes one slice per segment to the pie and a responsive % radius", () => {
    const data = [
      { name: "Cash", value: 100, color: "#111" },
      { name: "Visa", value: 50, color: "#222" },
      { name: "Amex", value: 25, color: "#333" },
    ];
    const { container } = render(<PieDonut data={data} type="pie" formatter={fmt} />);

    // 1) The pie receives exactly one slice per data segment.
    expect(pieProps().data.length).toBe(data.length);
    expect(container.querySelectorAll("svg path").length).toBe(data.length);

    // 2) Radius is a PERCENTAGE (scales to the box) — never a fixed pixel value
    //    that could overflow a small box.
    expect(typeof pieProps().outerRadius).toBe("string");
    expect(pieProps().outerRadius.endsWith("%")).toBe(true);
  });

  it("lists EVERY segment's name + value + % in the legend (all numbers visible)", () => {
    const data = [
      { name: "Cash", value: 100 },
      { name: "Visa", value: 50 },
      { name: "Amex", value: 25 },
    ];
    render(<PieDonut data={data} type="pie" formatter={fmt} />);

    const list = document.querySelector("ul");
    expect(list).toBeTruthy();
    expect(list.querySelectorAll("li").length).toBe(data.length);

    data.forEach((d) => {
      const total = data.reduce((a, c) => a + c.value, 0);
      const share = ((d.value / total) * 100).toFixed(1);
      expect(screen.getByText(d.name)).toBeInTheDocument();
      expect(screen.getByText(fmt(d.value))).toBeInTheDocument();
      expect(screen.getByText(`${share}%`)).toBeInTheDocument();
    });
  });

  it("buckets overflow slices into 'Other' so the legend never overflows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Cat${i}`, value: i + 1 }));
    const { container } = render(<PieDonut data={many} maxSlices={12} formatter={fmt} />);

    // pie gets 12 head slices + 1 "Other" bucket
    expect(pieProps().data.length).toBe(13);
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(container.querySelectorAll("ul li").length).toBe(13);
    // every source value is still surfaced in the legend
    expect(screen.getByText(fmt(many[0].value))).toBeInTheDocument();
  });

  it("draws inside-slice % labels only for large slices (never spilling outside the box)", () => {
    render(<PieDonut data={[{ name: "Big", value: 97 }, { name: "Tiny", value: 3 }]} formatter={fmt} />);
    const label = pieProps().label;
    const big = label({
      name: "Big",
      value: 97,
      percent: 0.97,
      cx: 180,
      cy: 150,
      midAngle: 0,
      innerRadius: 40,
      outerRadius: 140,
    });
    const tiny = label({
      name: "Tiny",
      value: 3,
      percent: 0.03,
      cx: 180,
      cy: 150,
      midAngle: 0,
      innerRadius: 40,
      outerRadius: 140,
    });
    expect(big?.props?.children).toBe("97%"); // big slice labelled inside
    expect(tiny).toBeNull(); // tiny slice not labelled (no outside spill)
  });

  it("reserves the full height for chart + legend so nothing is clipped (stays in box)", () => {
    const { container } = render(<PieDonut data={[{ name: "A", value: 1 }]} height={320} />);
    const wrapper = /** @type {HTMLElement} */ (container.firstChild);
    expect(wrapper.style.height).toBe("320px");
    expect(wrapper.querySelector("ul")).toBeTruthy(); // legend is in-flow, not clipped
  });
});
