import {
  LayoutDashboard, Target, GitCompareArrows, Grid3x3, BarChart3, Upload,
  Users, CreditCard, Settings as SettingsIcon, CalendarDays, TrendingUp, Wallet,
  ClipboardList, Radio, FileSpreadsheet, LineChart, Table2, ShieldCheck, ScrollText,
  BrainCircuit, Receipt, Gauge
} from "lucide-react";

export const NAV = [
  { to: "/", label: "Executive Hub", icon: LayoutDashboard, short: "Dashboard" },
  { to: "/action-center", label: "Owner Action Center", icon: Target, short: "Action" },
  { to: "/upload", label: "Import Reports", icon: Upload, short: "Upload" },
  { to: "/mtd", label: "MTD Growth", icon: TrendingUp, short: "MTD" },
  { to: "/calendar", label: "Monthly Calendar", icon: CalendarDays, short: "Calendar" },
  { to: "/compare", label: "Period Compare", icon: GitCompareArrows, short: "Compare" },
  { to: "/data-intelligence", label: "Data Intelligence", icon: BrainCircuit, short: "Data AI" },
  { to: "/rooms", label: "Room Board", icon: Grid3x3, short: "Rooms" },
  { to: "/employees", label: "Clerk Audit", icon: Users, short: "Employees" },
  { to: "/payments", label: "Payments", icon: CreditCard, short: "Payments" },
  { to: "/transactions", label: "Transactions", icon: Receipt, short: "Txns" },
  { to: "/statistics", label: "Statistics", icon: Gauge, short: "Stats" },
  { to: "/ota", label: "OTA Channels", icon: Radio, short: "OTA" },
  { to: "/charts", label: "Chart Builder", icon: BarChart3, short: "Charts" },
  { to: "/expenses", label: "Expenses", icon: Wallet, short: "Expenses" },
  { to: "/payroll", label: "Payroll", icon: ClipboardList, short: "Payroll" },
  { to: "/manual-entry", label: "Manual Entry", icon: Table2, short: "Manual" },
  { to: "/forecasting", label: "Forecasting", icon: LineChart, short: "Forecast" },
  { to: "/data-template", label: "Data Template", icon: FileSpreadsheet, short: "Template" },
  { to: "/users", label: "User Management", icon: ShieldCheck, short: "Users" },
  { to: "/audit-log", label: "Audit Log", icon: ScrollText, short: "Audit Log" },
  { to: "/settings", label: "Settings", icon: SettingsIcon, short: "Settings" },
];

export const PRIMARY = NAV.slice(0, 4);
export const MORE = NAV.slice(4);
