import { useEffect, useLayoutEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Role } from '@/data/types';
import { useHash, Header, navigate, PenLoader, AlertsPage } from '@/components/ui';
import { Gallery } from '@/pages/public';
import { LandingRoleSelect, Auth, ForcedPasswordChange, ForgotPassword, ResetPassword, SettingsPage } from '@/pages/auth';
import { apiFetch, broadcastNotificationReceived, getActiveApiRequestCount, getSessionUser, subscribeToApiRequests, type UserNotification } from '@/api';
import {
  StudentLandingPage, StudentDashboard, Catalog, CourseEnvironment, Profile, Achievements,
  ShowcaseSubmission, Competitions, StudentEvents, Resources,
} from '@/pages/student';
import {
  TeacherDashboard, CoordinatorDashboard, TeacherQueue, ReviewPage, Reviews, TeacherShowcase, AssetLibrary,
  TeacherProfile, CompetitionJudging, HostEvent, BranchStats, BranchTeachers,
  BranchStudents, RestrictedStudentProfile,
} from '@/pages/teacher';
import { AdminLayout } from '@/pages/admin';
import { readThemePreference, saveThemePreference, type ThemeName } from '@/theme';
import { AssistantChat } from '@/components/AssistantChat';

const PUBLIC_PAGES = ['landing', 'signup', 'login', 'forgot-password', 'reset-password'];

const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', student: 'Dashboard', 'teacher-dashboard': 'Dashboard', 'coordinator-dashboard': 'Dashboard',
  admin: 'Dashboard', catalog: 'Courses', achievements: 'Achievements', gallery: 'Gallery', competitions: 'Competitions', events: 'Events',
  resources: 'Resources', showcase: 'Showcase', notifications: 'Notifications', profile: 'Profile', settings: 'Settings',
  course: 'Course', queue: 'Review queue', review: 'Review entry', reviews: 'My reviews', assets: 'Asset library',
  judging: 'Judging', 'events-host': 'Host events', 'branch-stats': 'Branch statistics', 'branch-teachers': 'Branch teachers',
  'branch-students': 'Branch students', 'student-profile': 'Student profile', 'teacher-profile-view': 'Teacher profile',
  'admin-courses': 'Course builder', 'admin-tr-numbers': 'TR number uploads', 'admin-users': 'Teacher & load', 'admin-logs': 'Entry logs',
  'admin-showcase': 'Showcase moderation', 'admin-competitions': 'Competitions', 'admin-events': 'Live events',
  'admin-resources': 'Resources', 'admin-stats': 'Statistics', 'admin-certificates': 'Certificates & badges', 'admin-governance': 'Data governance',
};

function pageLabel(page: string): string {
  return PAGE_LABELS[page] ?? page.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

function App() {
  const page = useHash();
  const [sessionUser, setSessionUser] = useState(() => getSessionUser());
  const userId = sessionUser?.id ?? null;
  const [theme, setTheme] = useState<ThemeName>(() => readThemePreference(getSessionUser()?.id));
  const [activeRequests, setActiveRequests] = useState(getActiveApiRequestCount);
  const [routeLoading, setRouteLoading] = useState(false);
  const [loaderVisible, setLoaderVisible] = useState(false);

  // Re-read the session on every hash change — covers login/logout/signup,
  // which all navigate immediately after touching localStorage.

  const role: Role = sessionUser?.role ?? 'student';
  const dashboardRoute = role === 'admin' ? 'admin' : role === 'coordinator' ? 'coordinator-dashboard' : role === 'teacher' ? 'teacher-dashboard' : 'dashboard';
  const isLoginPage = page === 'login' || page.startsWith('login-');
  const isPublicPage = PUBLIC_PAGES.includes(page) || isLoginPage || page === 'forced-password';

  useEffect(() => subscribeToApiRequests(setActiveRequests), []);

  useLayoutEffect(() => {
    if (isPublicPage) {
      setRouteLoading(false);
      return;
    }

    setRouteLoading(true);
    const failsafe = window.setTimeout(() => setRouteLoading(false), 20000);
    return () => window.clearTimeout(failsafe);
  }, [page, isPublicPage]);

  useEffect(() => {
    if (!routeLoading || activeRequests > 0) return;

    const settleTimer = window.setTimeout(() => setRouteLoading(false), 180);
    return () => window.clearTimeout(settleTimer);
  }, [routeLoading, activeRequests]);

  useEffect(() => {
    if (routeLoading || activeRequests > 0) {
      setLoaderVisible(true);
      return;
    }

    const hideTimer = window.setTimeout(() => setLoaderVisible(false), 220);
    return () => window.clearTimeout(hideTimer);
  }, [routeLoading, activeRequests]);

  // Route guard: no session and trying to reach anything but a public/auth
  // page sends you back to the role-select landing. This is a UX convenience
  // — the backend's own role checks on every endpoint are the real boundary.
  useEffect(() => {
    const freshUser = getSessionUser();
    setSessionUser(freshUser);
    if (!freshUser && !isPublicPage) {
      navigate('landing');
    }
  }, [page, isPublicPage]);

  useEffect(() => {
    setTheme(readThemePreference(userId));
  }, [userId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const changeTheme = (nextTheme: ThemeName) => {
    if (nextTheme === theme) return;
    saveThemePreference(userId, nextTheme);
    setTheme(nextTheme);
    void apiFetch<UserNotification>('/notifications', { method: 'POST', body: { type: 'theme_changed', payload: { theme: nextTheme } }, silent: true })
      .then(broadcastNotificationReceived)
      .catch(() => broadcastNotificationReceived({ id: `theme-${Date.now()}`, type: 'theme_changed', payload: { theme: nextTheme }, read: false, created_at: new Date().toISOString() }));
  };

  if (!sessionUser && !isPublicPage) return null; // avoid a flash of protected content before the redirect above runs

  const content = (() => {
    // Landing / role selection
    if (page === 'landing') return <LandingRoleSelect />;

    // Auth pages
    if (page === 'signup') return <Auth signup initialRole="student" />;
    if (isLoginPage) return <Auth initialRole={page.startsWith('login-') ? page.replace('login-', '') as Role : 'student'} />;
    if (page === 'forgot-password') return <ForgotPassword />;
    if (page.startsWith('reset-password')) return <ResetPassword />;
    if (page === 'forced-password') return <ForcedPasswordChange />;
    if (page === 'settings' || (page === 'profile' && role === 'admin')) return <SettingsPage role={role} theme={theme} onThemeChange={changeTheme} />;
    if (page === 'notifications') return <AlertsPage />;

    // Student landing (introductory + showcases)
    if (page === 'student-landing') return <StudentLandingPage />;

    // Student portal
    if (page === 'dashboard' || page === 'student') return <StudentDashboard />;
    if (page === 'catalog') return <Catalog />;
    if (page === 'course') return <CourseEnvironment />;
    if (page === 'profile' && role === 'student') return <Profile />;
    if (page === 'achievements' && role === 'student') return <Achievements />;
    if (page === 'showcase' && role === 'student') return <ShowcaseSubmission />;
    if (page === 'competitions' && role === 'student') return <Competitions />;
    if (page === 'events' && role === 'student') return <StudentEvents />;
    if (page === 'resources' && role === 'student') return <Resources />;
    // Notifications are handled for every role above.

    // Gallery (shared)
    if (page === 'gallery') return <Gallery />;

    // Teacher and coordinator portals
    if (page === 'teacher-dashboard') return <TeacherDashboard />;
    if (page === 'coordinator-dashboard') return <CoordinatorDashboard />;
    if (page === 'queue') return <TeacherQueue coordinator={role === 'coordinator'} />;
    if (page === 'review') return <ReviewPage />;
    if (page === 'reviews') return <Reviews />;
    if (page === 'showcase' && (role === 'teacher' || role === 'coordinator' || role === 'admin')) return <TeacherShowcase />;
    if (page === 'assets') return <AssetLibrary />;
    if (page === 'judging') return <CompetitionJudging />;
    if (page === 'events-host') return <HostEvent />;
    if (page === 'profile' && (role === 'teacher' || role === 'coordinator')) return <TeacherProfile />;
    if (page === 'teacher-profile-view') return <TeacherProfile />;
    // Notifications are handled for every role above.
    if (page === 'student-profile') return <RestrictedStudentProfile />;

    // Coordinator extra tabs
    if (page === 'branch-stats') return <BranchStats />;
    if (page === 'branch-teachers') return <BranchTeachers />;
    if (page === 'branch-students') return <BranchStudents />;

    // Admin portal
    if (page === 'admin' || page.startsWith('admin-')) return <AdminLayout page={page} />;

    return <LandingRoleSelect />;
  })();

  const loadingOverlay = loaderVisible && <PenLoader label="Loading your workspace…" global />;

  if (isPublicPage) return <>{content}{loadingOverlay}</>;

  if (page === 'course') {
    return (
      <div className={`app-layout course-focus-layout${loaderVisible ? ' is-loading' : ''}`}>
        {content}
        {loadingOverlay}
        {sessionUser && (role === 'student' || role === 'teacher' || role === 'coordinator') && <AssistantChat key={userId} user={sessionUser} />}
      </div>
    );
  }

  return (
    <div className={`app-layout${loaderVisible ? ' is-loading' : ''}`}>
      <Header role={role} theme={theme} onThemeChange={changeTheme} />
      <div className="app-shell-content">
        <nav className="app-breadcrumb" aria-label="Breadcrumb">
          <button onClick={() => navigate(dashboardRoute)}>Dashboard</button>
          <ChevronRight size={14} aria-hidden="true" />
          <strong aria-current="page">{pageLabel(page)}</strong>
        </nav>
        {content}
      </div>
      {loadingOverlay}
      {sessionUser && (role === 'student' || role === 'teacher' || role === 'coordinator') && <AssistantChat key={userId} user={sessionUser} />}
    </div>
  );
}

export default App;
