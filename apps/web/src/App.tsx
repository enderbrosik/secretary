import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { setUnauthorizedHandler } from './lib/api';
import { isDesktop } from './lib/platform';
import { useMe } from './lib/queries';
import { useThemeSync } from './lib/theme';
import { AuthPage } from './pages/Auth';
import { TodayPage } from './pages/Today';
import { Spinner } from './ui';

const TasksPage = lazy(() => import('./pages/Tasks'));
const CalendarPage = lazy(() => import('./pages/Calendar'));
const InboxPage = lazy(() => import('./pages/Inbox'));
const ReviewsPage = lazy(() => import('./pages/Reviews'));
const ReviewDetailPage = lazy(() => import('./pages/ReviewDetail'));
const ProjectsPage = lazy(() => import('./pages/Projects'));
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetail'));
const AssistantPage = lazy(() => import('./pages/Assistant'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const OnboardingPage = lazy(() => import('./pages/Onboarding'));
const QuickPage = lazy(() => import('./pages/Quick'));
const DesktopSetupPage = lazy(() => import('./pages/DesktopSetup'));
const LegalPage = lazy(() => import('./pages/Legal'));

function FullScreenSpinner() {
  return (
    <div className="grid min-h-screen place-items-center">
      <Spinner className="size-5" />
    </div>
  );
}

function Gate() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  useThemeSync(me.data?.settings?.theme);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      qc.setQueryData(['me'], (old: unknown) => ({ ...(old as object), user: null }));
      nav('/login');
    });
  }, [qc, nav]);

  // Privacy Policy and Terms are public pages, reachable whether or not you are signed in.
  if (loc.pathname === '/privacy' || loc.pathname === '/terms')
    return (
      <Suspense fallback={<FullScreenSpinner />}>
        <LegalPage doc={loc.pathname === '/privacy' ? 'privacy' : 'terms'} />
      </Suspense>
    );
  if (me.isLoading) return <FullScreenSpinner />;
  if (me.isError) {
    if (isDesktop) return <Suspense fallback={<FullScreenSpinner />}><DesktopSetupPage error={me.error} /></Suspense>;
    return <AuthPage mode="login" serverError={me.error} />;
  }
  const user = me.data?.user;
  if (!user) {
    if (loc.pathname === '/desktop-setup' && isDesktop) return <Suspense fallback={<FullScreenSpinner />}><DesktopSetupPage /></Suspense>;
    return (
      <Routes>
        <Route path="/signup" element={<AuthPage mode="signup" />} />
        <Route path="*" element={<AuthPage mode="login" />} />
      </Routes>
    );
  }
  if (!me.data?.settings?.onboardingCompleted && loc.pathname !== '/onboarding' && !loc.pathname.startsWith('/settings')) {
    return <Navigate to="/onboarding" replace />;
  }
  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/quick" element={<QuickPage />} />
        <Route element={<Layout />}>
          <Route path="/" element={<TodayPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/reviews/:date" element={<ReviewDetailPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/assistant" element={<AssistantPage />} />
          <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route path="/signup" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  // Desktop builds are served from a custom protocol, where hash routing survives reloads.
  const Router = isDesktop ? HashRouter : BrowserRouter;
  return (
    <Router>
      <Gate />
    </Router>
  );
}
