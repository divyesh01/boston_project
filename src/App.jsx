import { Suspense, lazy, useEffect } from 'react'
import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider, useAuth } from '@/lib/AuthContext';
import UserNotRegisteredError from '@/components/UserNotRegisteredError';
import ScrollToTop from './components/ScrollToTop';
import Layout from '@/components/Layout';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const Compare = lazy(() => import('@/pages/Compare'));
const RoomBoard = lazy(() => import('@/pages/RoomBoard'));
const ChartBuilder = lazy(() => import('@/pages/ChartBuilder'));
const Import = lazy(() => import('@/pages/Import'));
const Employees = lazy(() => import('@/pages/Employees'));
const Payments = lazy(() => import('@/pages/Payments'));
const SettingsPage = lazy(() => import('@/pages/Settings'));
const MonthlyCalendar = lazy(() => import('@/pages/MonthlyCalendar'));
const MtdGrowth = lazy(() => import('@/pages/MtdGrowth'));
const Expenses = lazy(() => import('@/pages/Expenses'));
const Payroll = lazy(() => import('@/pages/Payroll'));
const OtaChannels = lazy(() => import('@/pages/OtaChannels'));
const DataTemplate = lazy(() => import('@/pages/DataTemplate'));
const ManualEntry = lazy(() => import('@/pages/ManualEntry'));
const Forecasting = lazy(() => import('@/pages/Forecasting'));

const PageFallback = () => (
  <div className="flex min-h-[50vh] items-center justify-center">
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-700 border-t-[#6C63FF]" />
  </div>
);

const Suspended = ({ children }) => (
  <Suspense fallback={<PageFallback />}>{children}</Suspense>
);

const AuthenticatedApp = () => {
  const { isLoadingAuth, isLoadingPublicSettings, authError, navigateToLogin } = useAuth();

  if (isLoadingPublicSettings || isLoadingAuth) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#040D1A]">
        <div className="w-8 h-8 border-4 border-slate-700 border-t-[#6C63FF] rounded-full animate-spin"></div>
      </div>
    );
  }

  if (authError) {
    if (authError.type === 'user_not_registered') {
      return <UserNotRegisteredError />;
    } else if (authError.type === 'auth_required') {
      navigateToLogin();
      return null;
    }
  }

  return (
    <Routes>
      <Route element={<Layout />}>
          <Route path="/" element={<Suspended><Dashboard /></Suspended>} />
        <Route path="/compare" element={<Suspended><Compare /></Suspended>} />
        <Route path="/rooms" element={<Suspended><RoomBoard /></Suspended>} />
        <Route path="/charts" element={<Suspended><ChartBuilder /></Suspended>} />
        <Route path="/employees" element={<Suspended><Employees /></Suspended>} />
        <Route path="/payments" element={<Suspended><Payments /></Suspended>} />
        <Route path="/settings" element={<Suspended><SettingsPage /></Suspended>} />
        <Route path="/upload" element={<Suspended><Import /></Suspended>} />
        <Route path="/calendar" element={<Suspended><MonthlyCalendar /></Suspended>} />
        <Route path="/mtd" element={<Suspended><MtdGrowth /></Suspended>} />
        <Route path="/expenses" element={<Suspended><Expenses /></Suspended>} />
        <Route path="/payroll" element={<Suspended><Payroll /></Suspended>} />
        <Route path="/ota" element={<Suspended><OtaChannels /></Suspended>} />
        <Route path="/data-template" element={<Suspended><DataTemplate /></Suspended>} />
        <Route path="/manual-entry" element={<Suspended><ManualEntry /></Suspended>} />
        <Route path="/forecasting" element={<Suspended><Forecasting /></Suspended>} />
      </Route>
      <Route path="*" element={<PageNotFound />} />
    </Routes>
  );
};

function App() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      if (mq.matches) document.documentElement.classList.add("dark");
      else document.documentElement.classList.remove("dark");
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App