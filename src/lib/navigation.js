import {
  LayoutDashboard, Target, GitCompareArrows, Grid3x3, BarChart3, Upload,
  Users, CreditCard, Settings as SettingsIcon, CalendarDays, TrendingUp, Wallet,
  ClipboardList, Radio, FileSpreadsheet, LineChart, Table2, ShieldCheck, ScrollText,
  BrainCircuit, Receipt, Gauge, BedDouble, Star,
} from "lucide-react";

/**
 * 6 Core Owner Intelligence Modules (Primary Navigation)
 */
export const CORE_OWNER_NAV = [
  { to: "/", label: "Executive Hub", icon: LayoutDashboard, short: "Executive" },
  { to: "/statistics", label: "Revenue & Occupancy", icon: Gauge, short: "Rev & Occ" },
  { to: "/ota", label: "OTA & Channels", icon: Radio, short: "Channels" },
  { to: "/payments", label: "Profit & Cash", icon: CreditCard, short: "Profit/Cash" },
  { to: "/compare", label: "Properties & Variance", icon: GitCompareArrows, short: "Properties" },
  { to: "/data-intelligence", label: "Data Center & Lineage", icon: BrainCircuit, short: "Data Center" },
];

/**
 * Secondary Operational & Specialized Modules
 */
export const SECONDARY_NAV = [
  { to: "/action-center", label: "Action Center", icon: Target, short: "Action" },
  { to: "/upload", label: "Import Reports", icon: Upload, short: "Upload" },
  { to: "/mtd", label: "MTD Growth", icon: TrendingUp, short: "MTD" },
  { to: "/calendar", label: "Monthly Calendar", icon: CalendarDays, short: "Calendar" },
  { to: "/pricing", label: "Dynamic Pricing", icon: TrendingUp, short: "Pricing" },
  { to: "/forecasting", label: "Forecasting", icon: LineChart, short: "Forecast" },
  { to: "/expenses", label: "Expenses", icon: Wallet, short: "Expenses" },
  { to: "/payroll", label: "Payroll", icon: ClipboardList, short: "Payroll" },
  { to: "/rooms", label: "Room Board", icon: Grid3x3, short: "Rooms" },
  { to: "/housekeeping", label: "Housekeeping", icon: BedDouble, short: "Clean" },
  { to: "/employees", label: "Clerk Shift Audit", icon: Users, short: "Employees" },
  { to: "/transactions", label: "Transactions Ledger", icon: Receipt, short: "Txns" },
  { to: "/reviews", label: "Guest Reviews", icon: Star, short: "Reviews" },
  { to: "/charts", label: "Chart Builder", icon: BarChart3, short: "Charts" },
  { to: "/channel-manager", label: "Channel Manager", icon: SettingsIcon, short: "Channel Mgr" },
  { to: "/manual-entry", label: "Manual Entry", icon: Table2, short: "Manual" },
  { to: "/data-template", label: "Data Template", icon: FileSpreadsheet, short: "Template" },
  { to: "/users", label: "User Management", icon: ShieldCheck, short: "Users" },
  { to: "/audit-log", label: "Audit Log", icon: ScrollText, short: "Audit Log" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, short: "Settings" },
];

export const NAV = [...CORE_OWNER_NAV, ...SECONDARY_NAV];
export const PRIMARY = CORE_OWNER_NAV;
export const MORE = SECONDARY_NAV;
