import React from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, AreaChart, Area, Tooltip,
} from "recharts";
import { useReducedMotion } from "framer-motion";
import PieDonut from "@/components/charts/PieDonut";
import { C, money2 } from "@/lib/hotel";
import { DURATION } from "@/lib/motion";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 11 };

// Donuts need noticeably more room than a bar chart: every slice gets an
// outside callout (name + amount + %) in a left/right column, plus the legend
// below. In a 384px box the layout engine has to shrink the type and start
// dropping callouts, so pie/donut gets a taller default box.
const PIE_HEIGHT_CLASS = "h-[520px]";
const CARTESIAN_HEIGHT_CLASS = "h-96";

/**
 * @param {{ data?: any[]; type?: string; heightClass?: string }} props
 */
export default function UniversalChart({ data = [], type, heightClass = "" }) {
  const reduceMotion = useReducedMotion();
  if (!data.length) return <p className="text-sm text-slate-500">No data for this selection.</p>;
  const top = data.slice(0, 25);
  const isPie = type === "pie" || type === "donut";
  const box = heightClass || (isPie ? PIE_HEIGHT_CLASS : CARTESIAN_HEIGHT_CLASS);

  // recharts defaults to a 1500ms grow-from-zero, which is six times the house
  // ceiling and reads as a chart performing rather than a chart appearing. The
  // bars still grow — the motion is just brought onto the shared token.
  // Framer-motion's inline styles are not covered by the CSS reduced-motion
  // kill switch, and neither are these, so they are switched off explicitly.
  const anim = { isAnimationActive: !reduceMotion, animationDuration: DURATION.slow, animationEasing: /** @type {const} */ ("ease-out") };

  // PieDonut is NOT a recharts chart — it renders its own ResponsiveContainer
  // plus an in-flow legend. Nesting it inside a ResponsiveContainer made that
  // container clone width/height onto it and override its own sizing, so it is
  // branched out here and given the box directly.
  //
  // Deliberately NOT animated: the ring and its callout labels appear together
  // at final geometry. The entrance for a chart is the Card fading and rising
  // around it — animating the slices would mean the label layout engine laying
  // out against angles that are still moving.
  if (isPie) {
    return (
      <div className={box}>
        <PieDonut data={top} type={type} height="100%" formatter={money2} maxSlices={25} />
      </div>
    );
  }

  return (
    <div className={box}>
      <ResponsiveContainer width="100%" height="100%">
        {type === "hbar" ? (
          <BarChart data={top} layout="vertical" margin={{ left: 40, right: 16 }}>
            <CartesianGrid stroke="#ffffff0a" horizontal={false} />
            <XAxis type="number" tick={axis} stroke="#ffffff10" />
            <YAxis type="category" dataKey="name" tick={axis} width={130} stroke="#ffffff10" />
            <Tooltip contentStyle={tip} />
            <Bar dataKey="value" fill={C.cyan} radius={[0, 6, 6, 0]} {...anim} />
          </BarChart>
        ) : type === "line" ? (
          <AreaChart data={top} margin={{ left: -10, right: 8, top: 8 }}>
            <defs>
              <linearGradient id="uGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={C.green} stopOpacity={0.5} />
                <stop offset="100%" stopColor={C.green} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#ffffff0a" vertical={false} />
            <XAxis dataKey="name" tick={axis} stroke="#ffffff10" />
            <YAxis tick={axis} stroke="#ffffff10" />
            <Tooltip contentStyle={tip} />
            <Area type="monotone" dataKey="value" stroke={C.green} strokeWidth={2} fill="url(#uGrad)" {...anim} />
          </AreaChart>
        ) : (
          <BarChart data={top} margin={{ left: -10, right: 8, top: 8 }}>
            <CartesianGrid stroke="#ffffff0a" vertical={false} />
            <XAxis dataKey="name" tick={axis} stroke="#ffffff10" interval={0} angle={-25} textAnchor="end" height={70} />
            <YAxis tick={axis} stroke="#ffffff10" />
            <Tooltip contentStyle={tip} />
            <Bar dataKey="value" fill={C.purple} radius={[6, 6, 0, 0]} {...anim} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}