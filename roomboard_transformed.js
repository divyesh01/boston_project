import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/pages/RoomBoard.jsx");import __vite__cjsImport0_react_jsxDevRuntime from "/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=3a8a1f11"; const Fragment = __vite__cjsImport0_react_jsxDevRuntime["Fragment"]; const jsxDEV = __vite__cjsImport0_react_jsxDevRuntime["jsxDEV"];
import * as RefreshRuntime from "/@react-refresh";
const inWebWorker = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;
let prevRefreshReg;
let prevRefreshSig;
if (import.meta.hot && !inWebWorker) {
  if (!window.$RefreshReg$) {
    throw new Error(
      "@vitejs/plugin-react can't detect preamble. Something is wrong."
    );
  }
  prevRefreshReg = window.$RefreshReg$;
  prevRefreshSig = window.$RefreshSig$;
  window.$RefreshReg$ = RefreshRuntime.getRefreshReg("C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx");
  window.$RefreshSig$ = RefreshRuntime.createSignatureFunctionForTransform;
}
var _s = $RefreshSig$();
import __vite__cjsImport3_react from "/node_modules/.vite/deps/react.js?v=3a8a1f11"; const React = __vite__cjsImport3_react.__esModule ? __vite__cjsImport3_react.default : __vite__cjsImport3_react; const useMemo = __vite__cjsImport3_react["useMemo"];
import Card from "/src/components/ui-exec/Card.jsx";
import { useOccupancy } from "/src/lib/useHotelData.js";
import { C, num, pct, money, money2, avg, inventoryInScope, occupancyStats } from "/src/lib/hotel.js";
import { useGlobalFilters } from "/src/lib/useGlobalFilters.jsx";
export default function RoomBoard() {
  _s();
  const { dateRange, property, properties, months } = useGlobalFilters();
  const { data: occ = [], isLoading } = useOccupancy(dateRange, property, months);
  const isPortfolio = property === "all" || Array.isArray(property);
  const inventory = inventoryInScope(property, properties);
  const propName = isPortfolio ? Array.isArray(property) ? `${property.length} Properties` : "Portfolio" : properties.find((p) => p.id === property)?.name || "Property";
  const stats = useMemo(() => {
    if (!occ.length) {
      return { avgOccupied: 0, avgOoo: 0, avgVacant: 0, occupancy: 0, adr: 0, days: 0, downNights: 0, oooLoss: 0 };
    }
    const s = occupancyStats(occ, properties);
    const avgOccupied = Math.round(avg(occ, "rooms_sold"));
    const avgOoo = Math.round(avg(occ, "down_rooms"));
    const downNights = occ.reduce((a, r) => a + (Number(r.down_rooms) || 0), 0);
    return {
      avgOccupied,
      avgOoo,
      avgVacant: Math.max(0, inventory - avgOccupied - avgOoo),
      occupancy: s.occupancy,
      adr: s.adr,
      days: s.days,
      downNights,
      oooLoss: downNights * s.adr
    };
  }, [occ, properties, inventory]);
  if (isLoading) return /* @__PURE__ */ jsxDEV("p", { className: "text-slate-500", children: "Loading property board…" }, void 0, false, {
    fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
    lineNumber: 71,
    columnNumber: 25
  }, this);
  const mix = [
    ["Occupied", stats.avgOccupied, C.purple],
    ["Vacant", stats.avgVacant, C.green],
    ["Out of service", stats.avgOoo, C.coral]
  ].filter(([, v]) => Number(v) > 0);
  const mixTotal = mix.reduce((a, [, v]) => a + Number(v), 0) || 1;
  return /* @__PURE__ */ jsxDEV("div", { className: "space-y-6", children: [
    /* @__PURE__ */ jsxDEV("header", { children: [
      /* @__PURE__ */ jsxDEV("p", { className: "text-[11px] uppercase tracking-[0.3em] text-[#00D4FF]", children: "Module 4" }, void 0, false, {
        fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
        lineNumber: 83,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("h1", { className: "mt-2 font-heading text-3xl font-semibold text-white", children: "Room Utilisation" }, void 0, false, {
        fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
        lineNumber: 84,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV("p", { className: "mt-1 text-sm text-slate-400", children: [
        propName,
        " · ",
        inventory,
        " rooms · ",
        dateRange.from || "—",
        " → ",
        dateRange.to || "—",
        " · ",
        stats.days,
        " day average"
      ] }, void 0, true, {
        fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
        lineNumber: 85,
        columnNumber: 9
      }, this)
    ] }, void 0, true, {
      fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
      lineNumber: 82,
      columnNumber: 7
    }, this),
    !occ.length ? /* @__PURE__ */ jsxDEV(Card, { title: "No occupancy data in this period", children: /* @__PURE__ */ jsxDEV("p", { className: "text-sm text-slate-400", children: [
      "Import an Occupancy report for ",
      dateRange.from || "this range",
      " → ",
      dateRange.to || "",
      " to populate this page."
    ] }, void 0, true, {
      fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
      lineNumber: 92,
      columnNumber: 11
    }, this) }, void 0, false, {
      fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
      lineNumber: 91,
      columnNumber: 7
    }, this) : /* @__PURE__ */ jsxDEV(Fragment, { children: [
      /* @__PURE__ */ jsxDEV("div", { className: "grid gap-4 sm:grid-cols-3 lg:grid-cols-5", children: [
        ["Avg Occupied", num(stats.avgOccupied), C.purple],
        ["Avg Vacant", num(stats.avgVacant), C.green],
        ["Avg Out of Service", num(stats.avgOoo), C.coral],
        ["Occupancy", pct(stats.occupancy), C.cyan],
        ["ADR", money2(stats.adr), C.amber]
      ].map(
        ([label, value, color]) => /* @__PURE__ */ jsxDEV("div", { className: "rounded-2xl border border-white/5 bg-[#0F1F35]/80 p-4", children: [
          /* @__PURE__ */ jsxDEV("p", { className: "text-[11px] uppercase tracking-widest text-slate-400", children: label }, void 0, false, {
            fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
            lineNumber: 107,
            columnNumber: 17
          }, this),
          /* @__PURE__ */ jsxDEV("p", { className: "mt-2 font-heading text-2xl font-semibold", style: { color: String(color) }, children: value }, void 0, false, {
            fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
            lineNumber: 108,
            columnNumber: 17
          }, this)
        ] }, label, true, {
          fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
          lineNumber: 106,
          columnNumber: 11
        }, this)
      ) }, void 0, false, {
        fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
        lineNumber: 98,
        columnNumber: 11
      }, this),
      stats.downNights > 0 && /* @__PURE__ */ jsxDEV(Card, { title: "Revenue lost to out-of-service rooms", children: [
        /* @__PURE__ */ jsxDEV("p", { className: "text-sm text-slate-300", children: [
          /* @__PURE__ */ jsxDEV("span", { className: "font-heading text-2xl font-semibold", style: { color: C.coral }, children: money(stats.oooLoss) }, void 0, false, {
            fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
            lineNumber: 116,
            columnNumber: 17
          }, this),
          " ",
          "of room revenue was unavailable to sell across this period."
        ] }, void 0, true, {
          fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
          lineNumber: 115,
          columnNumber: 15
        }, this),
        /* @__PURE__ */ jsxDEV("p", { className: "mt-2 text-sm text-slate-400", children: [
          num(stats.downNights),
          " out-of-service room-night",
          stats.downNights === 1 ? "" : "s",
          " at the",
          " ",
          money2(stats.adr),
          " ADR actually achieved. Both figures come from the imported occupancy report — this is the revenue those rooms would have earned at your own average rate, not a forecast."
        ] }, void 0, true, {
          fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
          lineNumber: 121,
          columnNumber: 15
        }, this)
      ] }, void 0, true, {
        fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
        lineNumber: 114,
        columnNumber: 9
      }, this),
      /* @__PURE__ */ jsxDEV(
        Card,
        {
          title: `Average room mix · ${stats.days}-day average`,
          subtitle: "Share of physical inventory by state, averaged across the selected period",
          children: [
            /* @__PURE__ */ jsxDEV("div", { className: "flex h-8 w-full overflow-hidden rounded-lg", children: mix.map(
              ([label, value, color]) => /* @__PURE__ */ jsxDEV(
                "div",
                {
                  title: `${label}: ${value} rooms`,
                  className: "flex items-center justify-center text-[10px] font-medium text-white/90",
                  style: { width: `${Number(value) / mixTotal * 100}%`, background: `${color}66`, borderRight: "1px solid #0F1F35" },
                  children: Number(value) / mixTotal > 0.08 ? value : ""
                },
                label,
                false,
                {
                  fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
                  lineNumber: 135,
                  columnNumber: 13
                },
                this
              )
            ) }, void 0, false, {
              fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
              lineNumber: 133,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("div", { className: "mt-3 flex flex-wrap gap-4", children: mix.map(
              ([label, value, color]) => /* @__PURE__ */ jsxDEV("span", { className: "flex items-center gap-2 text-xs text-slate-400", children: [
                /* @__PURE__ */ jsxDEV("span", { className: "h-2.5 w-2.5 rounded-sm", style: { background: String(color) } }, void 0, false, {
                  fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
                  lineNumber: 148,
                  columnNumber: 19
                }, this),
                label,
                " · ",
                num(value),
                " (",
                pct(Number(value) / mixTotal),
                ")"
              ] }, label, true, {
                fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
                lineNumber: 147,
                columnNumber: 13
              }, this)
            ) }, void 0, false, {
              fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
              lineNumber: 145,
              columnNumber: 13
            }, this),
            /* @__PURE__ */ jsxDEV("p", { className: "mt-4 border-t border-white/5 pt-3 text-xs text-slate-500", children: [
              "The imported reports carry daily totals only, so this is an average mix across ",
              stats.days,
              " day",
              stats.days === 1 ? "" : "s",
              " — not a live per-room status. Which specific room is occupied, clean or out of service is not present in the data."
            ] }, void 0, true, {
              fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
              lineNumber: 153,
              columnNumber: 13
            }, this)
          ]
        },
        void 0,
        true,
        {
          fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
          lineNumber: 129,
          columnNumber: 11
        },
        this
      )
    ] }, void 0, true, {
      fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
      lineNumber: 97,
      columnNumber: 7
    }, this)
  ] }, void 0, true, {
    fileName: "C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx",
    lineNumber: 81,
    columnNumber: 5
  }, this);
}
_s(RoomBoard, "BpnnrRHud/ZOYDvty3kWeV13vcE=", false, function() {
  return [useGlobalFilters, useOccupancy];
});
_c = RoomBoard;
var _c;
$RefreshReg$(_c, "RoomBoard");
if (import.meta.hot && !inWebWorker) {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
}
if (import.meta.hot && !inWebWorker) {
  RefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => {
    RefreshRuntime.registerExportsForReactRefresh("C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx", currentExports);
    import.meta.hot.accept((nextExports) => {
      if (!nextExports) return;
      const invalidateMessage = RefreshRuntime.validateRefreshBoundaryAndEnqueueUpdate("C:/Users/divye/OneDrive/Desktop/boston_project/src/pages/RoomBoard.jsx", currentExports, nextExports);
      if (invalidateMessage) import.meta.hot.invalidate(invalidateMessage);
    });
  });
}

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJtYXBwaW5ncyI6IkFBbUR3QixTQTBCaEIsVUExQmdCOzs7Ozs7Ozs7Ozs7Ozs7OztBQW5EeEIsT0FBT0EsU0FBU0MsZUFBZTtBQUMvQixPQUFPQyxVQUFVO0FBQ2pCLFNBQVNDLG9CQUFvQjtBQUM3QixTQUFTQyxHQUFHQyxLQUFLQyxLQUFLQyxPQUFPQyxRQUFRQyxLQUFLQyxrQkFBa0JDLHNCQUFzQjtBQUNsRixTQUFTQyx3QkFBd0I7QUFjakMsd0JBQXdCQyxZQUFZO0FBQUFDLEtBQUE7QUFDbEMsUUFBTSxFQUFFQyxXQUFXQyxVQUFVQyxZQUFZQyxPQUFPLElBQUlOLGlCQUFpQjtBQUNyRSxRQUFNLEVBQUVPLE1BQU1DLE1BQU0sSUFBSUMsVUFBVSxJQUFJbEIsYUFBYVksV0FBV0MsVUFBVUUsTUFBTTtBQUU5RSxRQUFNSSxjQUFjTixhQUFhLFNBQVNPLE1BQU1DLFFBQVFSLFFBQVE7QUFDaEUsUUFBTVMsWUFBWWYsaUJBQWlCTSxVQUFVQyxVQUFVO0FBQ3ZELFFBQU1TLFdBQVdKLGNBQ1pDLE1BQU1DLFFBQVFSLFFBQVEsSUFBSSxHQUFHQSxTQUFTVyxNQUFNLGdCQUFnQixjQUM1RFYsV0FBV1csS0FBSyxDQUFDQyxNQUFNQSxFQUFFQyxPQUFPZCxRQUFRLEdBQUdlLFFBQVE7QUFFeEQsUUFBTUMsUUFBUS9CLFFBQVEsTUFBTTtBQUMxQixRQUFJLENBQUNtQixJQUFJTyxRQUFRO0FBQ2YsYUFBTyxFQUFFTSxhQUFhLEdBQUdDLFFBQVEsR0FBR0MsV0FBVyxHQUFHQyxXQUFXLEdBQUdDLEtBQUssR0FBR0MsTUFBTSxHQUFHQyxZQUFZLEdBQUdDLFNBQVMsRUFBRTtBQUFBLElBQzdHO0FBQ0EsVUFBTUMsSUFBSTlCLGVBQWVTLEtBQUtILFVBQVU7QUFDeEMsVUFBTWdCLGNBQWNTLEtBQUtDLE1BQU1sQyxJQUFJVyxLQUFLLFlBQVksQ0FBQztBQUNyRCxVQUFNYyxTQUFTUSxLQUFLQyxNQUFNbEMsSUFBSVcsS0FBSyxZQUFZLENBQUM7QUFJaEQsVUFBTW1CLGFBQWFuQixJQUFJd0IsT0FBTyxDQUFDQyxHQUFHQyxNQUFNRCxLQUFLRSxPQUFPRCxFQUFFRSxVQUFVLEtBQUssSUFBSSxDQUFDO0FBQzFFLFdBQU87QUFBQSxNQUNMZjtBQUFBQSxNQUNBQztBQUFBQSxNQUNBQyxXQUFXTyxLQUFLTyxJQUFJLEdBQUd4QixZQUFZUSxjQUFjQyxNQUFNO0FBQUEsTUFDdkRFLFdBQVdLLEVBQUVMO0FBQUFBLE1BQ2JDLEtBQUtJLEVBQUVKO0FBQUFBLE1BQ1BDLE1BQU1HLEVBQUVIO0FBQUFBLE1BQ1JDO0FBQUFBLE1BQ0FDLFNBQVNELGFBQWFFLEVBQUVKO0FBQUFBLElBQzFCO0FBQUEsRUFDRixHQUFHLENBQUNqQixLQUFLSCxZQUFZUSxTQUFTLENBQUM7QUFFL0IsTUFBSUosVUFBVyxRQUFPLHVCQUFDLE9BQUUsV0FBVSxrQkFBaUIsdUNBQTlCO0FBQUE7QUFBQTtBQUFBO0FBQUEsU0FBcUQ7QUFFM0UsUUFBTTZCLE1BQU07QUFBQSxJQUNWLENBQUMsWUFBWWxCLE1BQU1DLGFBQWE3QixFQUFFK0MsTUFBTTtBQUFBLElBQ3hDLENBQUMsVUFBVW5CLE1BQU1HLFdBQVcvQixFQUFFZ0QsS0FBSztBQUFBLElBQ25DLENBQUMsa0JBQWtCcEIsTUFBTUUsUUFBUTlCLEVBQUVpRCxLQUFLO0FBQUEsRUFBQyxFQUN6Q0MsT0FBTyxDQUFDLEdBQUdDLENBQUMsTUFBTVIsT0FBT1EsQ0FBQyxJQUFJLENBQUM7QUFDakMsUUFBTUMsV0FBV04sSUFBSU4sT0FBTyxDQUFDQyxHQUFHLEdBQUdVLENBQUMsTUFBTVYsSUFBSUUsT0FBT1EsQ0FBQyxHQUFHLENBQUMsS0FBSztBQUUvRCxTQUNFLHVCQUFDLFNBQUksV0FBVSxhQUNiO0FBQUEsMkJBQUMsWUFDQztBQUFBLDZCQUFDLE9BQUUsV0FBVSx5REFBd0Qsd0JBQXJFO0FBQUE7QUFBQTtBQUFBO0FBQUEsYUFBNkU7QUFBQSxNQUM3RSx1QkFBQyxRQUFHLFdBQVUsdURBQXNELGdDQUFwRTtBQUFBO0FBQUE7QUFBQTtBQUFBLGFBQW9GO0FBQUEsTUFDcEYsdUJBQUMsT0FBRSxXQUFVLCtCQUNWN0I7QUFBQUE7QUFBQUEsUUFBUztBQUFBLFFBQUlEO0FBQUFBLFFBQVU7QUFBQSxRQUFVVixVQUFVMEMsUUFBUTtBQUFBLFFBQUk7QUFBQSxRQUFJMUMsVUFBVTJDLE1BQU07QUFBQSxRQUFJO0FBQUEsUUFBSTFCLE1BQU1NO0FBQUFBLFFBQUs7QUFBQSxXQURqRztBQUFBO0FBQUE7QUFBQTtBQUFBLGFBRUE7QUFBQSxTQUxGO0FBQUE7QUFBQTtBQUFBO0FBQUEsV0FNQTtBQUFBLElBRUMsQ0FBQ2xCLElBQUlPLFNBQ0osdUJBQUMsUUFBSyxPQUFNLG9DQUNWLGlDQUFDLE9BQUUsV0FBVSwwQkFBd0I7QUFBQTtBQUFBLE1BQ0haLFVBQVUwQyxRQUFRO0FBQUEsTUFBYTtBQUFBLE1BQUkxQyxVQUFVMkMsTUFBTTtBQUFBLE1BQUc7QUFBQSxTQUR4RjtBQUFBO0FBQUE7QUFBQTtBQUFBLFdBRUEsS0FIRjtBQUFBO0FBQUE7QUFBQTtBQUFBLFdBSUEsSUFFQSxtQ0FDRTtBQUFBLDZCQUFDLFNBQUksV0FBVSw0Q0FDWjtBQUFBLFFBQ0MsQ0FBQyxnQkFBZ0JyRCxJQUFJMkIsTUFBTUMsV0FBVyxHQUFHN0IsRUFBRStDLE1BQU07QUFBQSxRQUNqRCxDQUFDLGNBQWM5QyxJQUFJMkIsTUFBTUcsU0FBUyxHQUFHL0IsRUFBRWdELEtBQUs7QUFBQSxRQUM1QyxDQUFDLHNCQUFzQi9DLElBQUkyQixNQUFNRSxNQUFNLEdBQUc5QixFQUFFaUQsS0FBSztBQUFBLFFBQ2pELENBQUMsYUFBYS9DLElBQUkwQixNQUFNSSxTQUFTLEdBQUdoQyxFQUFFdUQsSUFBSTtBQUFBLFFBQzFDLENBQUMsT0FBT25ELE9BQU93QixNQUFNSyxHQUFHLEdBQUdqQyxFQUFFd0QsS0FBSztBQUFBLE1BQUMsRUFDbkNDO0FBQUFBLFFBQUksQ0FBQyxDQUFDQyxPQUFPQyxPQUFPQyxLQUFLLE1BQ3pCLHVCQUFDLFNBQWdCLFdBQVUseURBQ3pCO0FBQUEsaUNBQUMsT0FBRSxXQUFVLHdEQUF3REYsbUJBQXJFO0FBQUE7QUFBQTtBQUFBO0FBQUEsaUJBQTJFO0FBQUEsVUFDM0UsdUJBQUMsT0FBRSxXQUFVLDRDQUEyQyxPQUFPLEVBQUVFLE9BQU9DLE9BQU9ELEtBQUssRUFBRSxHQUFJRCxtQkFBMUY7QUFBQTtBQUFBO0FBQUE7QUFBQSxpQkFBZ0c7QUFBQSxhQUZ4RkQsT0FBVjtBQUFBO0FBQUE7QUFBQTtBQUFBLGVBR0E7QUFBQSxNQUNELEtBWkg7QUFBQTtBQUFBO0FBQUE7QUFBQSxhQWFBO0FBQUEsTUFFQzlCLE1BQU1PLGFBQWEsS0FDbEIsdUJBQUMsUUFBSyxPQUFNLHdDQUNWO0FBQUEsK0JBQUMsT0FBRSxXQUFVLDBCQUNYO0FBQUEsaUNBQUMsVUFBSyxXQUFVLHVDQUFzQyxPQUFPLEVBQUV5QixPQUFPNUQsRUFBRWlELE1BQU0sR0FDM0U5QyxnQkFBTXlCLE1BQU1RLE9BQU8sS0FEdEI7QUFBQTtBQUFBO0FBQUE7QUFBQSxpQkFFQTtBQUFBLFVBQVE7QUFBQSxVQUFHO0FBQUEsYUFIYjtBQUFBO0FBQUE7QUFBQTtBQUFBLGVBS0E7QUFBQSxRQUNBLHVCQUFDLE9BQUUsV0FBVSwrQkFDVm5DO0FBQUFBLGNBQUkyQixNQUFNTyxVQUFVO0FBQUEsVUFBRTtBQUFBLFVBQTJCUCxNQUFNTyxlQUFlLElBQUksS0FBSztBQUFBLFVBQUk7QUFBQSxVQUFRO0FBQUEsVUFDM0YvQixPQUFPd0IsTUFBTUssR0FBRztBQUFBLFVBQUU7QUFBQSxhQUZyQjtBQUFBO0FBQUE7QUFBQTtBQUFBLGVBSUE7QUFBQSxXQVhGO0FBQUE7QUFBQTtBQUFBO0FBQUEsYUFZQTtBQUFBLE1BR0Y7QUFBQSxRQUFDO0FBQUE7QUFBQSxVQUNDLE9BQU8sc0JBQXNCTCxNQUFNTSxJQUFJO0FBQUEsVUFDdkMsVUFBUztBQUFBLFVBRVQ7QUFBQSxtQ0FBQyxTQUFJLFdBQVUsOENBQ1pZLGNBQUlXO0FBQUFBLGNBQUksQ0FBQyxDQUFDQyxPQUFPQyxPQUFPQyxLQUFLLE1BQzVCO0FBQUEsZ0JBQUM7QUFBQTtBQUFBLGtCQUVDLE9BQU8sR0FBR0YsS0FBSyxLQUFLQyxLQUFLO0FBQUEsa0JBQ3pCLFdBQVU7QUFBQSxrQkFDVixPQUFPLEVBQUVHLE9BQU8sR0FBSW5CLE9BQU9nQixLQUFLLElBQUlQLFdBQVksR0FBRyxLQUFLVyxZQUFZLEdBQUdILEtBQUssTUFBTUksYUFBYSxvQkFBb0I7QUFBQSxrQkFFakhyQixpQkFBT2dCLEtBQUssSUFBSVAsV0FBWSxPQUFPTyxRQUFRO0FBQUE7QUFBQSxnQkFMeENEO0FBQUFBLGdCQURQO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsY0FPQTtBQUFBLFlBQ0QsS0FWSDtBQUFBO0FBQUE7QUFBQTtBQUFBLG1CQVdBO0FBQUEsWUFDQSx1QkFBQyxTQUFJLFdBQVUsNkJBQ1paLGNBQUlXO0FBQUFBLGNBQUksQ0FBQyxDQUFDQyxPQUFPQyxPQUFPQyxLQUFLLE1BQzVCLHVCQUFDLFVBQWlCLFdBQVUsa0RBQzFCO0FBQUEsdUNBQUMsVUFBSyxXQUFVLDBCQUF5QixPQUFPLEVBQUVHLFlBQVlGLE9BQU9ELEtBQUssRUFBRSxLQUE1RTtBQUFBO0FBQUE7QUFBQTtBQUFBLHVCQUE4RTtBQUFBLGdCQUM3RUY7QUFBQUEsZ0JBQU07QUFBQSxnQkFBSXpELElBQUkwRCxLQUFLO0FBQUEsZ0JBQUU7QUFBQSxnQkFBR3pELElBQUl5QyxPQUFPZ0IsS0FBSyxJQUFJUCxRQUFRO0FBQUEsZ0JBQUU7QUFBQSxtQkFGOUNNLE9BQVg7QUFBQTtBQUFBO0FBQUE7QUFBQSxxQkFHQTtBQUFBLFlBQ0QsS0FOSDtBQUFBO0FBQUE7QUFBQTtBQUFBLG1CQU9BO0FBQUEsWUFDQSx1QkFBQyxPQUFFLFdBQVUsNERBQTBEO0FBQUE7QUFBQSxjQUNXOUIsTUFBTU07QUFBQUEsY0FBSztBQUFBLGNBQzFGTixNQUFNTSxTQUFTLElBQUksS0FBSztBQUFBLGNBQUk7QUFBQSxpQkFGL0I7QUFBQTtBQUFBO0FBQUE7QUFBQSxtQkFJQTtBQUFBO0FBQUE7QUFBQSxRQTVCRjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUE2QkE7QUFBQSxTQTdERjtBQUFBO0FBQUE7QUFBQTtBQUFBLFdBOERBO0FBQUEsT0E5RUo7QUFBQTtBQUFBO0FBQUE7QUFBQSxTQWdGQTtBQUVKO0FBQUN4QixHQTdIdUJELFdBQVM7QUFBQSxVQUNxQkQsa0JBQ2RULFlBQVk7QUFBQTtBQUFBLEtBRjVCVTtBQUFTLElBQUF3RDtBQUFBLGFBQUFBLElBQUEiLCJuYW1lcyI6WyJSZWFjdCIsInVzZU1lbW8iLCJDYXJkIiwidXNlT2NjdXBhbmN5IiwiQyIsIm51bSIsInBjdCIsIm1vbmV5IiwibW9uZXkyIiwiYXZnIiwiaW52ZW50b3J5SW5TY29wZSIsIm9jY3VwYW5jeVN0YXRzIiwidXNlR2xvYmFsRmlsdGVycyIsIlJvb21Cb2FyZCIsIl9zIiwiZGF0ZVJhbmdlIiwicHJvcGVydHkiLCJwcm9wZXJ0aWVzIiwibW9udGhzIiwiZGF0YSIsIm9jYyIsImlzTG9hZGluZyIsImlzUG9ydGZvbGlvIiwiQXJyYXkiLCJpc0FycmF5IiwiaW52ZW50b3J5IiwicHJvcE5hbWUiLCJsZW5ndGgiLCJmaW5kIiwicCIsImlkIiwibmFtZSIsInN0YXRzIiwiYXZnT2NjdXBpZWQiLCJhdmdPb28iLCJhdmdWYWNhbnQiLCJvY2N1cGFuY3kiLCJhZHIiLCJkYXlzIiwiZG93bk5pZ2h0cyIsIm9vb0xvc3MiLCJzIiwiTWF0aCIsInJvdW5kIiwicmVkdWNlIiwiYSIsInIiLCJOdW1iZXIiLCJkb3duX3Jvb21zIiwibWF4IiwibWl4IiwicHVycGxlIiwiZ3JlZW4iLCJjb3JhbCIsImZpbHRlciIsInYiLCJtaXhUb3RhbCIsImZyb20iLCJ0byIsImN5YW4iLCJhbWJlciIsIm1hcCIsImxhYmVsIiwidmFsdWUiLCJjb2xvciIsIlN0cmluZyIsIndpZHRoIiwiYmFja2dyb3VuZCIsImJvcmRlclJpZ2h0IiwiX2MiXSwiaWdub3JlTGlzdCI6W10sInNvdXJjZXMiOlsiUm9vbUJvYXJkLmpzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QsIHsgdXNlTWVtbyB9IGZyb20gXCJyZWFjdFwiO1xuaW1wb3J0IENhcmQgZnJvbSBcIkAvY29tcG9uZW50cy91aS1leGVjL0NhcmRcIjtcbmltcG9ydCB7IHVzZU9jY3VwYW5jeSB9IGZyb20gXCJAL2xpYi91c2VIb3RlbERhdGFcIjtcbmltcG9ydCB7IEMsIG51bSwgcGN0LCBtb25leSwgbW9uZXkyLCBhdmcsIGludmVudG9yeUluU2NvcGUsIG9jY3VwYW5jeVN0YXRzIH0gZnJvbSBcIkAvbGliL2hvdGVsXCI7XG5pbXBvcnQgeyB1c2VHbG9iYWxGaWx0ZXJzIH0gZnJvbSBcIkAvbGliL3VzZUdsb2JhbEZpbHRlcnNcIjtcblxuLy8gTk9URSBPTiBXSEFUIFRISVMgUEFHRSBDQU4gQU5EIENBTk5PVCBTSE9XLlxuLy9cbi8vIFRoZSBpbXBvcnRlZCBkYXRhIGlzIGRhaWx5IGFnZ3JlZ2F0ZXM6IHJvb21zX3NvbGQsIGRvd25fcm9vbXMsIG9jY3VwYW5jeSBhbmRcbi8vIHJldmVudWUgcGVyIGJ1c2luZXNzIGRhdGUuIFRoZXJlIGlzIG5vIHBlci1yb29tIHJlY29yZCBhbnl3aGVyZSBpbiB0aGUgc2NoZW1hLFxuLy8gc28gYSBsaXZlIGhvdXNla2VlcGluZyBib2FyZCAocm9vbSAyMTQgPSBkaXJ0eSkgaXMgbm90IGRlcml2YWJsZS5cbi8vXG4vLyBUaGlzIHBhZ2UgdXNlZCB0byByZW5kZXIgYSBudW1iZXJlZCBncmlkIG9mIGBwcm9wUm9vbXNgIHRpbGVzIGFuZCBjb2xvdXIgdGhlbVxuLy8gYnkgYXJyYXkgaW5kZXgg4oCUIHJvb21zIDEuLmF2Z09jY3VwaWVkIFwib2NjdXBpZWRcIiwgdGhlIG5leHQgYmxvY2sgXCJ2YWNhbnRcIiwgdGhlXG4vLyByZW1haW5kZXIgXCJvdXQgb2Ygb3JkZXJcIi4gVGhhdCBsb29rZWQgZXhhY3RseSBsaWtlIGEgcmVhbCByb29tLXN0YXR1cyBib2FyZFxuLy8gYW5kIHdhcyBwdXJlIGRlY29yYXRpb246IHJvb20gbnVtYmVycyB3ZXJlIHBvc2l0aW9uYWwsIG5vdCBhY3R1YWwuIEl0IGhhcyBiZWVuXG4vLyByZXBsYWNlZCB3aXRoIGEgcHJvcG9ydGlvbmFsIG1peCBiYXIgcGx1cyBhbiBleHBsaWNpdCBzdGF0ZW1lbnQgb2Ygd2hhdCB0aGVcbi8vIGRhdGEgZG9lcyBhbmQgZG9lcyBub3QgY292ZXIuXG5leHBvcnQgZGVmYXVsdCBmdW5jdGlvbiBSb29tQm9hcmQoKSB7XG4gIGNvbnN0IHsgZGF0ZVJhbmdlLCBwcm9wZXJ0eSwgcHJvcGVydGllcywgbW9udGhzIH0gPSB1c2VHbG9iYWxGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgZGF0YTogb2NjID0gW10sIGlzTG9hZGluZyB9ID0gdXNlT2NjdXBhbmN5KGRhdGVSYW5nZSwgcHJvcGVydHksIG1vbnRocyk7XG5cbiAgY29uc3QgaXNQb3J0Zm9saW8gPSBwcm9wZXJ0eSA9PT0gXCJhbGxcIiB8fCBBcnJheS5pc0FycmF5KHByb3BlcnR5KTtcbiAgY29uc3QgaW52ZW50b3J5ID0gaW52ZW50b3J5SW5TY29wZShwcm9wZXJ0eSwgcHJvcGVydGllcyk7XG4gIGNvbnN0IHByb3BOYW1lID0gaXNQb3J0Zm9saW9cbiAgICA/IChBcnJheS5pc0FycmF5KHByb3BlcnR5KSA/IGAke3Byb3BlcnR5Lmxlbmd0aH0gUHJvcGVydGllc2AgOiBcIlBvcnRmb2xpb1wiKVxuICAgIDogKHByb3BlcnRpZXMuZmluZCgocCkgPT4gcC5pZCA9PT0gcHJvcGVydHkpPy5uYW1lIHx8IFwiUHJvcGVydHlcIik7XG5cbiAgY29uc3Qgc3RhdHMgPSB1c2VNZW1vKCgpID0+IHtcbiAgICBpZiAoIW9jYy5sZW5ndGgpIHtcbiAgICAgIHJldHVybiB7IGF2Z09jY3VwaWVkOiAwLCBhdmdPb286IDAsIGF2Z1ZhY2FudDogMCwgb2NjdXBhbmN5OiAwLCBhZHI6IDAsIGRheXM6IDAsIGRvd25OaWdodHM6IDAsIG9vb0xvc3M6IDAgfTtcbiAgICB9XG4gICAgY29uc3QgcyA9IG9jY3VwYW5jeVN0YXRzKG9jYywgcHJvcGVydGllcyk7XG4gICAgY29uc3QgYXZnT2NjdXBpZWQgPSBNYXRoLnJvdW5kKGF2ZyhvY2MsIFwicm9vbXNfc29sZFwiKSk7XG4gICAgY29uc3QgYXZnT29vID0gTWF0aC5yb3VuZChhdmcob2NjLCBcImRvd25fcm9vbXNcIikpO1xuICAgIC8vIE91dC1vZi1zZXJ2aWNlIHJvb20tbmlnaHRzIGFjcm9zcyB0aGUgcGVyaW9kLCBhbmQgdGhlIHJldmVudWUgdGhleSBjb3VsZFxuICAgIC8vIGhhdmUgZWFybmVkIGF0IHRoZSBBRFIgYWN0dWFsbHkgYWNoaWV2ZWQuIEJvdGggc2lkZXMgYXJlIHJlYWwgaW1wb3J0ZWRcbiAgICAvLyBmaWd1cmVzIOKAlCBubyBhc3N1bWVkIGNhcHR1cmUgcmF0ZS5cbiAgICBjb25zdCBkb3duTmlnaHRzID0gb2NjLnJlZHVjZSgoYSwgcikgPT4gYSArIChOdW1iZXIoci5kb3duX3Jvb21zKSB8fCAwKSwgMCk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGF2Z09jY3VwaWVkLFxuICAgICAgYXZnT29vLFxuICAgICAgYXZnVmFjYW50OiBNYXRoLm1heCgwLCBpbnZlbnRvcnkgLSBhdmdPY2N1cGllZCAtIGF2Z09vbyksXG4gICAgICBvY2N1cGFuY3k6IHMub2NjdXBhbmN5LFxuICAgICAgYWRyOiBzLmFkcixcbiAgICAgIGRheXM6IHMuZGF5cyxcbiAgICAgIGRvd25OaWdodHMsXG4gICAgICBvb29Mb3NzOiBkb3duTmlnaHRzICogcy5hZHIsXG4gICAgfTtcbiAgfSwgW29jYywgcHJvcGVydGllcywgaW52ZW50b3J5XSk7XG5cbiAgaWYgKGlzTG9hZGluZykgcmV0dXJuIDxwIGNsYXNzTmFtZT1cInRleHQtc2xhdGUtNTAwXCI+TG9hZGluZyBwcm9wZXJ0eSBib2FyZOKApjwvcD47XG5cbiAgY29uc3QgbWl4ID0gW1xuICAgIFtcIk9jY3VwaWVkXCIsIHN0YXRzLmF2Z09jY3VwaWVkLCBDLnB1cnBsZV0sXG4gICAgW1wiVmFjYW50XCIsIHN0YXRzLmF2Z1ZhY2FudCwgQy5ncmVlbl0sXG4gICAgW1wiT3V0IG9mIHNlcnZpY2VcIiwgc3RhdHMuYXZnT29vLCBDLmNvcmFsXSxcbiAgXS5maWx0ZXIoKFssIHZdKSA9PiBOdW1iZXIodikgPiAwKTtcbiAgY29uc3QgbWl4VG90YWwgPSBtaXgucmVkdWNlKChhLCBbLCB2XSkgPT4gYSArIE51bWJlcih2KSwgMCkgfHwgMTtcblxuICByZXR1cm4gKFxuICAgIDxkaXYgY2xhc3NOYW1lPVwic3BhY2UteS02XCI+XG4gICAgICA8aGVhZGVyPlxuICAgICAgICA8cCBjbGFzc05hbWU9XCJ0ZXh0LVsxMXB4XSB1cHBlcmNhc2UgdHJhY2tpbmctWzAuM2VtXSB0ZXh0LVsjMDBENEZGXVwiPk1vZHVsZSA0PC9wPlxuICAgICAgICA8aDEgY2xhc3NOYW1lPVwibXQtMiBmb250LWhlYWRpbmcgdGV4dC0zeGwgZm9udC1zZW1pYm9sZCB0ZXh0LXdoaXRlXCI+Um9vbSBVdGlsaXNhdGlvbjwvaDE+XG4gICAgICAgIDxwIGNsYXNzTmFtZT1cIm10LTEgdGV4dC1zbSB0ZXh0LXNsYXRlLTQwMFwiPlxuICAgICAgICAgIHtwcm9wTmFtZX0gwrcge2ludmVudG9yeX0gcm9vbXMgwrcge2RhdGVSYW5nZS5mcm9tIHx8IFwi4oCUXCJ9IOKGkiB7ZGF0ZVJhbmdlLnRvIHx8IFwi4oCUXCJ9IMK3IHtzdGF0cy5kYXlzfSBkYXkgYXZlcmFnZVxuICAgICAgICA8L3A+XG4gICAgICA8L2hlYWRlcj5cblxuICAgICAgeyFvY2MubGVuZ3RoID8gKFxuICAgICAgICA8Q2FyZCB0aXRsZT1cIk5vIG9jY3VwYW5jeSBkYXRhIGluIHRoaXMgcGVyaW9kXCI+XG4gICAgICAgICAgPHAgY2xhc3NOYW1lPVwidGV4dC1zbSB0ZXh0LXNsYXRlLTQwMFwiPlxuICAgICAgICAgICAgSW1wb3J0IGFuIE9jY3VwYW5jeSByZXBvcnQgZm9yIHtkYXRlUmFuZ2UuZnJvbSB8fCBcInRoaXMgcmFuZ2VcIn0g4oaSIHtkYXRlUmFuZ2UudG8gfHwgXCJcIn0gdG8gcG9wdWxhdGUgdGhpcyBwYWdlLlxuICAgICAgICAgIDwvcD5cbiAgICAgICAgPC9DYXJkPlxuICAgICAgKSA6IChcbiAgICAgICAgPD5cbiAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cImdyaWQgZ2FwLTQgc206Z3JpZC1jb2xzLTMgbGc6Z3JpZC1jb2xzLTVcIj5cbiAgICAgICAgICAgIHtbXG4gICAgICAgICAgICAgIFtcIkF2ZyBPY2N1cGllZFwiLCBudW0oc3RhdHMuYXZnT2NjdXBpZWQpLCBDLnB1cnBsZV0sXG4gICAgICAgICAgICAgIFtcIkF2ZyBWYWNhbnRcIiwgbnVtKHN0YXRzLmF2Z1ZhY2FudCksIEMuZ3JlZW5dLFxuICAgICAgICAgICAgICBbXCJBdmcgT3V0IG9mIFNlcnZpY2VcIiwgbnVtKHN0YXRzLmF2Z09vbyksIEMuY29yYWxdLFxuICAgICAgICAgICAgICBbXCJPY2N1cGFuY3lcIiwgcGN0KHN0YXRzLm9jY3VwYW5jeSksIEMuY3lhbl0sXG4gICAgICAgICAgICAgIFtcIkFEUlwiLCBtb25leTIoc3RhdHMuYWRyKSwgQy5hbWJlcl0sXG4gICAgICAgICAgICBdLm1hcCgoW2xhYmVsLCB2YWx1ZSwgY29sb3JdKSA9PiAoXG4gICAgICAgICAgICAgIDxkaXYga2V5PXtsYWJlbH0gY2xhc3NOYW1lPVwicm91bmRlZC0yeGwgYm9yZGVyIGJvcmRlci13aGl0ZS81IGJnLVsjMEYxRjM1XS84MCBwLTRcIj5cbiAgICAgICAgICAgICAgICA8cCBjbGFzc05hbWU9XCJ0ZXh0LVsxMXB4XSB1cHBlcmNhc2UgdHJhY2tpbmctd2lkZXN0IHRleHQtc2xhdGUtNDAwXCI+e2xhYmVsfTwvcD5cbiAgICAgICAgICAgICAgICA8cCBjbGFzc05hbWU9XCJtdC0yIGZvbnQtaGVhZGluZyB0ZXh0LTJ4bCBmb250LXNlbWlib2xkXCIgc3R5bGU9e3sgY29sb3I6IFN0cmluZyhjb2xvcikgfX0+e3ZhbHVlfTwvcD5cbiAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICApKX1cbiAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgIHtzdGF0cy5kb3duTmlnaHRzID4gMCAmJiAoXG4gICAgICAgICAgICA8Q2FyZCB0aXRsZT1cIlJldmVudWUgbG9zdCB0byBvdXQtb2Ytc2VydmljZSByb29tc1wiPlxuICAgICAgICAgICAgICA8cCBjbGFzc05hbWU9XCJ0ZXh0LXNtIHRleHQtc2xhdGUtMzAwXCI+XG4gICAgICAgICAgICAgICAgPHNwYW4gY2xhc3NOYW1lPVwiZm9udC1oZWFkaW5nIHRleHQtMnhsIGZvbnQtc2VtaWJvbGRcIiBzdHlsZT17eyBjb2xvcjogQy5jb3JhbCB9fT5cbiAgICAgICAgICAgICAgICAgIHttb25leShzdGF0cy5vb29Mb3NzKX1cbiAgICAgICAgICAgICAgICA8L3NwYW4+e1wiIFwifVxuICAgICAgICAgICAgICAgIG9mIHJvb20gcmV2ZW51ZSB3YXMgdW5hdmFpbGFibGUgdG8gc2VsbCBhY3Jvc3MgdGhpcyBwZXJpb2QuXG4gICAgICAgICAgICAgIDwvcD5cbiAgICAgICAgICAgICAgPHAgY2xhc3NOYW1lPVwibXQtMiB0ZXh0LXNtIHRleHQtc2xhdGUtNDAwXCI+XG4gICAgICAgICAgICAgICAge251bShzdGF0cy5kb3duTmlnaHRzKX0gb3V0LW9mLXNlcnZpY2Ugcm9vbS1uaWdodHtzdGF0cy5kb3duTmlnaHRzID09PSAxID8gXCJcIiA6IFwic1wifSBhdCB0aGV7XCIgXCJ9XG4gICAgICAgICAgICAgICAge21vbmV5MihzdGF0cy5hZHIpfSBBRFIgYWN0dWFsbHkgYWNoaWV2ZWQuIEJvdGggZmlndXJlcyBjb21lIGZyb20gdGhlIGltcG9ydGVkIG9jY3VwYW5jeSByZXBvcnQg4oCUXG4gICAgICAgICAgICAgICAgdGhpcyBpcyB0aGUgcmV2ZW51ZSB0aG9zZSByb29tcyB3b3VsZCBoYXZlIGVhcm5lZCBhdCB5b3VyIG93biBhdmVyYWdlIHJhdGUsIG5vdCBhIGZvcmVjYXN0LlxuICAgICAgICAgICAgICA8L3A+XG4gICAgICAgICAgICA8L0NhcmQ+XG4gICAgICAgICAgKX1cblxuICAgICAgICAgIDxDYXJkXG4gICAgICAgICAgICB0aXRsZT17YEF2ZXJhZ2Ugcm9vbSBtaXggwrcgJHtzdGF0cy5kYXlzfS1kYXkgYXZlcmFnZWB9XG4gICAgICAgICAgICBzdWJ0aXRsZT1cIlNoYXJlIG9mIHBoeXNpY2FsIGludmVudG9yeSBieSBzdGF0ZSwgYXZlcmFnZWQgYWNyb3NzIHRoZSBzZWxlY3RlZCBwZXJpb2RcIlxuICAgICAgICAgID5cbiAgICAgICAgICAgIDxkaXYgY2xhc3NOYW1lPVwiZmxleCBoLTggdy1mdWxsIG92ZXJmbG93LWhpZGRlbiByb3VuZGVkLWxnXCI+XG4gICAgICAgICAgICAgIHttaXgubWFwKChbbGFiZWwsIHZhbHVlLCBjb2xvcl0pID0+IChcbiAgICAgICAgICAgICAgICA8ZGl2XG4gICAgICAgICAgICAgICAgICBrZXk9e2xhYmVsfVxuICAgICAgICAgICAgICAgICAgdGl0bGU9e2Ake2xhYmVsfTogJHt2YWx1ZX0gcm9vbXNgfVxuICAgICAgICAgICAgICAgICAgY2xhc3NOYW1lPVwiZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1bMTBweF0gZm9udC1tZWRpdW0gdGV4dC13aGl0ZS85MFwiXG4gICAgICAgICAgICAgICAgICBzdHlsZT17eyB3aWR0aDogYCR7KE51bWJlcih2YWx1ZSkgLyBtaXhUb3RhbCkgKiAxMDB9JWAsIGJhY2tncm91bmQ6IGAke2NvbG9yfTY2YCwgYm9yZGVyUmlnaHQ6IFwiMXB4IHNvbGlkICMwRjFGMzVcIiB9fVxuICAgICAgICAgICAgICAgID5cbiAgICAgICAgICAgICAgICAgIHsoTnVtYmVyKHZhbHVlKSAvIG1peFRvdGFsKSA+IDAuMDggPyB2YWx1ZSA6IFwiXCJ9XG4gICAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgICkpfVxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzTmFtZT1cIm10LTMgZmxleCBmbGV4LXdyYXAgZ2FwLTRcIj5cbiAgICAgICAgICAgICAge21peC5tYXAoKFtsYWJlbCwgdmFsdWUsIGNvbG9yXSkgPT4gKFxuICAgICAgICAgICAgICAgIDxzcGFuIGtleT17bGFiZWx9IGNsYXNzTmFtZT1cImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIHRleHQteHMgdGV4dC1zbGF0ZS00MDBcIj5cbiAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzTmFtZT1cImgtMi41IHctMi41IHJvdW5kZWQtc21cIiBzdHlsZT17eyBiYWNrZ3JvdW5kOiBTdHJpbmcoY29sb3IpIH19IC8+XG4gICAgICAgICAgICAgICAgICB7bGFiZWx9IMK3IHtudW0odmFsdWUpfSAoe3BjdChOdW1iZXIodmFsdWUpIC8gbWl4VG90YWwpfSlcbiAgICAgICAgICAgICAgICA8L3NwYW4+XG4gICAgICAgICAgICAgICkpfVxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8cCBjbGFzc05hbWU9XCJtdC00IGJvcmRlci10IGJvcmRlci13aGl0ZS81IHB0LTMgdGV4dC14cyB0ZXh0LXNsYXRlLTUwMFwiPlxuICAgICAgICAgICAgICBUaGUgaW1wb3J0ZWQgcmVwb3J0cyBjYXJyeSBkYWlseSB0b3RhbHMgb25seSwgc28gdGhpcyBpcyBhbiBhdmVyYWdlIG1peCBhY3Jvc3Mge3N0YXRzLmRheXN9IGRheVxuICAgICAgICAgICAgICB7c3RhdHMuZGF5cyA9PT0gMSA/IFwiXCIgOiBcInNcIn0g4oCUIG5vdCBhIGxpdmUgcGVyLXJvb20gc3RhdHVzLiBXaGljaCBzcGVjaWZpYyByb29tIGlzIG9jY3VwaWVkLCBjbGVhbiBvclxuICAgICAgICAgICAgICBvdXQgb2Ygc2VydmljZSBpcyBub3QgcHJlc2VudCBpbiB0aGUgZGF0YS5cbiAgICAgICAgICAgIDwvcD5cbiAgICAgICAgICA8L0NhcmQ+XG4gICAgICAgIDwvPlxuICAgICAgKX1cbiAgICA8L2Rpdj5cbiAgKTtcbn1cbiJdLCJmaWxlIjoiQzovVXNlcnMvZGl2eWUvT25lRHJpdmUvRGVza3RvcC9ib3N0b25fcHJvamVjdC9zcmMvcGFnZXMvUm9vbUJvYXJkLmpzeCJ9