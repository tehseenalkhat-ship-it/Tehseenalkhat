import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
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
import { Chatrooms } from '@/pages/Chatrooms';
const MashqWorksheets = lazy(() => import('@/pages/MashqWorksheets').then(module => ({ default: module.MashqWorksheets })));
import {
  TeacherDashboard, CoordinatorDashboard, TeacherQueue, ReviewPage, Reviews, TeacherShowcase, AssetLibrary,
  TeacherProfile, CompetitionJudging, HostEvent, BranchStats, BranchTeachers,
  BranchStudents, RestrictedStudentProfile,
} from '@/pages/teacher';
import { AdminLayout } from '@/pages/admin';
import { readThemePreference, saveThemePreference, type ThemeName } from '@/theme';
import { AssistantChat } from '@/components/AssistantChat';
import { ProblemReporting } from '@/components/ReportProblem';
import { useLanguage } from '@/language';
import { V2CourseBuilderPage } from '@/v2/admin/CourseBuilderPage';
import { V2AdminHomePage } from '@/v2/admin/AdminHomePage';
import { V2StudentHomePage } from '@/v2/student/home/StudentHomePage';
import { V2TaskPage } from '@/v2/student/task/TaskPage';
import { V2DeptChatPage } from '@/v2/dept/DeptChatPage';
import { V2PeoplePage } from '@/v2/people/PeoplePage';
import { V2AnnouncementsPage } from '@/v2/announce/AnnouncementsPage';
import { V2AnnouncementBanner } from '@/v2/announce/AnnouncementBanner';
import { V2TeacherCoursesPage } from '@/v2/teacher/TeacherCoursesPage';
import { V2BadgeDesignsPage } from '@/v2/admin/badges/BadgeDesigns';
import { V3InstallAppPrompt } from '@/v2/content/InstallAppPrompt';
import { V2MyProgressPage } from '@/v2/insights/MyProgressPage';
import { V2PoliciesPage } from '@/v2/admin/PoliciesPage';
import { V2LogicSetsPage } from '@/v2/admin/LogicSetsPage';
import { V2MeritPage } from '@/v2/admin/MeritPage';
import { V2StudentCoursePage } from '@/v2/student/StudentCoursePage';
import { V2StudentMeritPage } from '@/v2/student/StudentMeritPage';
import { V2CompetitionsPage } from '@/v2/competitions/CompetitionsPage';
import { V2ReviewInboxPage } from '@/v2/review/ReviewInboxPage';
import { V2ScanReturnPage } from '@/v2/review/ScanReturnPage';
import { V2InsightsPage } from '@/v2/insights/InsightsPage';
import { V2TeamReportPage } from '@/v2/insights/TeamReportPage';
import { V2CommunityPage } from '@/v2/community/CommunityPage';
import { V3SurveyByLinkPage } from '@/v2/announce/SurveyByLinkPage';

const PUBLIC_PAGES = ['landing', 'signup', 'login', 'forgot-password', 'reset-password'];
// Pages with a chat message box + Send button: the floating "Ask Guild Guide" button is hidden there
// so it never covers the box (task page, department chat, review workspace in the inbox, chat rooms).
const CHAT_PAGES = new Set(['v2-task', 'v2-dept-chat', 'v2-inbox', 'v2-community', 'chats', 'teacher-chats', 'course', 'v2-course']);

const PAGE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard', student: 'Dashboard', chats: 'Chats', 'teacher-chats': 'Older course chats', 'teacher-dashboard': 'Dashboard', 'coordinator-dashboard': 'Dashboard',
  admin: 'Dashboard', catalog: 'Courses', achievements: 'Achievements', gallery: 'Gallery', competitions: 'Competitions', events: 'Events',
  resources: 'Resources', showcase: 'Showcase', notifications: 'Notifications', profile: 'Profile', settings: 'Settings',
  course: 'Course', mashq: 'Mashq worksheets', queue: 'Older courses work', review: 'Review entry', reviews: 'My reviews', assets: 'Asset library',
  judging: 'Judging', 'events-host': 'Host events', 'branch-stats': 'Branch statistics', 'branch-teachers': 'Branch teachers',
  'branch-students': 'Branch students', 'student-profile': 'Student profile', 'teacher-profile-view': 'Teacher profile',
  'admin-courses': 'Course builder', 'admin-tr-numbers': 'TR number uploads', 'admin-users': 'Teacher & load', 'admin-logs': 'Entry logs',
  'admin-showcase': 'Showcase moderation', 'admin-competitions': 'Competitions', 'admin-events': 'Live events',
  'v2-admin-home': 'Home', 'v2-home': 'Dashboard', 'v2-task': 'Your step', 'v2-dept-chat': 'Funun al-Quran Department', 'v2-people': 'People & roles', 'v2-announcements': 'Announcements & surveys', 'v2-teacher-courses': 'All courses', 'v2-badges': 'Badge designs', 'v2-my-progress': 'My progress', 'v2-builder': 'Course builder', 'v2-policies': 'Branch policies', 'v2-logic': 'Logic sets', 'v2-merit': 'Merit points to give',
  'v2-course': 'Course', 'v2-my-merit': 'My badges', 'v2-competitions': 'Competitions & calls', 'v2-inbox': 'Review inbox',
  'v2-scan-return': 'Return scanned work', 'v2-insights': 'Student insights', 'v2-team': 'Team report', 'v2-community': 'Community',
  'admin-resources': 'Resources', 'admin-stats': 'Statistics', 'admin-certificates': 'Certificates & badges', 'admin-governance': 'Data governance',
};

function pageLabel(page: string): string {
  return PAGE_LABELS[page] ?? page.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

/** Sends a signed-in person who lands on the landing page or an unknown address to their own dashboard. */
function dashboardFor(role: Role): string {
  return role === 'admin' ? 'v2-admin-home' : role === 'coordinator' ? 'coordinator-dashboard' : role === 'teacher' ? 'teacher-dashboard' : 'v2-home';
}
function GoToDashboard() {
  useEffect(() => { navigate(dashboardFor(getSessionUser()?.role ?? 'student')); }, []);
  return null;
}

function App() {
  // The hash may carry page details (`#v2-task?courseId=…&stepId=…`): route on the part before "?".
  const fullHash = useHash();
  const page = fullHash.split('?')[0];
  const { t } = useLanguage();
  const [sessionUser, setSessionUser] = useState(() => getSessionUser());
  const userId = sessionUser?.id ?? null;
  const [theme, setTheme] = useState<ThemeName>(() => readThemePreference(getSessionUser()?.id));
  const [activeRequests, setActiveRequests] = useState(getActiveApiRequestCount);
  const [routeLoading, setRouteLoading] = useState(false);
  const [loaderVisible, setLoaderVisible] = useState(false);

  // Re-read the session on every hash change — covers login/logout/signup,
  // which all navigate immediately after touching localStorage.

  const role: Role = sessionUser?.role ?? 'student';
  const dashboardRoute = dashboardFor(role);
  const isLoginPage = page === 'login' || page.startsWith('login-');
  // `survey?t=<token>`: a survey opened from the emailed link — answered without signing in
  const isSurveyLink = page === 'survey';
  const isPublicPage = PUBLIC_PAGES.includes(page) || isLoginPage || page === 'forced-password' || isSurveyLink;

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
    } else if (freshUser?.mustChangePassword && page !== 'forced-password') {
      navigate('forced-password'); // still on the admin-given first password: nothing else opens until it is changed
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
  };

  if (!sessionUser && !isPublicPage) return null;
  if (sessionUser?.mustChangePassword && page !== 'forced-password') return null; // avoid a flash of protected content before the redirect above runs

  const content = (() => {
    // Landing / role selection
    if (page === 'landing') return getSessionUser() ? <GoToDashboard /> : <LandingRoleSelect />;
    if (isSurveyLink) return <V3SurveyByLinkPage />;

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
    if ((page === 'dashboard' || page === 'student') && role === 'student') return <V2StudentHomePage />;
    if (page === 'dashboard' || page === 'student') return <StudentDashboard />;
    if (page === 'catalog') return <Catalog />;
    if (page === 'chats' && role === 'student') return <Chatrooms />;
    if (page === 'mashq' && role === 'student') return <Suspense fallback={<PenLoader label="Loading worksheets…" />}><MashqWorksheets /></Suspense>;
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
    if (page === 'teacher-chats' && role === 'teacher') return <Chatrooms audience="teacher" />;
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

    // v2: manifest course builder, threads, review, merit, insights, communities
    const isStaff = role === 'teacher' || role === 'coordinator' || role === 'admin';
    if (page === 'v2-admin-home' && role === 'admin') return <V2AdminHomePage />;
    if (page === 'v2-home' && role === 'student') return <V2StudentHomePage />;
    if (page === 'v2-task') return <V2TaskPage />;
    if (page === 'v2-dept-chat') return <V2DeptChatPage mode={role === 'student' ? 'student' : 'staff'} />;
    if (page === 'v2-people' && role === 'admin') return <V2PeoplePage />;
    if (page === 'v2-announcements' && role === 'admin') return <V2AnnouncementsPage />;
    if (page === 'v2-teacher-courses' && isStaff) return <V2TeacherCoursesPage />;
    if (page === 'v2-badges' && role === 'admin') return <V2BadgeDesignsPage />;
    if (page === 'v2-my-progress' && role === 'student') return <V2MyProgressPage />;
    if (page === 'v2-builder' && role === 'admin') return <V2CourseBuilderPage />;
    if (page === 'v2-policies' && role === 'admin') return <V2PoliciesPage />;
    if (page === 'v2-logic' && role === 'admin') return <V2LogicSetsPage />;
    if (page === 'v2-merit' && isStaff) return <V2MeritPage />;
    if (page === 'v2-course') return <V2StudentCoursePage />;
    if (page === 'v2-my-merit' && role === 'student') return <V2StudentMeritPage />;
    if (page === 'v2-competitions') return <V2CompetitionsPage mode={role === 'student' ? 'student' : role === 'admin' ? 'admin' : 'staff'} />;
    if (page === 'v2-inbox' && isStaff) return <V2ReviewInboxPage />;
    if (page === 'v2-scan-return' && isStaff) return <V2ScanReturnPage />;
    if (page === 'v2-insights' && isStaff) return <V2InsightsPage />;
    if (page === 'v2-team' && isStaff) return <V2TeamReportPage />;
    if (page === 'v2-community') return <V2CommunityPage mode={role === 'student' ? 'student' : 'staff'} />;

    // Admin portal
    if (page === 'admin' || page.startsWith('admin-')) return <AdminLayout page={page} />;

    return getSessionUser() ? <GoToDashboard /> : <LandingRoleSelect />;
  })();

  const loadingOverlay = loaderVisible && <PenLoader label="Loading your workspace…" global />;

  const assistantShown = Boolean(sessionUser) && (role === 'student' || role === 'teacher' || role === 'coordinator');
  const problemReporting = <ProblemReporting withAssistant={assistantShown} userId={userId} />;

  if (isPublicPage) return <>{content}{loadingOverlay}{problemReporting}</>;

  if (page === 'course') {
    return (
      <div className={`app-layout course-focus-layout${loaderVisible ? ' is-loading' : ''}`}>
        <Fragment key={fullHash}>{content}</Fragment>
        {loadingOverlay}
        {sessionUser && !CHAT_PAGES.has(page) && (role === 'student' || role === 'teacher' || role === 'coordinator') && <AssistantChat key={userId} user={sessionUser} />}
        {problemReporting}
      </div>
    );
  }

  return (
    <div className={`app-layout${loaderVisible ? ' is-loading' : ''}`}>
      <Header role={role} theme={theme} onThemeChange={changeTheme} />
      {sessionUser && <V2AnnouncementBanner />}
      {/* TODO (later): "Install app" prompt hidden for now. Turn back on together with the manifest + sw.js lines in index.html. */}
      {false && sessionUser && <V3InstallAppPrompt />}
      <div className="app-shell-content">
        <nav className="app-breadcrumb" aria-label="Breadcrumb">
          <button onClick={() => navigate(dashboardRoute)}>Dashboard</button>
          <ChevronRight size={14} aria-hidden="true" />
          <strong aria-current="page">{t(pageLabel(page))}</strong>
        </nav>
        <Fragment key={fullHash}>{content}</Fragment>
      </div>
      {loadingOverlay}
      {sessionUser && !CHAT_PAGES.has(page) && (role === 'student' || role === 'teacher' || role === 'coordinator') && <AssistantChat key={userId} user={sessionUser} />}
      {problemReporting}
    </div>
  );
}

export default App;
