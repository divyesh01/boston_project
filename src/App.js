import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Suspense, lazy, useEffect, Component } from 'react';
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter as Router, Route, Routes, Navigate, useLocation } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import { isRouteMapped } from '@/lib/permissions';
import { logAuditEvent } from '@/lib/auditLogger';
import ScrollToTop from './components/ScrollToTop';
import Layout from '@/components/Layout';
import { attachClickSounds } from '@/lib/sound';
const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Compare = lazy(() => import('@/pages/Compare'));
const DataIntelligence = lazy(() => import('@/pages/DataIntelligence'));
const RoomBoard = lazy(() => import('@/pages/RoomBoard'));
const ChartBuilder = lazy(() => import('@/pages/ChartBuilder'));
const Import = lazy(() => import('@/pages/Import'));
const Employees = lazy(() => import('@/pages/Employees'));
const Payments = lazy(() => import('@/pages/Payments'));
const Transactions = lazy(() => import('@/pages/Transactions'));
const Statistics = lazy(() => import('@/pages/Statistics'));
const SettingsPage = lazy(() => import('@/pages/Settings'));
const MonthlyCalendar = lazy(() => import('@/pages/MonthlyCalendar'));
const MtdGrowth = lazy(() => import('@/pages/MtdGrowth'));
const Expenses = lazy(() => import('@/pages/Expenses'));
const Payroll = lazy(() => import('@/pages/Payroll'));
const OtaChannels = lazy(() => import('@/pages/OtaChannels'));
const ChannelManager = lazy(() => import('@/pages/ChannelManager'));
const DataTemplate = lazy(() => import('@/pages/DataTemplate'));
const ManualEntry = lazy(() => import('@/pages/ManualEntry'));
const Forecasting = lazy(() => import('@/pages/Forecasting'));
const ActionCenterPage = lazy(() => import('@/pages/ActionCenter'));
const Login = lazy(() => import('@/pages/Login'));
const ForgotPassword = lazy(() => import('@/pages/ForgotPassword'));
const ResetPassword = lazy(() => import('@/pages/ResetPassword'));
const Setup = lazy(() => import('@/pages/Setup'));
const Users = lazy(() => import('@/pages/Users'));
const AuditLog = lazy(() => import('@/pages/AuditLog'));
const ChangePassword = lazy(() => import('@/pages/ChangePassword'));
const Housekeeping = lazy(() => import('@/pages/Housekeeping'));
const Reviews = lazy(() => import('@/pages/Reviews'));
const Pricing = lazy(() => import('@/pages/Pricing'));
const PageFallback = () => (_jsx("div", { className: "flex min-h-[50vh] items-center justify-center", children: _jsx("div", { className: "h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-[#6C63FF]" }) }));
// Top-level error boundary to catch AuthProvider errors
class TopLevelErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null, info: null };
    }
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        this.setState({ info });
        console.error('[top-level-error-boundary]', error, info);
    }
    render() {
        if (this.state.error) {
            return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-[#040D1A] p-6", children: _jsxs("div", { className: "w-full max-w-2xl rounded-2xl border border-red-500/30 bg-[#0F1F35] p-6", children: [_jsx("h1", { className: "text-lg font-semibold text-red-300", children: "Application Error" }), _jsx("p", { className: "mt-1 text-sm text-slate-400", children: this.state.error.message }), _jsx("pre", { className: "mt-4 max-h-64 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-red-200", children: this.state.info?.componentStack }), _jsx("button", { onClick: () => window.location.reload(), className: "mt-4 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white", children: "Reload" })] }) }));
        }
        return this.props.children;
    }
}
class LazyErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true };
    }
    componentDidCatch(error, info) {
        console.error('[lazy-error-boundary]', error, info);
    }
    handleReset = () => {
        this.setState({ hasError: false });
    };
    render() {
        if (this.state.hasError) {
            return (_jsx("div", { className: "flex min-h-screen items-center justify-center bg-[#040D1A] p-6", children: _jsxs("div", { className: "text-center", children: [_jsx("h2", { className: "text-xl text-white", children: "Failed to load page" }), _jsx("p", { className: "mt-2 text-sm text-slate-400", children: "This page could not be loaded." }), _jsx("button", { onClick: () => window.location.reload(), className: "mt-4 rounded bg-[#6C63FF] px-4 py-2 text-white", children: "Reload" })] }) }));
        }
        return this.props.children;
    }
}
const Suspended = ({ children }) => (_jsx(LazyErrorBoundary, { children: _jsx(Suspense, { fallback: _jsx(PageFallback, {}), children: children }) }));
const LoginRedirect = () => {
    const { isAuthenticated, isLoadingAuth } = useAuth();
    const location = useLocation();
    if (isLoadingAuth)
        return _jsx(PageFallback, {});
    if (isAuthenticated)
        return _jsx(Navigate, { to: new URLSearchParams(location.search).get("returnTo") || "/", replace: true });
    return _jsx(Suspended, { children: _jsx(Login, {}) });
};
const RequireAuth = ({ children }) => {
    const { isAuthenticated, isLoadingAuth, authChecked, navigateToLogin } = useAuth();
    const location = useLocation();
    useEffect(() => {
        if (authChecked && !isAuthenticated) {
            navigateToLogin(location.pathname + location.search);
        }
    }, [authChecked, isAuthenticated, navigateToLogin, location]);
    if (isLoadingAuth || !authChecked) {
        return (_jsx("div", { className: "fixed inset-0 flex items-center justify-center bg-[#040D1A]", children: _jsx("div", { className: "h-8 w-8 border-4 border-slate-700 border-t-[#6C63FF] rounded-full animate-spin" }) }));
    }
    if (!isAuthenticated)
        return null;
    return children;
};
const RequirePermission = ({ children }) => {
    const { canAccessRoute, user } = useAuth();
    const location = useLocation();
    const allowed = canAccessRoute(location.pathname);
    // Log every denied route attempt — including unmapped (default-deny) routes.
    useEffect(() => {
        if (!allowed) {
            logAuditEvent('Unauthorized Route Access', {
                user_id: user?.id,
                username: user?.username,
                result: 'failed',
                detail: isRouteMapped(location.pathname)
                    ? `No permission for route ${location.pathname}`
                    : `Unmapped route: ${location.pathname}`,
            });
        }
    }, [allowed, location.pathname, user?.id, user?.username]);
    if (!allowed) {
        return _jsx(Navigate, { to: "/", replace: true });
    }
    return children;
};
const PasswordGate = ({ children }) => {
    const { user } = useAuth();
    const location = useLocation();
    if (user && user.must_change_password && location.pathname !== "/change-password") {
        return _jsx(Navigate, { to: "/change-password", replace: true });
    }
    return children;
};
const ProtectedRoutes = () => {
    return (_jsxs(Routes, { children: [_jsxs(Route, { element: _jsx(RequireAuth, { children: _jsx(RequirePermission, { children: _jsx(PasswordGate, { children: _jsx(Layout, {}) }) }) }), children: [_jsx(Route, { path: "/", element: _jsx(Suspended, { children: _jsx(Dashboard, {}) }) }), _jsx(Route, { path: "/action-center", element: _jsx(Suspended, { children: _jsx(ActionCenterPage, {}) }) }), _jsx(Route, { path: "/compare", element: _jsx(Suspended, { children: _jsx(Compare, {}) }) }), _jsx(Route, { path: "/data-intelligence", element: _jsx(Suspended, { children: _jsx(DataIntelligence, {}) }) }), _jsx(Route, { path: "/rooms", element: _jsx(Suspended, { children: _jsx(RoomBoard, {}) }) }), _jsx(Route, { path: "/charts", element: _jsx(Suspended, { children: _jsx(ChartBuilder, {}) }) }), _jsx(Route, { path: "/employees", element: _jsx(Suspended, { children: _jsx(Employees, {}) }) }), _jsx(Route, { path: "/payments", element: _jsx(Suspended, { children: _jsx(Payments, {}) }) }), _jsx(Route, { path: "/transactions", element: _jsx(Suspended, { children: _jsx(Transactions, {}) }) }), _jsx(Route, { path: "/statistics", element: _jsx(Suspended, { children: _jsx(Statistics, {}) }) }), _jsx(Route, { path: "/settings", element: _jsx(Suspended, { children: _jsx(SettingsPage, {}) }) }), _jsx(Route, { path: "/upload", element: _jsx(Suspended, { children: _jsx(Import, {}) }) }), _jsx(Route, { path: "/calendar", element: _jsx(Suspended, { children: _jsx(MonthlyCalendar, {}) }) }), _jsx(Route, { path: "/mtd", element: _jsx(Suspended, { children: _jsx(MtdGrowth, {}) }) }), _jsx(Route, { path: "/expenses", element: _jsx(Suspended, { children: _jsx(Expenses, {}) }) }), _jsx(Route, { path: "/payroll", element: _jsx(Suspended, { children: _jsx(Payroll, {}) }) }), _jsx(Route, { path: "/ota", element: _jsx(Suspended, { children: _jsx(OtaChannels, {}) }) }), _jsx(Route, { path: "/channel-manager", element: _jsx(Suspended, { children: _jsx(ChannelManager, {}) }) }), _jsx(Route, { path: "/data-template", element: _jsx(Suspended, { children: _jsx(DataTemplate, {}) }) }), _jsx(Route, { path: "/manual-entry", element: _jsx(Suspended, { children: _jsx(ManualEntry, {}) }) }), _jsx(Route, { path: "/forecasting", element: _jsx(Suspended, { children: _jsx(Forecasting, {}) }) }), _jsx(Route, { path: "/users", element: _jsx(Suspended, { children: _jsx(Users, {}) }) }), _jsx(Route, { path: "/audit-log", element: _jsx(Suspended, { children: _jsx(AuditLog, {}) }) }), _jsx(Route, { path: "/change-password", element: _jsx(Suspended, { children: _jsx(ChangePassword, {}) }) }), _jsx(Route, { path: "/housekeeping", element: _jsx(Suspended, { children: _jsx(Housekeeping, {}) }) }), _jsx(Route, { path: "/reviews", element: _jsx(Suspended, { children: _jsx(Reviews, {}) }) }), _jsx(Route, { path: "/pricing", element: _jsx(Suspended, { children: _jsx(Pricing, {}) }) })] }), _jsx(Route, { path: "*", element: _jsx(PageNotFound, {}) })] }));
};
const AuthenticatedApp = () => {
    return (_jsxs(Routes, { children: [_jsx(Route, { path: "/login", element: _jsx(LoginRedirect, {}) }), _jsx(Route, { path: "/forgot-password", element: _jsx(Suspended, { children: _jsx(ForgotPassword, {}) }) }), _jsx(Route, { path: "/reset-password", element: _jsx(Suspended, { children: _jsx(ResetPassword, {}) }) }), _jsx(Route, { path: "/setup", element: _jsx(Suspended, { children: _jsx(Setup, {}) }) }), _jsx(Route, { path: "/*", element: _jsx(ProtectedRoutes, {}) })] }));
};
function App() {
    useEffect(() => {
        attachClickSounds();
        if (typeof window === "undefined" || !window.matchMedia)
            return;
        try {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            const update = () => {
                if (mq.matches)
                    document.documentElement.classList.add("dark");
                else
                    document.documentElement.classList.remove("dark");
            };
            update();
            if (mq.addEventListener)
                mq.addEventListener("change", update);
            else if (mq.addListener)
                mq.addListener(update);
            return () => {
                if (mq.removeEventListener)
                    mq.removeEventListener("change", update);
                else if (mq.removeListener)
                    mq.removeListener(update);
            };
        }
        catch {
            // matchMedia not supported or quota issue — skip dark mode sync
        }
    }, []);
    return (_jsx(TopLevelErrorBoundary, { children: _jsx(AuthProvider, { children: _jsxs(QueryClientProvider, { client: queryClientInstance, children: [_jsx(Router, { children: _jsxs(TopLevelErrorBoundary, { children: [_jsx(ScrollToTop, {}), _jsx(AuthenticatedApp, {})] }) }), _jsx(Toaster, {})] }) }) }));
}
export default App;
