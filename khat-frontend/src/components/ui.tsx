import { useLanguage } from '@/language';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, Award, BarChart3, BookOpen, CalendarDays, Check, ChevronRight, ClipboardList, FileImage, FileSpreadsheet, Flame, FolderOpen, GraduationCap, Heart, Home, Images, LayoutDashboard, Library, Lock, LogOut, MapPin, MoreHorizontal, Menu, Palette, PenTool, Play, Search, Settings, ShieldCheck, Trophy, Upload, UserRound, Users, Video, X, Bell, MessageCircle, Inbox, ScanLine, Sparkles, Settings2, UsersRound, Gauge, Megaphone, TrendingUp, Eye, EyeOff } from 'lucide-react';
import type { Script, Role } from '@/data/types';
import { khatTypes, scriptList, branches, type GalleryWork } from '@/data/mock';
import {
  apiFetch, broadcastNotificationsChanged, clearSession, getSessionUser, getViewUrl,
  NOTIFICATION_RECEIVED_EVENT, NOTIFICATIONS_CHANGED_EVENT, PROFILE_PHOTO_UPDATED_EVENT,
  type UserNotification,
} from '@/api';
import { THEME_OPTIONS, type ThemeName } from '@/theme';
// v2 details travel in the address (#v2-task?courseId=…&stepId=…). nav.ts imports navigate from here;
// the cycle is safe because both are only called at click time.
import { openV2, readV2Param } from '@/v2/nav';
import penLoaderImage from '../public/pen-loader.png';

export function navigate(page: string) { window.location.hash = page; }

export function useHash(): string {
  const [page, setPage] = useState(window.location.hash.slice(1) || 'landing');
  useEffect(() => {
    const onHash = () => setPage(window.location.hash.slice(1) || 'landing');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return page;
}

export function Button({ children, onClick, outline = false, className = '', disabled, type, style }: { children: ReactNode; onClick?: () => void; outline?: boolean; className?: string; disabled?: boolean; type?: 'button' | 'submit' | 'reset'; style?: CSSProperties }) {
  return <button onClick={onClick} type={type} disabled={disabled} style={style} className={`btn ${outline ? 'btn-outline' : 'btn-primary'} ${className}`}>{children}</button>;
}

/** Password box with an eye button to show / hide what was typed. */
export function PasswordInput({ value, onChange, placeholder, autoComplete }: { value: string; onChange: (value: string) => void; placeholder?: string; autoComplete?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-input">
      <input className="field" type={visible ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoComplete={autoComplete} />
      <button type="button" className="password-eye" onClick={() => setVisible(v => !v)} aria-label={visible ? 'Hide password' : 'Show password'} aria-pressed={visible}>
        {visible ? <EyeOff size={17} /> : <Eye size={17} />}
      </button>
    </span>
  );
}

export function StatusChip({ children, tone = 'gold' }: { children: ReactNode; tone?: 'gold' | 'green' | 'red' | 'amber' | 'blue' }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function PenLoader({ label = 'Loading…', compact = false, tiny = false, global = false }: { label?: string; compact?: boolean; tiny?: boolean; global?: boolean }) {
  const illustration = (
    <div
      className="pen-loader-visual"
      style={{ '--pen-loader-image': `url("${penLoaderImage}")` } as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="pen-loader-ink-fill" />
    </div>
  );

  if (compact) {
    return (
      <div className={`pen-loader pen-loader-compact${tiny ? ' pen-loader-tiny' : ''}`} role="status" aria-live="polite" aria-label={label}>
        {illustration}
      </div>
    );
  }

  return (
    <div className={`pen-loader-backdrop${global ? ' global-page-loader' : ''}`} role="status" aria-live="polite" aria-label={label}>
      {illustration}
    </div>
  );
}

export function Logo({ admin = false }: { admin?: boolean }) {
  return (
    <button onClick={() => navigate(admin ? 'admin' : 'landing')} className="logo">
      <img className="logo-symbol" src="/funun-logo-white.png" alt="Funun al-Quran" />
      <span>
        <strong>Al-Jamea-tus-Saifiyah</strong>
        <small>{admin ? 'CONTROL PANEL' : 'TEHSEEN AL-KHAT STUDIO'}</small>
      </span>
    </button>
  );
}

const roleNavigation: Record<Role, [string, string, typeof LayoutDashboard][]> = {
  student: [
    ['v2-home', 'Dashboard', Home], ['catalog', 'Courses', GraduationCap], ['v2-my-progress', 'My progress', TrendingUp], ['v2-dept-chat', 'Chat with Funun al-Quran', MessageCircle], ['achievements', 'Achievements', Award], ['gallery', 'Gallery', Images],
    ['v2-competitions', 'Competitions', Trophy], ['events', 'Events', CalendarDays], ['resources', 'Resources', Library],
    ['showcase', 'My showcase', PenTool], ['notifications', 'Notifications', Bell],
  ],
  // The Review inbox only shows work from Course-builder courses; "Older courses work" (the old Review queue) covers the older courses.
  // "Judging" is added only for a teacher who is actually assigned as a judge (see JUDGING_ITEM below).
  teacher: [
    ['teacher-dashboard', 'Dashboard', Home], ['v2-inbox', 'Review inbox', Inbox], ['queue', 'Older courses work', ClipboardList], ['v2-scan-return', 'Upload marked items', ScanLine], ['v2-dept-chat', 'Student messages', MessageCircle], ['teacher-chats', 'Older course chats', MessageCircle],
    ['v2-teacher-courses', 'All courses', BookOpen], ['v2-insights', 'Student insights', Sparkles], ['v2-team', 'Team report', Gauge],
    ['v2-competitions', 'Competitions & calls', Trophy], ['showcase', 'Showcase', PenTool], ['assets', 'Asset library', FolderOpen],
    ['events-host', 'Host events', Video], ['notifications', 'Notifications', Bell],
  ],
  coordinator: [
    ['coordinator-dashboard', 'Dashboard', Home], ['v2-inbox', 'Review inbox', Inbox], ['queue', 'Older courses work', ClipboardList], ['v2-scan-return', 'Upload marked items', ScanLine], ['v2-dept-chat', 'Student messages', MessageCircle],
    ['v2-teacher-courses', 'All courses', BookOpen], ['v2-insights', 'Student insights', Sparkles], ['v2-team', 'Team report', Gauge],
    ['branch-stats', 'Branch statistics', BarChart3], ['branch-teachers', 'Branch teachers', Users], ['branch-students', 'Branch students', GraduationCap],
    ['v2-competitions', 'Competitions & calls', Trophy], ['showcase', 'Showcase', PenTool], ['assets', 'Asset library', FolderOpen],
    ['events-host', 'Host events', Video], ['notifications', 'Notifications', Bell],
  ],
  admin: [
    ['v2-admin-home', 'Home', Home], ['v2-inbox', 'Review inbox', Inbox], ['queue', 'Older courses work', ClipboardList], ['v2-builder', 'Course builder', BookOpen],
    ['v2-insights', 'Student insights', Sparkles], ['v2-merit', 'Merit points', Award], ['v2-policies', 'Branch policies', ShieldCheck],
    ['v2-team', 'Team report', Gauge], ['v2-people', 'People & roles', UsersRound], ['v2-announcements', 'Announcements & surveys', Megaphone],
    ['v2-dept-chat', 'Student messages', MessageCircle], ['v2-badges', 'Badge designs', Trophy], ['notifications', 'Notifications', Bell],
  ],
};

/** Shown in the teacher / coordinator menu only while this teacher is assigned to judge a competition. */
const JUDGING_ITEM: [string, string, typeof LayoutDashboard] = ['judging', 'Judging', Trophy];

/** True when the signed-in teacher is the assigned judge of a competition that is being judged now. */
function useIsAssignedJudge(role: Role, userId: string | undefined): boolean {
  const [assigned, setAssigned] = useState(false);
  useEffect(() => {
    if (!userId || (role !== 'teacher' && role !== 'coordinator')) { setAssigned(false); return; }
    let cancelled = false;
    apiFetch<{ judge_teacher_id?: string | null }[]>('/competitions?status=judging', { silent: true })
      .then(rows => { if (!cancelled) setAssigned(Array.isArray(rows) && rows.some(row => row.judge_teacher_id === userId)); })
      .catch(() => { if (!cancelled) setAssigned(false); });
    return () => { cancelled = true; };
  }, [role, userId]);
  return assigned;
}

type NotificationPresentation = { title: string; body: string };

function notificationPayload(notification: UserNotification): Record<string, unknown> {
  return typeof notification.payload === 'string'
    ? (() => { try { return JSON.parse(notification.payload) as Record<string, unknown>; } catch { return {}; } })()
    : (notification.payload as Record<string, unknown> | null) ?? {};
}

/** Never show internal codes ("FNK-C101 LV01 S05") to anyone reading a pop-up. */
const CODE_PATTERN = /\b[A-Z]{2,5}-[A-Z]?\d{2,4}\b|\bLV\s?\d{1,2}\b|\bS\d{1,2}\b/g;
function withoutCodes(text: string): string {
  return text.replace(CODE_PATTERN, '').replace(/\s{2,}/g, ' ').replace(/^[\s,·—]+/, '').trim();
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? withoutCodes(value.trim()) : null;
}

export function notificationPresentation(notification: UserNotification): NotificationPresentation {
  const payload = notificationPayload(notification);
  const named = text(payload.title);
  const quoted = named ? ` “${named}”` : '';
  const where = text(payload.stepLabel);
  const mark = typeof payload.mark === 'number' ? payload.mark : null;
  const message = text(payload.message);
  const map: Record<string, NotificationPresentation> = {
    // ---- the in-app allow-list (khat-backend/src/services/notify.ts) ----
    work_marked: payload.provisional === true
      ? { title: mark != null ? `Marked ${mark}/10 · your teacher will confirm` : 'Your work has a mark', body: message ?? `${where ? `${where}. ` : ''}Your teacher will look at it soon and confirm the mark. Read the message in the chat.` }
      : { title: mark != null ? `Your work was marked ${mark}/10` : 'Your work has been marked', body: message ?? `${where ? `${where}. ` : ''}Open it to read your teacher’s comments.` },
    work_reviewed: { title: 'Your teacher replied to your work', body: message ?? (where ? `${where}. Open it to read the comments.` : 'Open your task to read the comments.') },
    teacher_replied: { title: 'New message from your teacher', body: where ? `About ${where}. Tap to open the chat.` : (message ?? 'Tap to open the chat.') },
    dept_reply: { title: 'The Funun al-Quran Department replied', body: (message ?? '').replace(/^Funun al-Quran Department:\s*/, '') || 'Tap to read the reply.' },
    new_course: { title: 'A new course is ready for you', body: named ? `${named} has just been added. Take a look!` : 'A new course has just been added. Take a look!' },
    course_created: { title: 'A new course is ready for you', body: named ? `${named} has just been added. Take a look!` : 'A new course has just been added. Take a look!' },
    announcement: { title: named ?? 'A message from Funun al-Quran', body: message ?? 'Tap to read it.' },
    entry_marked: payload.entryKind === 'mashq_marking'
      ? { title: typeof payload.markOutOfTen === 'number' ? `Your Mashq worksheet was marked ${payload.markOutOfTen}/10` : 'Your Mashq worksheet was marked', body: payload.passed === true ? 'Well done! Open it to read your teacher’s comments.' : 'Read your teacher’s comments, practice once more and send it again.' }
      : { title: typeof payload.markOutOfTen === 'number' ? `Your practice was marked ${payload.markOutOfTen}/10` : 'Your practice was marked', body: payload.passed === true ? 'Well done! Open your course to read the comments.' : 'Read your teacher’s comments, practice once more and send it again.' },
    test_result: payload.decision === 'pass'
      ? { title: 'You passed your checkpoint!', body: 'Well done — your next level is now open.' }
      : { title: 'Your checkpoint needs one more try', body: 'Read your teacher’s comments and try again when you are ready.' },
    competition_results: { title: 'Competition results are out', body: named ? `See how you did in${quoted}.` : 'See how you did.' },
    // ---- older types (no longer created, but may still sit in the bell) ----
    badge_earned: { title: 'You earned a new badge!', body: message ?? 'Open My badges to see it.' },
    competition_created: { title: 'A new competition is open', body: named ? `Take part in${quoted}.` : 'Take a look and take part.' },
    certificate_approved: { title: 'Your certificate is ready', body: 'Open Achievements to download it.' },
    event_scheduled: { title: 'A new live class is coming', body: named ? `${named} has been scheduled.` : 'Open Events to see when.' },
    event_live: { title: 'A live class has started', body: named ? `${named} is live now.` : 'Open Events to join.' },
    showcase_moderated: { title: payload.decision === 'approve' ? 'Your work is in the showcase' : 'About your showcase post', body: payload.decision === 'approve' ? 'Everyone in your branch can now see it.' : 'It was looked at and is not shown this time.' },
  };
  return map[notification.type] ?? {
    title: 'New update',
    body: message ?? 'There is something new for you.',
  };
}

/** Where tapping a pop-up takes you (and the parameters the v2 pages read). */
function notificationTarget(notification: UserNotification): { page: string; params: Record<string, string> } {
  const payload = notificationPayload(notification);
  const courseId = typeof payload.courseId === 'string' ? payload.courseId : null;
  const stepId = typeof payload.stepId === 'string' ? payload.stepId : null;
  if (['work_marked', 'work_reviewed', 'teacher_replied'].includes(notification.type) && courseId && stepId) return { page: 'v2-task', params: { courseId, stepId } };
  if (notification.type === 'dept_reply') return { page: 'v2-dept-chat', params: {} };
  return { page: 'notifications', params: {} };
}

/** Pop-ups about the same chat (same step, or the department chat) share one key. */
function toastGroupKey(notification: UserNotification): string {
  const stepId = notificationPayload(notification).stepId;
  if (notification.type === 'teacher_replied' && typeof stepId === 'string') return `chat:${stepId}`;
  if (notification.type === 'dept_reply') return 'chat:dept';
  return `id:${notification.id}`;
}

/** True when the chat this notification is about is already open on screen (then no pop-up). */
function isChatOpenFor(notification: UserNotification): boolean {
  const page = window.location.hash.slice(1).split('?')[0];
  if (notification.type === 'dept_reply') return page === 'v2-dept-chat';
  if (['work_marked', 'work_reviewed', 'teacher_replied'].includes(notification.type)) {
    const stepId = notificationPayload(notification).stepId;
    if (typeof stepId !== 'string') return false;
    if (page === 'v2-task') return readV2Param('stepId') === stepId;
    // an open step chat elsewhere (course window) marks itself with data-thread-step
    return Boolean(document.querySelector(`[data-thread-step="${CSS.escape(stepId)}"]`));
  }
  return false;
}

export function AlertsPage() {
  const [items, setItems] = useState<UserNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      setItems(await apiFetch<UserNotification[]>('/notifications', { silent: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load alerts.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const refresh = () => { void load(); };
    const receive = (event: Event) => {
      const notification = (event as CustomEvent<UserNotification>).detail;
      if (notification?.id) setItems(current => [notification, ...current.filter(item => item.id !== notification.id)].slice(0, 100));
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
    window.addEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
    return () => {
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, refresh);
      window.removeEventListener(NOTIFICATION_RECEIVED_EVENT, receive);
    };
  }, []);

  const markRead = async (notification: UserNotification) => {
    if (notification.read) return;
    setItems(current => current.map(item => item.id === notification.id ? { ...item, read: true } : item));
    await apiFetch(`/notifications/${notification.id}/read`, { method: 'PATCH', silent: true }).catch(() => {});
    broadcastNotificationsChanged();
  };

  const markAllRead = async () => {
    if (!items.some(item => !item.read)) return;
    setMarkingAll(true);
    setItems(current => current.map(item => ({ ...item, read: true })));
    try {
      await apiFetch('/notifications/read-all', { method: 'PATCH', silent: true });
      broadcastNotificationsChanged();
    } catch {
      await load();
    } finally {
      setMarkingAll(false);
    }
  };

  const unreadCount = items.filter(item => !item.read).length;

  return (
    <main className="page portal-page alerts-page">
      <SectionHeading
        eyebrow="Your updates"
        title="Alerts & notifications"
        text="Important updates from your courses, reviews, events, and account."
        action={<Button outline onClick={markAllRead} disabled={markingAll || unreadCount === 0}>{markingAll ? 'Updating…' : 'Mark all read'}</Button>}
      />
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="notification-list alerts-list" aria-live="polite">
        {loading && <p className="muted alerts-empty">Loading your alerts…</p>}
        {!loading && items.length === 0 && <p className="muted alerts-empty">You’re all caught up. New updates will appear here.</p>}
        {items.map(notification => {
          const presentation = notificationPresentation(notification);
          return (
            <button className={`notification alerts-notification${notification.read ? '' : ' unread'}`} key={notification.id} onClick={() => { void markRead(notification); const target = notificationTarget(notification); if (target.page !== 'notifications') openV2(target.page, target.params); }} aria-label={`${presentation.title}${notification.read ? '' : ', unread'}`}>
              <span className="notification-icon"><Bell size={17} /></span>
              <span className="alerts-notification-copy"><strong>{presentation.title}</strong><span>{presentation.body}</span><small>{new Date(notification.created_at).toLocaleString()}</small></span>
              {!notification.read && <span className="alerts-unread-dot" aria-label="Unread" />}
              <ChevronRight className="alerts-notification-arrow" size={16} />
            </button>
          );
        })}
      </div>
    </main>
  );
}

export function Drawer({ open, onClose, children, ariaLabel }: { open: boolean; onClose: () => void; children: React.ReactNode; ariaLabel?: string }) {
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) drawerRef.current?.removeAttribute('inert');
    else drawerRef.current?.setAttribute('inert', '');
  }, [open]);

  return (
    <>
      <div ref={drawerRef} className={`mobile-drawer${open ? ' open' : ''}`} aria-hidden={!open} aria-label={ariaLabel}>
        <div className="mobile-drawer-inner">
          <div className="mobile-drawer-header">
            <button className="mobile-drawer-close" onClick={onClose} aria-label="Close menu" title="Close"><X size={18} /></button>
          </div>
          {children}
        </div>
      </div>
      <div className={`mobile-drawer-backdrop${open ? ' open' : ''}`} onClick={onClose} />
    </>
  );
}

export function Header({
  role,
  theme = 'sky',
  onThemeChange,
}: {
  role: Role;
  theme?: ThemeName;
  onThemeChange?: (theme: ThemeName) => void;
}) {
  const [resolvedAvatarSrc, setResolvedAvatarSrc] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [drawerSearch, setDrawerSearch] = useState('');
  const [search, setSearch] = useState('');
  const [navExpanded, setNavExpanded] = useState(() => window.matchMedia('(min-width: 741px)').matches && localStorage.getItem('khat-sidebar-expanded') === 'true');
  const [hoveredRailLabel, setHoveredRailLabel] = useState<{ label: string; top: number } | null>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [unreadChats, setUnreadChats] = useState(0);
  const [notificationToasts, setNotificationToasts] = useState<UserNotification[]>([]);
  const knownNotificationIds = useRef<Set<string>>(new Set());
  const notificationsLoaded = useRef(false);
  const pendingNotificationToasts = useRef<UserNotification[]>([]);
  const activeNotificationToastIds = useRef<Set<string>>(new Set());
  const activeToastKeys = useRef<Set<string>>(new Set());
  const notificationToastTimers = useRef<Map<string, number>>(new Map());
  const page = useHash();
  const { language, setLanguage, t } = useLanguage();
  const user = getSessionUser();
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const avatarRevision = useRef(0);
  const isJudge = useIsAssignedJudge(role, user?.id);
  const nav = isJudge ? [...roleNavigation[role].slice(0, -2), JUDGING_ITEM, ...roleNavigation[role].slice(-2)] : roleNavigation[role];
  const initials = user ? user.name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase() : '?';

  useEffect(() => {
    let cancelled = false;
    const requestRevision = avatarRevision.current;
    setResolvedAvatarSrc(user?.avatarUrl || user?.avatar || user?.photoURL || null);

    if (user?.id) {
      const profileType = role === 'student' ? 'students' : role === 'admin' ? 'admin/users/me' : 'teachers';
      const profilePath = role === 'admin' ? `/${profileType}/profile` : `/${profileType}/${user.id}/profile`;
      apiFetch<{ photoStorageKey?: string | null; photo_storage_key?: string | null }>(profilePath)
        .then(async profile => {
          const photoKey = profile.photoStorageKey ?? profile.photo_storage_key;
          if (!photoKey) return;
          const url = await getViewUrl(photoKey);
          if (!cancelled && requestRevision === avatarRevision.current) setResolvedAvatarSrc(url);
        })
        .catch(() => {});
    }

    return () => { cancelled = true; };
  }, [role, user?.id, user?.avatarUrl, user?.avatar, user?.photoURL]);

  useEffect(() => {
    const onProfilePhotoUpdated = (event: Event) => {
      const photoUrl = (event as CustomEvent<{ photoUrl?: string }>).detail?.photoUrl;
      if (!photoUrl) return;
      avatarRevision.current += 1;
      setResolvedAvatarSrc(photoUrl);
    };
    window.addEventListener(PROFILE_PHOTO_UPDATED_EVENT, onProfilePhotoUpdated);
    return () => window.removeEventListener(PROFILE_PHOTO_UPDATED_EVENT, onProfilePhotoUpdated);
  }, []);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!profileRef.current?.contains(target)) setProfileOpen(false);
      if (!themeRef.current?.contains(target)) setThemeOpen(false);
      if (!searchRef.current?.contains(target)) setSearch('');
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, []);

  const logout = () => {
    setProfileOpen(false);
    clearSession();
    navigate('landing');
  };
  const handleNav = (href: string) => {
    setSearch('');
    navigate(href);
  };
  const closeMobileMenu = () => {
    setMobileMenuOpen(false);
    setDrawerSearch('');
    hamburgerRef.current?.focus();
  };
  const toggleMobileMenu = () => {
    if (mobileMenuOpen) {
      closeMobileMenu();
      return;
    }
    setDrawerSearch('');
    setMobileMenuOpen(true);
    setProfileOpen(false);
    setThemeOpen(false);
  };
  const profilePage = role === 'admin' ? 'settings' : 'profile';
  const currentSection = nav.find(([href]) => href === page) ?? nav[0];
  const CurrentSectionIcon = currentSection[2];
  const currentSectionLabel = t(currentSection[0] === 'admin' ? 'Dashboard' : currentSection[1]);
  const localizedNav = nav.map(([href, label, Icon]) => [href, t(label), Icon] as const);
  const filteredDrawerNav = localizedNav.filter(([, label]) => label.toLowerCase().includes(drawerSearch.trim().toLowerCase()));
  const normalizedSearch = search.trim().toLowerCase();
  const searchResults = normalizedSearch
    ? localizedNav.filter(([, label]) => label.toLowerCase().includes(normalizedSearch)).slice(0, 5)
    : [];

  const setRailHoverLabel = (label: string, element: HTMLButtonElement) => {
    if (navExpanded || window.matchMedia('(max-width: 740px)').matches) return;
    const bounds = element.getBoundingClientRect();
    setHoveredRailLabel({ label, top: bounds.top + bounds.height / 2 });
  };

  useEffect(() => {
    localStorage.setItem('khat-sidebar-expanded', String(navExpanded));
  }, [navExpanded]);

  useEffect(() => {
    knownNotificationIds.current = new Set();
    notificationsLoaded.current = false;
    pendingNotificationToasts.current = [];
    activeNotificationToastIds.current = new Set();
    activeToastKeys.current = new Set();
    notificationToastTimers.current.forEach(timer => window.clearTimeout(timer));
    notificationToastTimers.current.clear();
    setUnreadNotifications(0);
    setNotificationToasts([]);
    if (!user?.id) return;

    let stopped = false;
    let polling = false;
    const flushToastQueue = () => {
      if (stopped) return;
      const next: UserNotification[] = [];
      while (activeNotificationToastIds.current.size + next.length < 2 && pendingNotificationToasts.current.length) {
        const candidate = pendingNotificationToasts.current.shift()!;
        if (!activeNotificationToastIds.current.has(candidate.id)) next.push(candidate);
      }
      if (!next.length) return;
      next.forEach(notification => { activeNotificationToastIds.current.add(notification.id); activeToastKeys.current.add(toastGroupKey(notification)); });
      setNotificationToasts(current => [...current, ...next].slice(-2));
      next.forEach(notification => {
        const timer = window.setTimeout(() => {
          notificationToastTimers.current.delete(notification.id);
          activeNotificationToastIds.current.delete(notification.id);
          activeToastKeys.current.delete(toastGroupKey(notification));
          setNotificationToasts(current => current.filter(item => item.id !== notification.id));
          flushToastQueue();
        }, 9000);
        notificationToastTimers.current.set(notification.id, timer);
      });
    };
    const enqueueToasts = (notifications: UserNotification[]) => {
      const queuedIds = new Set(pendingNotificationToasts.current.map(item => item.id));
      // several messages in the same chat → one pop-up (the newest words are in the chat anyway)
      const queuedKeys = new Set(pendingNotificationToasts.current.map(toastGroupKey));
      notifications.forEach(notification => {
        if (activeNotificationToastIds.current.has(notification.id) || queuedIds.has(notification.id)) return;
        if (isChatOpenFor(notification)) return; // the message is already on screen
        const key = toastGroupKey(notification);
        if (queuedKeys.has(key) || activeToastKeys.current.has(key)) return;
        queuedKeys.add(key);
        pendingNotificationToasts.current.push(notification);
        queuedIds.add(notification.id);
      });
      flushToastQueue();
    };

    const pollNotifications = async () => {
      if (polling || stopped) return;
      polling = true;
      try {
        const [notifications, unread] = await Promise.all([
          apiFetch<UserNotification[]>('/notifications', { silent: true }),
          apiFetch<{ count: number }>('/notifications/unread-count', { silent: true }),
        ]);
        if (stopped) return;
        setUnreadNotifications(unread.count);
        const fresh = notifications.filter(notification => !notification.read && !knownNotificationIds.current.has(notification.id));
        // The first successful sync happens immediately after login. Surface
        // unread alerts accumulated while the user was away instead of
        // treating that initial response as a silent baseline.
        // On the first sync after opening the site, only pop up alerts from the
        // last 10 minutes (max 3) that were never shown before; older unread ones
        // wait quietly in the bell. Shown ids are remembered across reloads.
        const seenKey = `khat_toasted_${user?.id ?? ''}`;
        let seen: string[] = [];
        try { seen = JSON.parse(localStorage.getItem(seenKey) || '[]'); } catch { seen = []; }
        const recent = (n: UserNotification) => Date.now() - new Date(n.created_at).getTime() < 10 * 60 * 1000;
        const toastsToShow = (notificationsLoaded.current ? fresh : notifications.filter(n => !n.read && recent(n)).slice(0, 3))
          .filter(n => !seen.includes(n.id));
        if (toastsToShow.length) {
          try { localStorage.setItem(seenKey, JSON.stringify([...seen, ...toastsToShow.map(n => n.id)].slice(-200))); } catch { /* storage unavailable */ }
        }
        if (toastsToShow.length) {
          enqueueToasts(toastsToShow);
          broadcastNotificationsChanged();
        }
        notificationsLoaded.current = true;
        notifications.forEach(notification => knownNotificationIds.current.add(notification.id));
        if (knownNotificationIds.current.size > 200) {
          knownNotificationIds.current = new Set(notifications.map(notification => notification.id));
        }
      } catch {
        // Keep the last known badge count while the API is temporarily unavailable.
      } finally {
        polling = false;
      }
    };

    void pollNotifications();
    const interval = window.setInterval(() => { void pollNotifications(); }, 15000);
    const onNotificationsChanged = () => { void pollNotifications(); };
    const onNotificationReceived = (event: Event) => {
      const notification = (event as CustomEvent<UserNotification>).detail;
      if (!notification?.id) return;
      knownNotificationIds.current.add(notification.id);
      setUnreadNotifications(count => count + (notification.read ? 0 : 1));
      enqueueToasts([notification]);
      notificationsLoaded.current = true;
    };
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onNotificationsChanged);
    window.addEventListener(NOTIFICATION_RECEIVED_EVENT, onNotificationReceived);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      notificationToastTimers.current.forEach(timer => window.clearTimeout(timer));
      notificationToastTimers.current.clear();
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onNotificationsChanged);
      window.removeEventListener(NOTIFICATION_RECEIVED_EVENT, onNotificationReceived);
    };
  }, [user?.id]);

  useEffect(() => {
    if (role !== 'student' || !user?.id) { setUnreadChats(0); return; }
    let stopped = false;
    const poll = async () => {
      try {
        const result = await apiFetch<{ courses: { unread_count: number }[]; teachers: { unread_count: number }[] }>('/chat/threads', { silent: true });
        if (!stopped) setUnreadChats([...(result.courses ?? []), ...(result.teachers ?? [])].reduce((sum, row) => sum + Number(row.unread_count || 0), 0));
      } catch { /* Keep the last known unread count while offline. */ }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 15000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [role, user?.id, page]);

  const dismissNotificationToast = (id: string) => {
    const timer = notificationToastTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    notificationToastTimers.current.delete(id);
    activeNotificationToastIds.current.delete(id);
    const dismissed = notificationToasts.find(item => item.id === id);
    if (dismissed) activeToastKeys.current.delete(toastGroupKey(dismissed));
    setNotificationToasts(current => current.filter(item => item.id !== id));
    // The active header effect drains queued login notifications after any
    // displayed toast is dismissed; trigger its normal poll to keep everything
    // synchronized without marking the alert as read.
    broadcastNotificationsChanged();
  };

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMobileMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileMenuOpen]);

  return (
    <>
      <header className={`topbar global-topbar ${role === 'admin' ? 'adminbar' : ''}`}>
        <button ref={hamburgerRef} className="mobile-hamburger-btn" onClick={toggleMobileMenu} aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'} aria-expanded={mobileMenuOpen} title={mobileMenuOpen ? 'Close menu' : 'Open menu'}>
          {mobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
          <span className="icon-tooltip">{mobileMenuOpen ? 'Close menu' : 'Menu'}</span>
        </button>
        <Logo admin={role === 'admin'} />
        <div className="global-search" ref={searchRef}>
          <Search size={16} aria-hidden="true" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder={t('Search menus, pages…')} aria-label={t('Search pages')} />
          <kbd>/</kbd>
          {searchResults.length > 0 && <div className="global-search-results">{searchResults.map(([href, label, Icon]) => <button key={href} onClick={() => handleNav(href)}><Icon size={15} />{label}<ArrowRight size={13} /></button>)}</div>}
        </div>
        <div className="global-topbar-actions">
          {language !== 'en' && <button type="button" className="global-language-toggle" onClick={() => setLanguage('en')} aria-label="Switch to English">English</button>}
          <div className="global-popover-anchor" ref={themeRef}>
            <button className={`global-header-action${themeOpen ? ' active' : ''}`} onClick={() => { setThemeOpen(value => !value); setProfileOpen(false); }} aria-label="Choose theme" aria-expanded={themeOpen} title="Choose theme">
              <Palette size={18} />
              <span className="icon-tooltip">Choose theme</span>
            </button>
            {themeOpen && <div className="global-popover theme-popover"><p className="global-popover-kicker">Color themes</p>{Array.from(new Set(THEME_OPTIONS.map(option => option.family))).map(family => <section className="theme-family-group" key={family}><strong>{family}</strong><div className="theme-swatch-grid" role="group" aria-label={`${family} themes`}>{THEME_OPTIONS.filter(option => option.family === family).map(option => <button key={option.id} className={`theme-swatch${theme === option.id ? ' selected' : ''}`} onClick={() => onThemeChange?.(option.id)} aria-label={`${option.label} theme${theme === option.id ? ', selected' : ''}`} aria-pressed={theme === option.id} title={option.label}><span style={{ background: `linear-gradient(90deg, ${option.colors[0]} 0 33.33%, ${option.colors[1]} 33.33% 66.66%, ${option.colors[2]} 66.66% 100%)` }} /><small>{option.label}</small>{theme === option.id && <Check size={13} />}</button>)}</div></section>)}</div>}
          </div>
          <div className="global-popover-anchor" ref={profileRef}>
            <button className="global-profile-trigger" onClick={() => { setProfileOpen(value => !value); setThemeOpen(false); }} aria-label="Open profile menu" aria-expanded={profileOpen}>
              <span className="global-avatar">{resolvedAvatarSrc ? <img src={resolvedAvatarSrc} alt="" /> : initials}</span>
              <ChevronRight className={profileOpen ? 'rotated' : ''} size={14} />
              <span className="icon-tooltip">Profile</span>
            </button>
            {profileOpen && <div className="global-popover profile-popover"><div className="profile-popover-user"><span className="global-avatar large">{resolvedAvatarSrc ? <img src={resolvedAvatarSrc} alt="" /> : initials}</span><span><strong>{user?.name ?? 'User'}</strong><small>{user?.email ?? role}</small></span></div><div className="profile-popover-divider" /><button onClick={() => handleNav(profilePage)}><UserRound size={16} />My Profile</button><button onClick={logout}><LogOut size={16} />Log Out</button></div>}
          </div>
        </div>
      </header>
      <aside className={`global-side-rail${navExpanded ? ' expanded' : ''}`} aria-label="Main navigation">
        <button className="global-rail-toggle" onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)} onClick={() => setNavExpanded(value => !value)} aria-label={navExpanded ? 'Collapse navigation' : 'Expand navigation'} aria-expanded={navExpanded} aria-controls="global-primary-navigation" title={navExpanded ? 'Collapse navigation' : 'Expand navigation'}>
          <ChevronRight size={18} strokeWidth={2.4} />
        </button>
        {navExpanded && (
          <div className="global-current-section" aria-live="polite">
            <span className="global-current-section-icon"><CurrentSectionIcon size={17} strokeWidth={1.8} /></span>
            <span><small>Current section</small><strong>{currentSectionLabel}</strong></span>
          </div>
        )}
          <nav id="global-primary-navigation">{localizedNav.map(([href, label, Icon]) => <button key={href} className={`global-rail-link${page === href ? ' active' : ''}`} onMouseEnter={event => setRailHoverLabel(label, event.currentTarget)} onMouseLeave={() => setHoveredRailLabel(null)} onFocus={event => setRailHoverLabel(label, event.currentTarget)} onBlur={() => setHoveredRailLabel(null)} onClick={() => handleNav(href)} aria-label={href === 'notifications' && unreadNotifications ? `${label}, ${unreadNotifications} unread` : href === 'chats' && unreadChats ? `${label}, ${unreadChats} unread` : label}><Icon size={18} strokeWidth={1.8} /><span>{label}</span>{href === 'notifications' && unreadNotifications > 0 && <i className="global-rail-badge">{unreadNotifications > 99 ? '99+' : unreadNotifications}</i>}{href === 'chats' && unreadChats > 0 && <i className="global-rail-badge">{unreadChats > 99 ? '99+' : unreadChats}</i>}<ChevronRight className="global-rail-chevron" size={15} /></button>)}</nav>
        <button className="global-rail-link global-settings-link" onMouseEnter={event => setRailHoverLabel('Settings', event.currentTarget)} onMouseLeave={() => setHoveredRailLabel(null)} onFocus={event => setRailHoverLabel('Settings', event.currentTarget)} onBlur={() => setHoveredRailLabel(null)} onClick={() => handleNav('settings')} aria-label="Settings"><Settings size={18} strokeWidth={1.8} /><span>Settings</span><ChevronRight className="global-rail-chevron" size={15} /></button>
      </aside>
      {hoveredRailLabel && !navExpanded && <div className="global-rail-hover-label" style={{ top: hoveredRailLabel.top }} role="tooltip">{hoveredRailLabel.label}</div>}
      {notificationToasts.length > 0 && <div className="global-notification-toasts" aria-live="polite" aria-relevant="additions">
        {notificationToasts.map(notification => {
          const presentation = notificationPresentation(notification);
          return <div className="global-notification-toast" key={notification.id}>
            <button className="global-notification-toast-body" onClick={() => { const target = notificationTarget(notification); dismissNotificationToast(notification.id); setSearch(''); openV2(target.page, target.params); }}>
              <span className="global-notification-toast-icon"><Bell size={16} /></span>
              <span><strong>{presentation.title}</strong><small>{presentation.body}</small></span>
            </button>
            <button className="global-notification-toast-close" aria-label="Dismiss notification" onClick={() => dismissNotificationToast(notification.id)}><X size={14} /></button>
          </div>;
        })}
      </div>}

      {/* Mobile drawer shown when the hamburger is opened */}
      <Drawer open={mobileMenuOpen} onClose={closeMobileMenu} ariaLabel="Main menu">
        <div className="mobile-drawer-current">
          <span className="mobile-drawer-current-icon"><CurrentSectionIcon size={17} /></span>
          <span><small>Current section</small><strong>{currentSection[1]}</strong></span>
        </div>
        <label className="mobile-drawer-search">
          <Search size={16} aria-hidden="true" />
          <input value={drawerSearch} onChange={event => setDrawerSearch(event.target.value)} placeholder={t('Search available menus')} aria-label={t('Search menu items')} />
        </label>
        <nav className="mobile-drawer-nav">
          <button className={`mobile-drawer-item${page === profilePage ? ' active' : ''}`} onClick={() => { handleNav(profilePage); closeMobileMenu(); }} aria-label="My Profile">
            <UserRound size={18} strokeWidth={1.6} />
            <span className="mobile-drawer-label">My Profile</span>
            <ChevronRight className="mobile-drawer-chevron" size={15} />
          </button>
          {filteredDrawerNav.map(([href, label, Icon]) => (
            <button key={href} className={`mobile-drawer-item${page === href ? ' active' : ''}`} onClick={() => { handleNav(href); closeMobileMenu(); }} aria-label={label}>
              <Icon size={18} strokeWidth={1.6} />
              <span className="mobile-drawer-label">{label}</span>
              {href === 'notifications' && unreadNotifications > 0 && <span className="mobile-drawer-badge">{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>}
              {href === 'chats' && unreadChats > 0 && <span className="mobile-drawer-badge">{unreadChats > 99 ? '99+' : unreadChats}</span>}
              <ChevronRight className="mobile-drawer-chevron" size={15} />
            </button>
          ))}
          {filteredDrawerNav.length === 0 && <p className="mobile-drawer-empty">No matching menu items.</p>}
        </nav>
      </Drawer>
    </>
  );
}

export function SectionHeading({ eyebrow, title, text, action, className = '' }: { eyebrow?: string; title: string; text?: string; action?: ReactNode; className?: string }) {
  return (
    <div className={`section-heading ${className}`}>
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <div className="heading-row">
        <div><h2>{title}</h2>{text && <p>{text}</p>}</div>
        {action}
      </div>
    </div>
  );
}

export function ShowcaseHeading({ eyebrow = 'Funun al-Quran', title, text, action }: { eyebrow?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <header className="showcase-page-heading">
      <p className="showcase-heading-eyebrow"><span aria-hidden="true" />{eyebrow}</p>
      <div className="showcase-heading-title-row">
        <h2>{title}</h2>
        {action}
      </div>
      {text && <p className="showcase-heading-description">{text}</p>}
      <span className="showcase-heading-rule" aria-hidden="true" />
    </header>
  );
}

export function ScriptCard({ script, onClick }: { script: Script; onClick?: () => void }) {
  const data = khatTypes[script];
  return (
    <button className="script-card text-left" style={{ '--script': data.color, '--script-soft': data.soft } as React.CSSProperties} onClick={onClick}>
      <div className="arabic">{data.arabic}</div>
      <div><h3>{data.name}</h3><p>{data.desc}</p></div>
      <span className="card-link">Explore {data.name} <ArrowRight size={15} /></span>
    </button>
  );
}

type ActivityHeatmapItem = {
  activity_date: string;
  login_count: number;
};

export function ActivityHeatmap({
  activity = [],
}: {
  activity?: ActivityHeatmapItem[] | null;
}) {
  const activityItems = Array.isArray(activity) ? activity : [];
  const activityByDate = new Map(
    activityItems.filter(item => item && typeof item.activity_date === 'string').map(item => [
      item.activity_date.slice(0, 10),
      Math.max(0, Number(item.login_count) || 0),
    ])
  );

  const days = Array.from({ length: 84 }, (_, index) => {
    const date = new Date();

    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (83 - index));

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const dateKey = `${year}-${month}-${day}`;

    return {
      dateKey,
      logins: activityByDate.get(dateKey) ?? 0,
      date,
    };
  });

  const monthLabels: { label: string; index: number; column: number }[] = [];

  days.forEach((day, index) => {
    const monthKey = `${day.date.getFullYear()}-${day.date.getMonth()}`;

    const previousMonth =
      index > 0
        ? `${days[index - 1].date.getFullYear()}-${days[index - 1].date.getMonth()}`
        : null;

    if (monthKey !== previousMonth) {
      monthLabels.push({
        label: day.date.toLocaleString('en-US', {
          month: 'short',
        }),
        index,
        column: Math.floor(index / 4),
      });
    }
  });

  const activeDays = days.filter(day => day.logins > 0).length;
  const totalLogins = days.reduce((total, day) => total + day.logins, 0);

  return (
    <div className="heatmap-wrap">
      <div className="heatmap-overview">
        <div><span className="heatmap-overview-kicker">12-week summary</span><strong>Daily activity</strong></div>
        <div className="heatmap-stats">
          <span><strong>{activeDays}</strong><small>active days</small></span>
          <i aria-hidden="true" />
          <span><strong>{totalLogins}</strong><small>logins</small></span>
        </div>
      </div>

      <div className="heatmap-chart">
        <div className="heatmap">
          <div className="months">
            {monthLabels.map(month => (
              <span key={`${month.label}-${month.index}`} style={{ left: `${(month.column / 21) * 100}%` }}>
                {month.label}
              </span>
            ))}
          </div>
        {days.map(day => (
          <i
            key={day.dateKey}
            className={`heat-cell heat-level-${day.logins === 0 ? 0 : day.logins === 1 ? 1 : day.logins === 2 ? 2 : day.logins <= 4 ? 3 : 4}`}
            title={`${day.date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} · ${day.logins} ${day.logins === 1 ? 'login' : 'logins'}`}
            data-tooltip={`${day.date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n${day.logins} ${day.logins === 1 ? 'login' : 'logins'}`}
            aria-label={`${day.date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}: ${day.logins} ${day.logins === 1 ? 'login' : 'logins'}`}
            role="img"
            tabIndex={0}
          />
        ))}
        </div>
      </div>

      <div className="heatmap-legend" aria-label="Login activity legend">
        <span>Less</span>
        {[0, 1, 2, 3, 4].map(level => <i key={level} className={`heat-cell heat-level-${level}`} aria-hidden="true" />)}
        <span>More</span>
      </div>
    </div>
  );
}

export function BadgeIcon({ script, tier }: { script: Script; tier: string }) {
  const data = khatTypes[script];
  return (
    <div className="badge-card" style={{ '--script': data.color, '--script-soft': data.soft } as React.CSSProperties}>
      <div className="badge-icon"><Award size={20} /></div>
      <div><strong>{data.name}</strong><small>{tier}</small></div>
    </div>
  );
}

export type ShowcaseFeedPost = {
  id: string;
  role: string;
  imageUrl?: string;
  caption?: string | null;
  authorName?: string | null;
  branch?: string | null;
  likes?: number;
  liked?: boolean;
  artworkWord?: string;
  script?: Script;
  status?: string;
};

export function ShowcasePostCard({ post, onLike }: { post: ShowcaseFeedPost; onLike?: (id: string, liked: boolean) => void }) {
  const scriptData = post.script ? khatTypes[post.script] : null;
  const [liked, setLiked] = useState(false);
  const isLiked = post.liked ?? liked;

  return (
    <article className="gallery-card">
      <div className="gallery-art" style={{ color: scriptData?.color, overflow: 'hidden', padding: post.imageUrl ? 0 : undefined }}>
        {post.imageUrl ? (
          <img src={post.imageUrl} alt={post.caption ?? 'Calligraphy artwork'} />
        ) : post.artworkWord && scriptData ? (
          <><span>{post.artworkWord}</span><small>{scriptData.name}</small></>
        ) : (
          <FileImage size={28} />
        )}
      </div>
      <div className="gallery-meta">
        <div className="showcase-card-caption">
          <strong>{post.caption || 'Untitled piece'}</strong>
          {post.authorName && <small>By {post.authorName}</small>}
        </div>
        {onLike && (
          <button className={`like-btn ${isLiked ? 'liked' : ''}`} onClick={() => { setLiked(!isLiked); onLike(post.id, isLiked); }} aria-pressed={isLiked} aria-label={isLiked ? 'Unlike this post' : 'Like this post'}>
            <Heart size={15} fill={isLiked ? 'currentColor' : 'none'} /> {Number(post.likes ?? 0) + (liked && !post.liked ? 1 : 0)}
          </button>
        )}
        {!onLike && post.likes !== undefined && (
          <span className="like-count" aria-label={`${Number(post.likes)} likes`}><Heart size={15} /> {Number(post.likes)}</span>
        )}
        {post.status && <StatusChip tone={post.status === 'approved' ? 'green' : post.status === 'rejected' ? 'red' : 'amber'}>{post.status}</StatusChip>}
      </div>
      <div className="showcase-card-details">
        <span><MapPin size={13} aria-hidden="true" /><strong>{post.branch || 'Branch not listed'}</strong></span>
      </div>
    </article>
  );
}

export function GalleryCard({ work }: { work: GalleryWork }) {
  return (
    <ShowcasePostCard post={{
      id: `${work.role}-${work.name}-${work.word}`,
      role: work.role,
      caption: work.word,
      authorName: work.name,
      branch: work.branch,
      likes: work.likes,
      artworkWord: work.word,
      script: work.script,
    }} />
  );
}

export function ShowcaseSections({ works }: { works: GalleryWork[] }) {
  const teacherWorks = works.filter(w => w.role === 'teacher');
  const studentWorks = works.filter(w => w.role === 'student');
  return (
    <>
      <section className="page section showcase-section-block">
        <SectionHeading title="Teacher Showcase" text="Work shared by the teachers of your branch." className="showcase-subheading" />
        <div className="gallery-grid">
          {teacherWorks.map(work => (
            <GalleryCard work={work} key={work.word + work.name} />
          ))}
        </div>
      </section>
      <section className="page section showcase-section-block">
        <SectionHeading title="Student Showcase" text="Finished pieces by students of your branch." className="showcase-subheading" />
        <div className="gallery-grid">
          {studentWorks.map(work => (
            <GalleryCard work={work} key={work.word + work.name} />
          ))}
        </div>
      </section>
    </>
  );
}

export function ShowcaseFeedSections({ posts, onLike }: { posts: ShowcaseFeedPost[]; onLike?: (id: string, liked: boolean) => void }) {
  const teacherPosts = posts.filter(post => post.role.toLowerCase() === 'teacher');
  const studentPosts = posts.filter(post => post.role.toLowerCase() === 'student');

  return (
    <div className="showcase-feed-sections">
      <section className="showcase-feed-section showcase-section-block">
        <SectionHeading title="Teacher Showcase" text="Work shared by the teachers of your branch." className="showcase-subheading" />
        <div className="gallery-grid">
          {teacherPosts.map(post => <ShowcasePostCard key={post.id} post={post} onLike={onLike} />)}
          {teacherPosts.length === 0 && <p className="muted showcase-feed-empty">No teacher posts to show yet.</p>}
        </div>
      </section>
      <section className="showcase-feed-section showcase-section-block">
        <SectionHeading title="Student Showcase" text="Finished pieces by students of your branch." className="showcase-subheading" />
        <div className="gallery-grid">
          {studentPosts.map(post => <ShowcasePostCard key={post.id} post={post} onLike={onLike} />)}
          {studentPosts.length === 0 && <p className="muted showcase-feed-empty">No student posts to show yet.</p>}
        </div>
      </section>
    </div>
  );
}

export function DashboardShowcaseCarousels({ posts, onLike }: { posts: ShowcaseFeedPost[]; onLike?: (id: string, liked: boolean) => void }) {
  const teacherPosts = posts.filter(post => post.role.toLowerCase() === 'teacher');
  const studentPosts = posts.filter(post => post.role.toLowerCase() === 'student');

  const carousel = (title: string, text: string, items: ShowcaseFeedPost[]) => (
    <ShowcaseCarousel key={title} title={title} text={text} posts={items} onLike={onLike} />
  );

  return (
    <div className="dashboard-showcase-carousels">
      {carousel('Teacher Showcase', 'Work shared by the teachers of your branch.', teacherPosts)}
      {carousel('Student Showcase', 'Finished pieces by students of your branch.', studentPosts)}
    </div>
  );
}

function ShowcaseCarousel({ title, text, posts, onLike }: { title: string; text: string; posts: ShowcaseFeedPost[]; onLike?: (id: string, liked: boolean) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pageCount, setPageCount] = useState(1);

  const getStep = () => {
    const viewport = viewportRef.current;
    const card = viewport?.querySelector<HTMLElement>('.showcase-carousel-slide');
    if (!viewport || !card) return 0;
    const styles = window.getComputedStyle(viewport);
    return card.getBoundingClientRect().width + (Number.parseFloat(styles.columnGap || styles.gap) || 0);
  };

  const move = (direction: 1 | -1) => {
    const viewport = viewportRef.current;
    const step = getStep();
    if (!viewport || !step) return;
    const maxScroll = viewport.scrollWidth - viewport.clientWidth;
    const next = viewport.scrollLeft + step * direction;
    viewport.scrollTo({ left: direction > 0 && next >= maxScroll - 2 ? 0 : Math.max(0, next), behavior: 'smooth' });
  };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const updateActive = () => {
      const step = getStep();
      if (step) {
        const pages = Math.max(1, Math.ceil((viewport.scrollWidth - viewport.clientWidth) / step) + 1);
        setPageCount(pages);
        setActiveIndex(Math.min(pages - 1, Math.round(viewport.scrollLeft / step)));
      }
    };
    updateActive();
    viewport.addEventListener('scroll', updateActive, { passive: true });
    window.addEventListener('resize', updateActive);
    return () => {
      viewport.removeEventListener('scroll', updateActive);
      window.removeEventListener('resize', updateActive);
    };
  }, [posts.length]);

  useEffect(() => {
    if (pageCount < 2) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') move(1);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [pageCount]);

  const goTo = (index: number) => {
    const step = getStep();
    viewportRef.current?.scrollTo({ left: step * index, behavior: 'smooth' });
  };

  return (
    <section className="showcase-carousel-section" aria-label={title}>
      <SectionHeading
        title={title}
        text={text}
        className="showcase-subheading"
        action={pageCount > 1 ? (
          <div className="showcase-carousel-controls">
            <button type="button" onClick={() => move(-1)} aria-label={`Previous ${title.toLowerCase()} post`}><ChevronRight size={17} /></button>
            <button type="button" onClick={() => move(1)} aria-label={`Next ${title.toLowerCase()} post`}><ChevronRight size={17} /></button>
          </div>
        ) : undefined}
      />
      {posts.length === 0 ? (
        <p className="muted showcase-carousel-empty">No posts to show yet.</p>
      ) : (
        <>
          <div
            className="showcase-carousel-viewport"
            ref={viewportRef}
          >
            {posts.map(post => (
              <div className="showcase-carousel-slide" key={post.id}>
                <ShowcasePostCard post={post} onLike={onLike} />
              </div>
            ))}
          </div>
          {pageCount > 1 && (
            <div className="showcase-carousel-dots" aria-label={`${title} slides`}>
              {Array.from({ length: pageCount }, (_, index) => (
                <button key={index} type="button" className={activeIndex === index ? 'active' : ''} onClick={() => goTo(index)} aria-label={`Show slide ${index + 1}`} aria-current={activeIndex === index ? 'true' : undefined} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function StatCard({ icon: Icon, value, label, trend }: { icon: typeof Award; value: string; label: string; trend?: string }) {
  return (
    <div className="stat-card">
      <Icon size={19} />
      <strong>{value}</strong>
      <span>{label}</span>
      {trend && <small>{trend}</small>}
    </div>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="page footer-inner">
        <div>
          <Logo />
          <p>Five minutes a day. That's the whole secret.</p>
        </div>
        <div className="footer-branches">
          <small>Study across five branches</small>
          <div>{branches.map((b: string) => <span key={b}>{b}</span>)}</div>
        </div>
      </div>
    </footer>
  );
}

export function ScriptTabs({ script, setScript }: { script: Script; setScript: (s: Script) => void }) {
  return (
    <div className="tabs small">
      {scriptList.map(item => (
        <button key={item} className={item === script ? 'active' : ''} onClick={() => setScript(item)}>{khatTypes[item].name}</button>
      ))}
    </div>
  );
}

export function UploadBox({ tall, label, sublabel, icon: Icon = Upload, onChange, accept = 'image/*' }: { tall?: boolean; label: string; sublabel: string; icon?: typeof Upload; onChange?: (file: File) => void; accept?: string }) {
  const [dragging, setDragging] = useState(false);
  const chooseFile = (file?: File) => {
    if (file && onChange) onChange(file);
  };

  return (
    <label
      className={`upload-box ${tall ? 'tall' : ''}${dragging ? ' is-dragging' : ''}`}
      onDragEnter={event => { event.preventDefault(); setDragging(true); }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={event => { if (event.currentTarget === event.target) setDragging(false); }}
      onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files?.[0]); }}
    >
      <Icon size={tall ? 24 : 22} />
      <strong>{label}</strong>
      <small>{dragging ? 'Drop to add this file' : sublabel}</small>
      <input type="file" accept={accept} onChange={e => chooseFile(e.target.files?.[0])} />
    </label>
  );
}

export function Modal({ children, onClose, className = '' }: { children: ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className={`modal ${className}`} onClick={e => e.stopPropagation()}>
        {onClose && <button className="modal-close" onClick={onClose}><X size={18} /></button>}
        {children}
      </div>
    </div>
  );
}

export function BackLink({ to, label }: { to: string; label: string }) {
  return <button className="back-link" onClick={() => navigate(to)}>← {label}</button>;
}

export { ArrowRight, ChevronRight, Flame, Lock, MoreHorizontal, Play };
