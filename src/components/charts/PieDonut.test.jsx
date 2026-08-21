import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PieDonut, { donutInnerFor } from "@/components/charts/PieDonut";
import { money2 } from "@/lib/hotel";

// jsdom has no layout engine, so recharts' ResponsiveContainer measures 0 and
// renders nothing. We mock recharts just enough to (a) give the chart a fixed
// size and (b) CAPTURE the props the component passes to <Pie>, so we can prove
// the contract: responsive % radius, one slice per segment, and every slice
// labelled outside the pie with a leader line (never hidden, never overlapping).
vi.mock("recharts", async (importActual) => {
  const actual = await importActual();
  const ResponsiveContainer = ({ children, width = 360, height = 300 }) => {
    // PieDonut uses the render-prop form so it can size the ring from the box.
    if (typeof children === "function") {
      return React.createElement("div", { "data-testid": "rc" }, children(width, height));
    }
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
const fmtTrim = (v) => money2(v).replace(/\.00$/, "");
const pieProps = () => globalThis.__lastPieProps;

// Leader line: a <polyline> (elbow) or <line> (straight) with geometry we can read.
const leaderEl = (el) =>
  /** @type {any} */ (React.Children.toArray(/** @type {any} */ (el).props.children)
    .find((c) => /** @type {any} */ (c).type === "polyline" || /** @type {any} */ (c).type === "line"));
// Normalise either form into an array of {x,y} vertices.
const leaderPoints = (el) => {
  const p = /** @type {any} */ (leaderEl(el)).props;
  if (typeof p.points === "string") {
    return p.points.trim().split(/\s+/).map((pair) => {
      const [x, y] = pair.split(",").map(Number);
      return { x, y };
    });
  }
  return [{ x: Number(p.x1), y: Number(p.y1) }, { x: Number(p.x2), y: Number(p.y2) }];
};
const leaderEnd = (el) => leaderPoints(el)[leaderPoints(el).length - 1];

// Recharts lays sectors out from startAngle toward endAngle (paddingAngle,
// minAngle 0). Mirror that layout so a test can hand the label renderer the
// REAL mid-angle of a slice — the component derives the left/right side from
// that angle, exactly as it will in the browser.
const midAngleOf = (data, i, start = 0, end = 360, pad = 2) => {
  const n = data.length;
  const sign = Math.sign(end - start) || 1;
  const absSweep = Math.min(Math.abs(end - start), 360);
  const sweep = absSweep - (absSweep >= 360 ? n : n - 1) * pad;
  const total = data.reduce((a, d) => a + (Number(d.value) || 0), 0) || 1;
  let prev = start;
  let mid = 0;
  data.forEach((d, k) => {
    const s = k === 0 ? start : prev + sign * pad;
    const e = s + sign * ((Number(d.value) || 0) / total) * sweep;
    if (k === i) mid = (s + e) / 2;
    prev = e;
  });
  return mid;
};

// The tspans holding the category NAME. The value/percent line is the one that
// carries its own smaller fontSize, so it is excluded here.
const nameLinesOf = (el) => {
  const text = /** @type {any} */ (React.Children.toArray(/** @type {any} */ (el).props?.children || [])
    .find((c) => React.isValidElement(c) && c.type === "text"));
  if (!text) return [];
  return /** @type {any[]} */ (React.Children.toArray(text.props.children))
    .filter((c) => /** @type {any} */ (c).type === "tspan" && /** @type {any} */ (c).props.fontSize === undefined)
    .map((c) => String(/** @type {any} */ (c).props.children));
};

// Flatten a rendered label <g> into its visible text (leader line excluded).
const labelText = (el) => {
  if (!el || !React.isValidElement(el)) return "";
  const text = /** @type {any} */ (React.Children.toArray(el.props?.children || [])
    .find((c) => React.isValidElement(c) && c.type === "text"));
  if (!text) return "";
  return React.Children.toArray(/** @type {any} */ (text).props.children || [])
    .map((t) => (/** @type {any} */ (t).props?.children ?? t ?? ""))
    .join(" ");
};

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
    render(<PieDonut data={data} type="pie" formatter={fmt} />);

    // 1) The pie receives exactly one slice per data segment.
    expect(pieProps().data.length).toBe(data.length);

    // 2) Radius is a PERCENTAGE (scales to the box) — never a fixed pixel value
    //    that could overflow a small box.
    expect(typeof pieProps().outerRadius).toBe("string");
    expect(pieProps().outerRadius.endsWith("%")).toBe(true);
  });

  it("labels EVERY slice with name + value + % and a leader line (nothing hidden)", () => {
    const data = [
      { name: "Cash", value: 100 },
      { name: "Visa", value: 50 },
      { name: "Amex", value: 25 },
    ];
    render(<PieDonut data={data} type="pie" formatter={fmt} />);
    const label = pieProps().label;

    data.forEach((d, i) => {
      // Every slice — even a small one — gets an outside label. Hand it the
      // slice's REAL mid-angle so the renderer anchors it on the right side.
      const el = label({ ...d, percent: (d.value / 175), cx: 180, cy: 150, midAngle: midAngleOf(data, i), innerRadius: 40, outerRadius: 140 });
      expect(el).not.toBeNull();

      // The label is a <g> containing an elbow leader line plus a <text> block.
      const children = /** @type {any} */ (React.Children.toArray(/** @type {any} */ (el).props.children));
      expect(children.some((c) => c.type === "polyline" || c.type === "line" || c.type === "path")).toBe(true);
      expect(children.some((c) => c.type === "text")).toBe(true);

      // The text block shows the name, the formatted value, and the %.
      const text = labelText(el);
      expect(text).toContain(d.name);
      expect(text).toContain(fmtTrim(d.value));
      expect(text).toContain("%");
    });
  });

  it("keeps a short name on ONE line, and wraps a long one rather than clipping it", () => {
    // Short name, plenty of room → exactly one line.
    render(<PieDonut data={[{ name: "Cash", value: 50 }]} formatter={fmt} />);
    const shortEl = pieProps().label({ name: "Cash", value: 50, percent: 1, cx: 180, cy: 150, midAngle: 0, innerRadius: 40, outerRadius: 70 });
    expect(nameLinesOf(shortEl)).toEqual(["Cash"]);

    // The 39-character name that used to be clipped to "Credit Card Processing F".
    // It now wraps onto a second line and keeps every character.
    const long = "Credit Card Processing Fees (estimated)";
    render(<PieDonut data={[{ name: long, value: 50 }]} formatter={fmt} />);
    const el = pieProps().label({ name: long, value: 50, percent: 1, cx: 180, cy: 150, midAngle: 0, innerRadius: 40, outerRadius: 70 });
    const lines = nameLinesOf(el);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.length).toBeLessThanOrEqual(2); // never more than 2 lines
    // Nothing was silently dropped or ellipsised away.
    expect(lines.join(" ")).toBe(long);
    expect(lines.join("")).not.toContain("…");
  });

  it("keeps every label on its own row and orders rows by the slice's radial position", () => {
    const data = [
      { name: "Alpha", value: 34 },
      { name: "Beta", value: 33 },
      { name: "Gamma", value: 33 },
    ];
    render(<PieDonut data={data} type="pie" formatter={fmt} />);
    const label = pieProps().label;
    const mk = (name, i) => label({ name, value: 33, percent: 0.333, cx: 180, cy: 150, midAngle: midAngleOf(data, i), innerRadius: 40, outerRadius: 140 });

    // Every label lands on a DISTINCT row — nothing overlaps.
    const ys = [mk("Alpha", 0), mk("Beta", 1), mk("Gamma", 2)].map((el) => leaderEnd(el).y);
    expect(new Set(ys).size).toBe(3);
    // Rows follow the slices' radial positions: Alpha sits at the top of the pie,
    // so its label is the highest (smallest y); Gamma at the bottom → lowest.
    const order = ys.slice().sort((a, b) => a - b);
    expect(order).toEqual(ys);
  });

it("anchors left-half slices to the LEFT column and right-half slices to the RIGHT (no crossing)", () => {
    // Values chosen so the two slices land on opposite halves (startAngle 0):
    // "Big" (60%) straddles the left half, "Small" (40%) the right half.
    const data = [
      { name: "Big", value: 60 },
      { name: "Small", value: 40 },
    ];
    render(<PieDonut data={data} type="pie" formatter={fmt} />);
    const label = pieProps().label;
    const left = label({ name: "Big", value: 60, percent: 0.6, cx: 200, cy: 150, midAngle: midAngleOf(data, 0), innerRadius: 40, outerRadius: 120 });
    const right = label({ name: "Small", value: 40, percent: 0.4, cx: 200, cy: 150, midAngle: midAngleOf(data, 1), innerRadius: 40, outerRadius: 120 });
    // Big's label points OUT to the left of the pie centre; Small's to the right.
    expect(leaderEnd(left).x).toBeLessThan(200);
    expect(leaderEnd(right).x).toBeGreaterThan(200);
  });

  it("keeps every label on its natural side — no crossing over", () => {
    // Each label stays on the same side as its slice: right-half slices → right,
    // left-half slices → left. No balancing, no crossing.
    const data = [
      { name: "A", value: 5 },
      { name: "B", value: 5 },
      { name: "C", value: 5 },
      { name: "D", value: 85 },
    ];
    render(<PieDonut data={data} type="pie" formatter={fmt} />);
    const label = pieProps().label;
    const info = data.map((d, i) => {
      const mid = midAngleOf(data, i);
      const el = label({ ...d, percent: d.value / 100, cx: 200, cy: 150, midAngle: mid, innerRadius: 40, outerRadius: 140 });
      const end = leaderEnd(el);
      const naturalSide = Math.cos(-mid * Math.PI / 180) >= 0 ? "right" : "left";
      const actualSide = end.x > 200 ? "right" : "left";
      return { name: d.name, mid, dotX: end.x, naturalSide, actualSide };
    });

    // Every label is on its natural side — no label crosses over.
    info.forEach((r) => {
      expect(r.actualSide).toBe(r.naturalSide);
    });
  });

  it("starts every leader line on the slice edge and radiates outward before bending", () => {
    const data = [
      { name: "Far", value: 50 },
      { name: "Wide", value: 50 },
    ];
    render(<PieDonut data={data} type="pie" formatter={fmt} />);
    const label = pieProps().label;
    [0, 1].forEach((i) => {
      const mid = midAngleOf(data, i);
      const el = label({ ...data[i], percent: 0.5, cx: 180, cy: 150, midAngle: mid, innerRadius: 40, outerRadius: 140 });
      const pts = leaderPoints(el);
      expect(pts.length).toBeGreaterThanOrEqual(2);

      // 1) The line starts exactly ON the ring, at the slice's own angle.
      const edgeX = 180 + 140 * Math.cos(-mid * Math.PI / 180);
      const edgeY = 150 + 140 * Math.sin(-mid * Math.PI / 180);
      expect(Math.abs(pts[0].x - edgeX)).toBeLessThan(0.01);
      expect(Math.abs(pts[0].y - edgeY)).toBeLessThan(0.01);

      // 2) The FIRST segment is a purely radial stub — it leaves the ring along
      //    the slice's own direction, so the eye can trace label back to slice.
      const stubAngle = Math.atan2(pts[1].y - 150, pts[1].x - 180);
      let diff = stubAngle - (-mid * Math.PI / 180);
      diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      expect(Math.abs(diff)).toBeLessThan(0.01);

      // 3) After the stub the line may bend vertically to reach a de-collided
      //    row, but it must keep travelling outward — never doubling back.
      const dir = leaderEnd(el).x > 180 ? 1 : -1;
      for (let k = 2; k < pts.length; k++) {
        expect((pts[k].x - pts[k - 1].x) * dir).toBeGreaterThanOrEqual(-0.01);
      }
    });
  });

  it("NEVER lets two labels overlap, even with many tiny adjacent slices", () => {
    // The exact failure mode from the old staggered-offset layout: several
    // sub-1% slices sit at almost the same angle, so their labels landed at
    // almost the same y. Lengthening the leader line did not separate them.
    const data = [
      { name: "Mastercard", value: 489660.35 },
      { name: "Visa", value: 362900.98 },
      { name: "Cash", value: 97698.25 },
      { name: "Amex", value: 80529.67 },
      { name: "Direct Bill", value: 47310.06 },
      { name: "Discover", value: 18833.6 },
      { name: "Other", value: 6489.13 },
      { name: "Check", value: 690.06 },
    ];
    render(<PieDonut data={data} type="donut" formatter={fmt} />);
    const label = pieProps().label;
    const total = data.reduce((a, d) => a + d.value, 0);

    const rows = data.map((d, i) => {
      const el = label({ ...d, percent: d.value / total, cx: 180, cy: 150, midAngle: midAngleOf(data, i), innerRadius: 40, outerRadius: 90 });
      expect(el).not.toBeNull(); // every slice still gets a callout
      const end = leaderEnd(el);
      return { name: d.name, y: end.y, side: end.x > 180 ? "right" : "left", lines: nameLinesOf(el).length };
    });

    // Within each column, consecutive label rows must be clearly separated.
    ["left", "right"].forEach((side) => {
      const ys = rows.filter((r) => r.side === side).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ys.length; i++) {
        expect(ys[i].y - ys[i - 1].y).toBeGreaterThan(8);
      }
    });
  });

  it("refuses to draw negative slices, and names what it left out", () => {
    // A payment method whose refunds exceed its charges nets negative. Recharts
    // would sweep that sector BACKWARDS over its neighbours and — because the
    // negative shrinks the total — silently inflate every other slice's
    // percentage. So it is excluded from the ring and called out in words.
    const data = [
      { name: "Visa", value: 1000 },
      { name: "Cash", value: 500 },
      { name: "Direct Bill", value: -250 },
    ];
    render(<PieDonut data={data} type="donut" formatter={fmt} />);

    // Only the two drawable slices reach the pie.
    expect(pieProps().data.map((d) => d.name)).toEqual(["Visa", "Cash"]);
    // Percentages are of the drawable total (1500), NOT of 1250.
    expect(screen.getAllByText("66.7%").length).toBeGreaterThanOrEqual(1);
    // The excluded method is named with its amount, not silently dropped.
    expect(screen.getByText(/Not shown in the ring/i).textContent).toContain("Direct Bill");
    expect(screen.getByText(/Not shown in the ring/i).textContent).toContain("-$250");
  });

  it("explains an all-negative period instead of rendering an empty ring", () => {
    render(<PieDonut data={[{ name: "Refunds", value: -900 }]} formatter={fmt} />);
    expect(screen.getByText(/No data to visualise/i)).toBeInTheDocument();
    expect(screen.getByText(/negative \(net refunds\)/i)).toBeInTheDocument();
  });

  it("renders a BOLD donut ring: 30% hole by default with a 16px floor on small boxes", () => {
    // Donut default: inner hole is 30% (string) at normal sizes.
    render(<PieDonut data={[{ name: "A", value: 100 }]} formatter={fmt} />);
    expect(pieProps().innerRadius).toBe("30%");

    // Pie (no ring) keeps a zero hole.
    render(<PieDonut data={[{ name: "A", value: 100 }]} type="pie" formatter={fmt} />);
    expect(pieProps().innerRadius).toBe(0);

    // Ring-thickness floor (unit-tested directly on the pure resolver):
    // 360×300 → ring = (46% − 30%) of min/2 = 24px ≥ 16 → keep the 30% ratio.
    expect(donutInnerFor(360, 300)).toBe("30%");
    // 200×150 → ring would be 12px < 16 → clamp inner so the ring stays 16px.
    expect(donutInnerFor(200, 150)).toBeCloseTo(0.46 * 75 - 16, 5);
    // No measurement yet (unmounted) → percentage fallback.
    expect(donutInnerFor(0, 0)).toBe("30%");

    // Callers can still pin an explicit inner radius.
    render(<PieDonut data={[{ name: "A", value: 100 }]} innerRadius={60} formatter={fmt} />);
    expect(pieProps().innerRadius).toBe(60);
  });

  it("centres the pie and labels FULL dollar amounts, trimming only a clean .00", () => {
    const single = [{ name: "Cash", value: 1_250_000 }];
    render(<PieDonut data={single} type="pie" formatter={fmt} />);
    const props = pieProps();
    // Pie centred so the left and right label columns have equal room.
    expect(props.cx).toBe("50%");
    const el = props.label({ name: "Cash", value: 1_250_000, percent: 1, cx: 180, cy: 150, midAngle: midAngleOf(single, 0), innerRadius: 40, outerRadius: 140 });
    const text = labelText(el);
    expect(text).toContain("$1,250,000"); // FULL amount, not "$1.25M"
    expect(text).not.toContain("1.25M"); // no K/M shorthand
    expect(text).toContain("100.0%");
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
      // At least one match each (labels also surface the same info, so >= 1).
      expect(screen.getAllByText(d.name).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(fmtTrim(d.value)).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(`${share}%`).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("buckets overflow slices into 'Other' so the legend never overflows", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `Cat${i}`, value: i + 1 }));
    const { container } = render(<PieDonut data={many} maxSlices={12} formatter={fmt} />);

    // pie gets 12 head slices + 1 "Other" bucket
    expect(pieProps().data.length).toBe(13);
    expect(screen.getAllByText("Other").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll("ul li").length).toBe(13);
    // every source value is still surfaced in the legend
    expect(screen.getAllByText(fmtTrim(many[0].value)).length).toBeGreaterThanOrEqual(1);
  });

  it("passes startAngle/endAngle through so the first slice starts at the top and the sweep is clockwise", () => {
    // startAngle=90 (12 o'clock) with endAngle=-270 (90-360) makes recharts sweep
    // clockwise: first data entry sits at the top, the rest follow clockwise.
    render(<PieDonut data={[{ name: "A", value: 1 }]} startAngle={90} endAngle={-270} />);
    expect(pieProps().startAngle).toBe(90);
    expect(pieProps().endAngle).toBe(-270);
  });

  it("reserves the full height for chart + legend so nothing is clipped (stays in box)", () => {
    const { container } = render(<PieDonut data={[{ name: "A", value: 1 }]} height={320} />);
    const wrapper = /** @type {HTMLElement} */ (container.firstChild);
    expect(wrapper.style.height).toBe("320px");
    expect(wrapper.querySelector("ul")).toBeTruthy(); // legend is in-flow, not clipped
  });
});
