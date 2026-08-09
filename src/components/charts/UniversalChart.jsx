import React from "react";
import {
  ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, AreaChart, Area, Tooltip,
} from "recharts";
import PieDonut from "@/components/charts/PieDonut";
import { C, money2 } from "@/lib/hotel";

const tip = { background: "#0A1628", border: "1px solid #ffffff14", borderRadius: 12, color: "#e2e8f0" };
const axis = { fill: "#64748b", fontSize: 11 };

export default function UniversalChart({ data, type }) {
  if (!data.length) return <p className="text-sm text-slate-500">No data for this selection.</p>;
  const top = data.slice(0, 25);

  return (
    <div className="h-96">
      <ResponsiveContainer width="100%" height="100%">
        {type === "pie" || type === "donut" ? (
          <PieDonut data={top} type={type} height="100%" formatter={money2} maxSlices={25} />
        ) : type === "hbar" ? (
          <BarChart data={top} layout="vertical" margin={{ left: 40, right: 16 }}>
            <CartesianGrid stroke="#ffffff0a" horizontal={false} />
            <XAxis type="number" tick={axis} stroke="#ffffff10" />
            <YAxis type="category" dataKey="name" tick={axis} width={130} stroke="#ffffff10" />
            <Tooltip contentStyle={tip} />
            <Bar dataKey="value" fill={C.cyan} radius={[0, 6, 6, 0]} />
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
            <Area type="monotone" dataKey="value" stroke={C.green} strokeWidth={2} fill="url(#uGrad)" />
          </AreaChart>
        ) : (
          <BarChart data={top} margin={{ left: -10, right: 8, top: 8 }}>
            <CartesianGrid stroke="#ffffff0a" vertical={false} />
            <XAxis dataKey="name" tick={axis} stroke="#ffffff10" interval={0} angle={-25} textAnchor="end" height={70} />
            <YAxis tick={axis} stroke="#ffffff10" />
            <Tooltip contentStyle={tip} />
            <Bar dataKey="value" fill={C.purple} radius={[6, 6, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}