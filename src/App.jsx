import { Suspense, lazy, useEffect, useState, Component } from 'react';
import { Toaster } from "@/components/ui/toaster";
import { ErrorState } from "@/components/ui/status";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { YDocProvider } from '@/crdt';
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
const DemoYDoc = lazy(() => import('@/pages/DemoYDoc'));

const PageFallback = () => (
  <div className="mx-auto w-full max-w-6xl animate-pulse space-y-6 p-6">
    <div className="h-8 w-48 rounded-lg bg-white/5" />
    <div className="grid gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 rounded-2xl bg-white/5" />
      ))}
    </div>
    <div className="h-72 rounded-2xl bg-white/5" />
  </div>
);

// Thin top progress bar shown on every route change to improve perceived speed.
const RouteProgress = () => {
  const location = useLocation();
  const [active, setActive] = useState(false);
  useEffect(() => {
    setActive(true);
    const t = setTimeout(() => setActive(false), 350);
    return () => clearTimeout(t);
  }, [location.pathname]);
  return (
    <div className={`pointer-events-none fixed inset-x-0 top-0 z-[200] h-0.5 transition-opacity duration-300 ${active ? "opacity-100" : "opacity-0"}`}>
      <div
        className="h-full bg-gradient-to-r from-[#6C63FF] via-[#00E096] to-[#6C63FF] transition-[width] duration-300 ease-out"
        style={{ width: active ? "85%" : "0%" }}
      />
    </div>
  );
};

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
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#040D1A] p-6">
          <div className="w-full max-w-2xl rounded-2xl border border-red-500/30 bg-[#0F1F35] p-6">
            <h1 className="text-lg font-semibold text-red-300">Application Error</h1>
            <p className="mt-1 text-sm text-slate-400">{this.state.error.message}</p>
            <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-black/40 p-3 text-xs text-red-200">
              {this.state.info?.componentStack}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-[#6C63FF] px-4 py-2 text-sm font-medium text-white"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

class LazyErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    this.setState({ info });
    console.error('[lazy-error-boundary]', error, info);
  }
  handleReset = () => {
    this.setState({ hasError: false });
  };
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#040D1A] p-6">
          <ErrorState
            title="Failed to load page"
            description="This section hit an unexpected error. You can retry without reloading the app."
            error={this.state.error}
            onRetry={this.handleReset}
          />
        </div>
      );
    }
    return this.props.children;
  }
}

const Suspended = ({ children }) => (
  <LazyErrorBoundary>
    <Suspense fallback={<PageFallback />}>{children}</Suspense>
  </LazyErrorBoundary>
);

const LoginRedirect = () => {
  const { isAuthenticated, isLoadingAuth } = useAuth();
  const location = useLocation();
  if (isLoadingAuth) return <PageFallback />;
  if (isAuthenticated) return <Navigate to={new URLSearchParams(location.search).get("returnTo") || "/"} replace />;
  return <Suspended><Login /></Suspended>;
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
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#040D1A]">
        <div className="h-8 w-8 border-4 border-slate-700 border-t-[#6C63FF] rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!isAuthenticated) return null;
  return children;
};

const RequirePermission = ({ children }) => {
  const { canAccessRoute, user } = useAuth();
  const location = useLocation();
  const allowed = canAccessRoute(location.pathname);

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
    return <Navigate to="/" replace />;
  }
  return children;
};

const PasswordGate = ({ children }) => {
  const { user } = useAuth();
  const location = useLocation();
  if (user && user.must_change_password && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }
  return children;
};

const ProtectedRoutes = () => {
  return (
    <Routes>
      <Route
        element={
          <RequireAuth>
            <RequirePermission>
              <PasswordGate>
                <Layout />
              </PasswordGate>
            </RequirePermission>
          </RequireAuth>
        }
      >
        <Route path="/" element={<Suspended><Dashboard /></Suspended>} />
        <Route path="/action-center" element={<Suspended><ActionCenterPage /></Suspended>} />
        <Route path="/compare" element={<Suspended><Compare /></Suspended>} />
        <Route path="/data-intelligence" element={<Suspended><DataIntelligence /></Suspended>} />
        <Route path="/rooms" element={<Suspended><RoomBoard /></Suspended>} />
        <Route path="/charts" element={<Suspended><ChartBuilder /></Suspended>} />
        <Route path="/employees" element={<Suspended><Employees /></Suspended>} />
        <Route path="/payments" element={<Suspended><Payments /></Suspended>} />
        <Route path="/transactions" element={<Suspended><Transactions /></Suspended>} />
        <Route path="/statistics" element={<Suspended><Statistics /></Suspended>} />
        <Route path="/settings" element={<Suspended><SettingsPage /></Suspended>} />
        <Route path="/upload" element={<Suspended><Import /></Suspended>} />
        <Route path="/calendar" element={<Suspended><MonthlyCalendar /></Suspended>} />
        <Route path="/mtd" element={<Suspended><MtdGrowth /></Suspended>} />
        <Route path="/expenses" element={<Suspended><Expenses /></Suspended>} />
        <Route path="/payroll" element={<Suspended><Payroll /></Suspended>} />
        <Route path="/ota" element={<Suspended><OtaChannels /></Suspended>} />
        <Route path="/channel-manager" element={<Suspended><ChannelManager /></Suspended>} />
        <Route path="/data-template" element={<Suspended><DataTemplate /></Suspended>} />
        <Route path="/manual-entry" element={<Suspended><ManualEntry /></Suspended>} />
        <Route path="/forecasting" element={<Suspended><Forecasting /></Suspended>} />
        <Route path="/users" element={<Suspended><Users /></Suspended>} />
        <Route path="/audit-log" element={<Suspended><AuditLog /></Suspended>} />
        <Route path="/change-password" element={<Suspended><ChangePassword /></Suspended>} />
        <Route path="/housekeeping" element={<Suspended><Housekeeping /></Suspended>} />
        <Route path="/reviews" element={<Suspended><Reviews /></Suspended>} />
        <Route path="/pricing" element={<Suspended><Pricing /></Suspended>} />
        <Route path="/demo" element={<Suspended><DemoYDoc /></Suspended>} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

const AuthenticatedApp = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginRedirect />} />
      <Route path="/forgot-password" element={<Suspended><ForgotPassword /></Suspended>} />
      <Route path="/reset-password" element={<Suspended><ResetPassword /></Suspended>} />
      <Route path="/setup" element={<Suspended><Setup /></Suspended>} />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
};

function App() {
  useEffect(() => {
    attachClickSounds();
    if (typeof window === "undefined" || !window.matchMedia) return;
    try {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const update = () => {
        if (mq.matches) document.documentElement.classList.add("dark");
        else document.documentElement.classList.remove("dark");
      };
      update();
      if (mq.addEventListener) mq.addEventListener("change", update);
      else if (mq.addListener) mq.addListener(update);
      return () => {
        if (mq.removeEventListener) mq.removeEventListener("change", update);
        else if (mq.removeListener) mq.removeListener(update);
      };
    } catch {
      // matchMedia not supported or quota issue — skip dark mode sync
    }
  }, []);

  return (
    <TopLevelErrorBoundary>
      <AuthProvider>
        <YDocProvider name="app-root">
          <QueryClientProvider client={queryClientInstance}>
            <Router>
              <RouteProgress />
              <ScrollToTop />
              <AuthenticatedApp />
            </Router>
            <Toaster />
          </QueryClientProvider>
        </YDocProvider>
      </AuthProvider>
    </TopLevelErrorBoundary>
  );
}

export default App;
