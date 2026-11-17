import { V2StudentCatalogSection } from '@/v2/student/StudentCatalogSection';
import { V2DashboardHighlights } from '@/v2/competitions/DashboardHighlights';
import { V3AchievementsPage } from '@/v2/content/AchievementsPage';
import { V3MyShowcasePage } from '@/v2/content/MyShowcasePage';
import { V3EventsPage } from '@/v2/content/EventsPage';
import { V3OlderCoursesSection } from '@/v2/content/OlderCoursesSection';
import '@/v2/content/content-v3.css';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Award, Bell, BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardList, ExternalLink, FileImage, FileText, FileVideo, Flame, Lock, MessageCircle, Pause, Play, Search, Sparkles, Trophy, Upload, X,
  Clock, Download,
} from 'lucide-react';
import type { Script } from '@/data/types';
import {
  khatTypes, scriptList,
  scriptToCode, scriptFromCode,
  galleryWorks,
  displayCourseTitle,
} from '@/data/mock';
import {
  navigate, Button, SectionHeading, StatusChip, BadgeIcon, ActivityHeatmap,
  StatCard, UploadBox, Modal, BackLink, ShowcaseSections, ShowcaseFeedSections, DashboardShowcaseCarousels, ShowcaseHeading, Footer, PenLoader,
} from '@/components/ui';
import {
  apiFetch,
  uploadFile,
  getDownloadUrl,
  getFileObjectUrl,
  getViewUrl,
  getSessionUser,
  ApiError,
} from '@/api';
import { FixedReportsCard } from '@/components/ReportProblem';
import './StudentCourseStyles.css';
import { useLanguage } from '@/language';
import { openCourseLevel, useCourseSession } from '@/courseSession';
import { CourseJourney } from '@/components/CourseJourney';
import '@/components/StudentCourseOverview.css';
import '@/components/CourseEnvironmentLesson.css';
const ResourcePdfViewer = lazy(() => import('@/components/ResourcePdfViewer'));
const ResourceBookCover = lazy(() => import('@/components/ResourcePdfViewer').then(module => ({ default: module.ResourceBookCover })));

type ApiMediaItem = { kind: 'video' | 'image' | 'pdf'; storageKey: string; originalFilename?: string };
type SheetSize = '1mm' | '2mm' | '3mm';
const SHEET_SIZES: SheetSize[] = ['1mm', '2mm', '3mm'];
type ApiSheetFiles = Partial<Record<SheetSize, { storageKey: string; originalFilename?: string }>>;
type ApiLevel = {
  id: string; course_id: string; order_index: number; level_type: 'mufradat' | 'writing' | 'test';
  title: string; media: ApiMediaItem[]; sheet_files: ApiSheetFiles; badge_tier: string | null; locked?: boolean;
};
type ApiCourse = { id: string; khat_type_id: string; category: string; title: string; description?: string; guidance_question?: string | null };
type ApiEnrollment = { id: string; current_level_index: number; percent_complete: string | number; status: string; enrolled_at?: string };
type ApiSecondaryCourse = { course: ApiCourse; enrollment: ApiEnrollment | null; levels: ApiLevel[] };
type ApiKhatType = { id: string; code: string; display_name: string };
type ApiDashboardEntry = {
  id: string;
  source_type: string;
  level_id?: string | null;
  created_at: string;
  time_spent_minutes?: number | null;
  mark_out_of_ten?: number | null;
  status?: string;
  entry_kind?: string | null;
};
const mashqSetSamples = [
  { key: 'qs', category: 'Al-Qasāʾid al-Sharīfa', title: 'Hubbi Lakum', year: '1445H', sheetCount: 8, firstLevel: 0, levelCount: 2 },
  { key: 'ms', category: 'Munājāt Sharīfa', title: 'ʿAbduka Rabbi', year: '1447H', sheetCount: 6, firstLevel: 2, levelCount: 2 },
  { key: 'rh', category: 'Rawḍat al-Hidāyāt', title: 'Rawḍat al-Hidāyāt', year: '', sheetCount: 10, firstLevel: 4, levelCount: 1 },
];
type ApiEvent = {
  id: string;
  host_teacher_id: string;
  branch_id: string;
  title: string;
  description?: string | null;
  scheduled_at: string;
  recording_storage_key?: string | null;
  recording_status?: 'processing' | 'ready' | null;
  status: 'scheduled' | 'live' | 'ended';
  created_at: string;
  host_name: string;
  branch_name: string;
};



type ApiCheckpoint = {
  id: string;
  source_type: 'checkpoint';
  level_id: string | null;
  khat_image_storage_key: string;
  original_filename?: string | null;
  status: 'pending' | 'assigned' | 'in_review' | 'reviewed' | 'redo_needed';
  feedback?: string | null;
  reviewed_at?: string | null;
  reviewed_by_name?: string | null;
  correction_image_storage_key?: string | null;
  correction_voice_storage_key?: string | null;
  submissionImageUrl?: string | null;
  correctionImageUrl?: string | null;
  correctionVoiceUrl?: string | null;
  created_at: string;
  level_title?: string | null;
  khat_type_id?: string | null;
};

function formatVoiceTime(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function StudentVoicePlayer({ src, title = 'Voice feedback' }: { src: string; title?: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    audioRef.current?.load();
  }, [src]);

  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    else { audio.pause(); setPlaying(false); }
  };

  const seek = (value: number) => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = audio.duration * value / 100;
    setCurrentTime(audio.currentTime);
  };

  const progress = Math.min(100, currentTime / Math.max(duration, 0.01) * 100);
  return (
    <div className="student-voice-player">
      <strong>{title}</strong>
      <audio ref={audioRef} src={src} preload="metadata" onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }} onEnded={() => setPlaying(false)} />
      <div className="voice-message-bar student-voice-message-bar">
        <button type="button" className="voice-message-play" onClick={togglePlayback} aria-label={playing ? 'Pause voice feedback' : 'Play voice feedback'}>{playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        <span className="voice-message-time">{formatVoiceTime(currentTime)}</span>
        <div className="voice-message-waveform voice-message-seek">
          {Array.from({ length: 42 }, (_, index) => <i key={index} className={index / 41 <= progress / 100 ? 'played' : ''} style={{ '--wave-height': `${18 + ((index * 37 + 13) % 76)}%` } as React.CSSProperties} />)}
          <input type="range" min="0" max="100" value={progress} onChange={event => seek(Number(event.target.value))} aria-label="Seek through voice feedback" />
        </div>
        <span className="voice-message-time">{formatVoiceTime(duration)}</span>
      </div>
    </div>
  );
}

type ApiBadge = {
  id: string;
  student_id: string;
  khat_type_id: string;
  tier: 'foundation' | 'composition' | 'mastery' | 'ijazah';
  awarded_at: string;
  khat_type_code: string;
  khat_type_name: string;
};
type ApiBadgeArtwork = { key: string; filename: string; mediaType: 'image' | 'pdf'; url: string | null };
type ApiActivity = {
  activity_date: string;
  login_count: number;
};

type ActivityHeatmapItem = {
  activity_date: string;
  login_count: number;
};


function scriptCode(script: Script): string {
  return scriptToCode(script);
}

function scriptForCourseCode(code: string): Script {
  return scriptFromCode(code.replace(/_normal_pen$/, '')) ?? 'Naskh';
}

function dashboardCourseOrder(code: string): number {
  const script = scriptFromCode(code) ?? scriptForCourseCode(code);
  return dashboardScriptOrder.indexOf(script);
}

function courseGuidanceQuestion(course: ApiCourse, script?: Script): string {
  if (course.guidance_question?.trim()) return course.guidance_question;
  const subject = script ? khatTypes[script].name : course.title;
  return course.category === 'certification'
    ? `Would you like to develop your ${subject} handwriting and earn a certificate?`
    : `Would you like to explore ${subject} at your own pace?`;
}

const CATALOG_SCRIPT_KEY = 'khat_catalog_script';
const CATALOG_COURSE_KEY = 'khat_catalog_course';
const CHAT_COURSE_REQUEST_KEY = 'khat_chat_course_request';
const MASHQ_FILTER_KEY = 'khat_mashq_filter';
// Dashboard shows one course group at a time; the student's last choice is remembered on this device.
const COURSE_TAB_KEY = 'khat_course_tab';
const COURSE_TABS = [
  { id: 'certification', label: 'Certification courses' },
  { id: 'crash', label: 'Crash courses' },
  { id: 'mashq', label: 'Mashq worksheets' },
] as const;
type CourseTab = (typeof COURSE_TABS)[number]['id'];
const dashboardScriptOrder: Script[] = ['Naskh', 'Sulus', 'Nastaaleeq', 'Istinsaakh', 'Tehseen Al Khat', 'Naskh (Normal Pen)'];

function navigateToCatalogForCourse(courseId: string, script: Script = 'Naskh') {
  window.sessionStorage.setItem(CATALOG_COURSE_KEY, courseId);
  window.sessionStorage.setItem(CATALOG_SCRIPT_KEY, script);
  navigate('catalog');
}

function openDashboardCourse(course: ApiCourse, khatType: ApiKhatType) {
  navigateToCatalogForCourse(course.id, scriptForCourseCode(khatType.code));
}


function navigateToMashqWorksheets(filter = 'all') {
  window.sessionStorage.setItem(MASHQ_FILTER_KEY, filter);
  navigate('catalog'); // v3: Mashq worksheets are courses now
}


export function StudentLandingPage() {
  return (
    <>
      <section className="hero page">
        <div className="hero-copy">
          <p className="eyebrow">A free program of Al-Jamea-tus-Saifiyah</p>
          <h1>Study Arabic calligraphy, free, <em>one measured stroke at a time.</em></h1>
          <p className="hero-lede">Three cut-pen traditions, plus a dedicated Naskh course for the ordinary pen — taught across five branches, open to every student at no cost.</p>
          <div className="hero-actions">
            <Button onClick={() => navigate('dashboard')}>Go to Your Path <ArrowRight size={17} /></Button>
            <button className="text-link" onClick={() => navigate('catalog')}>Browse the curriculum <ArrowRight size={15} /></button>
          </div>
        </div>
      </section>
      <main>
        <ShowcaseSections works={galleryWorks} />
        <section className="page section">
          <div className="winner-strip">
            <div>
              <Trophy size={18} />
              <div><strong>Latest competition winners</strong><span>Celebrating patience, proportion, and practice.</span></div>
            </div>
            <button onClick={() => navigate('v2-competitions')}>See results <ArrowRight size={15} /></button>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

export function StudentDashboard() {
  const { t } = useLanguage();
  type DashboardCourse = {
    course: ApiCourse;
    khatType: ApiKhatType;
    enrollment: ApiEnrollment | null;
    progress: number;
    levels: ApiLevel[];
  };

  const [courses, setCourses] = useState<DashboardCourse[]>([]);
  const [secondaryCourses, setSecondaryCourses] = useState<ApiSecondaryCourse[]>([]);
  const [penTrack, setPenTrack] = useState<'cut' | 'normal'>('normal');
  const [selectedCutStyles, setSelectedCutStyles] = useState<Record<'naskh' | 'istinsaakh', 1 | 2>>({ naskh: 1, istinsaakh: 1 });
  const [secondaryFilter, setSecondaryFilter] = useState<string | 'all'>('all');
  const [courseTab, setCourseTab] = useState<CourseTab>(() => {
    try { return COURSE_TABS.some(tab => tab.id === localStorage.getItem(COURSE_TAB_KEY)) ? localStorage.getItem(COURSE_TAB_KEY) as CourseTab : 'certification'; } catch { return 'certification'; }
  });
  const chooseCourseTab = (tab: CourseTab) => {
    setCourseTab(tab);
    try { localStorage.setItem(COURSE_TAB_KEY, tab); } catch { /* storage blocked: just don't remember it */ }
  };
  const [secondaryLoading, setSecondaryLoading] = useState(true);
  const [secondaryError, setSecondaryError] = useState<string | null>(null);

  const [showcasePosts, setShowcasePosts] = useState<{
    id: string;
    author_name: string;
    user_role?: string;
    caption: string | null;
    image_storage_key?: string | null;
    imageStorageKey?: string | null;
    imageUrl?: string;
    branch_name?: string | null;
    branch?: string | null;
    like_count: string | number;
    liked_by_me: boolean;
  }[]>([]);
  const [showcaseLoading, setShowcaseLoading] = useState(true);
  const [winners, setWinners] = useState<{ competitionTitle: string; student_name: string }[]>([]);
  
  useEffect(() => {
    let cancelled = false;
    apiFetch<{ id: string; author_name: string; user_role?: string; caption: string | null; image_storage_key?: string | null; imageStorageKey?: string | null; branch_name?: string | null; branch?: string | null; like_count: string | number; liked_by_me: boolean }[]>('/showcase')
      .then(async list => {
        const resolvedPosts = await Promise.all(list.map(async post => {
          const imageKey = post.image_storage_key ?? post.imageStorageKey;
          if (!imageKey) return post;
          try {
            return { ...post, imageUrl: await getViewUrl(imageKey) };
          } catch {
            return post;
          }
        }));
        if (!cancelled) setShowcasePosts(resolvedPosts);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setShowcaseLoading(false);
      });
    apiFetch<{ id: string; title: string; results_published_at: string | null }[]>('/competitions?status=completed').then(async list => {
      const published = list.filter(c => c.results_published_at).slice(0, 3);
      const all = await Promise.all(published.map(async c => {
        const w = await apiFetch<{ student_name: string }[]>(`/competitions/${c.id}/winners`).catch(() => []);
        return w.map(win => ({ competitionTitle: c.title, student_name: win.student_name }));
      }));
      if (!cancelled) setWinners(all.flat());
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [practiceEntries, setPracticeEntries] = useState<ApiDashboardEntry[]>([]);

  // Dashboard events
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  // Latest checkpoint
  const [latestCheckpoint, setLatestCheckpoint] =
    useState<ApiCheckpoint | null>(null);
  const [latestCheckpointReview, setLatestCheckpointReview] = useState<ApiCheckpoint | null>(null);
  const [checkpointLoading, setCheckpointLoading] =
    useState(true);

  const [badges, setBadges] = useState<ApiBadge[]>([]);
  const [badgeArtwork, setBadgeArtwork] = useState<ApiBadgeArtwork[]>([]);
  const [badgesLoading, setBadgesLoading] = useState(true);

  const [activity, setActivity] = useState<ApiActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);

  const dayStreak = calculateDayStreak(activity);

  useEffect(() => {
    let cancelled = false;

    async function loadSecondaryCourses() {
      setSecondaryLoading(true);
      setSecondaryError(null);
      try {
        const [types, availableCourses] = await Promise.all([
          apiFetch<ApiKhatType[]>('/khat-types'),
          apiFetch<ApiCourse[]>('/courses?category=secondary'),
        ]);
        const coursesWithProgress = await Promise.all(availableCourses.map(async course => {
          const authoredLevels = await apiFetch<ApiLevel[]>(`/courses/${course.id}/levels`);
          try {
            const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(`/levels/courses/${course.id}/progress`);
            return { course, enrollment: progress.enrollment, levels: progress.levels };
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return { course, enrollment: null, levels: authoredLevels };
            }
            throw err;
          }
        }));
        if (!cancelled) {
          setKhatTypesList(types);
          setSecondaryCourses(coursesWithProgress.sort((a, b) => {
            const aCode = types.find(type => type.id === a.course.khat_type_id)?.code ?? '';
            const bCode = types.find(type => type.id === b.course.khat_type_id)?.code ?? '';
            return dashboardCourseOrder(aCode) - dashboardCourseOrder(bCode);
          }));
        }
      } catch (err) {
        if (!cancelled) setSecondaryError(err instanceof ApiError ? err.message : 'Could not load secondary courses.');
      } finally {
        if (!cancelled) setSecondaryLoading(false);
      }
    }

    void loadSecondaryCourses();
    return () => { cancelled = true; };
  }, []);

  const toggleShowcaseLike = async (id: string, liked: boolean) => {
    try {
      const result = await apiFetch<{ likeCount: number; likedByMe: boolean }>(`/showcase/${id}/like`, {
        method: liked ? 'DELETE' : 'POST',
      });
      setShowcasePosts(posts => posts.map(post => post.id === id
        ? { ...post, like_count: result.likeCount, liked_by_me: result.likedByMe }
        : post));
    } catch {
      // Keep the last confirmed count if the like request fails.
    }
  };

  useEffect(() => {
    let cancelled = false;

    async function loadDashboardCourses() {
      setLoading(true);
      setError(null);

      try {
        const fetchedKhatTypes =
          await apiFetch<ApiKhatType[]>('/khat-types');

        if (!cancelled) {
          setKhatTypesList(fetchedKhatTypes);
        }

        const certificationCourses = await apiFetch<ApiCourse[]>(('/courses?category=certification'));
        const results = await Promise.all(certificationCourses.map(async course => {
          const khatType = fetchedKhatTypes.find(item => item.id === course.khat_type_id);
          if (!khatType) return null;
          const authoredLevels = await apiFetch<ApiLevel[]>(`/courses/${course.id}/levels`);
          try {
            const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(`/levels/courses/${course.id}/progress`);
            return { course, khatType, enrollment: progress.enrollment, progress: Number(progress.enrollment.percent_complete ?? 0), levels: progress.levels };
          } catch (err) {
            if (!(err instanceof ApiError) || err.status !== 404) throw err;
            return { course, khatType, enrollment: null, progress: 0, levels: authoredLevels };
          }
        }));

        if (!cancelled) setCourses(results.filter((item): item is DashboardCourse => item !== null)
          .sort((a, b) => dashboardCourseOrder(a.khatType.code) - dashboardCourseOrder(b.khatType.code)));
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load your courses.'
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    async function loadDashboardEvents() {
      setEventsLoading(true);

      try {
        const allEvents =
          await apiFetch<ApiEvent[]>('/events');

        const upcoming = allEvents
          .filter(
            event =>
              event.status === 'scheduled' ||
              event.status === 'live'
          )
          .sort(
            (a, b) =>
              new Date(a.scheduled_at).getTime() -
              new Date(b.scheduled_at).getTime()
          )
          .slice(0, 3);

        if (!cancelled) {
          setEvents(upcoming);
        }
      } catch (err) {
        console.error(
          'Failed to load dashboard events:',
          err
        );

        if (!cancelled) {
          setEvents([]);
        }
      } finally {
        if (!cancelled) {
          setEventsLoading(false);
        }
      }
    }

    async function loadDashboardActivity() {
      setActivityLoading(true);
    
      try {
        const user = getSessionUser();
    
        if (!user) {
          setActivity([]);
          return;
        }
    
        const [profile, entries] = await Promise.all([
          apiFetch<{ activity: ApiActivity[]; levelSubmissions?: { id: string; submitted_at: string; time_spent_minutes: number; course_category?: string }[] }>(`/students/${user.id}/profile`),
          apiFetch<ApiDashboardEntry[]>('/entries/mine'),
        ]);
    
        if (!cancelled) {
          setActivity(profile.activity ?? []);
          const legacyPractice = (profile.levelSubmissions ?? []).map(submission => ({
            id: submission.id,
            source_type: 'legacy_practice',
            created_at: submission.submitted_at,
            time_spent_minutes: submission.time_spent_minutes,
            entry_kind: submission.course_category === 'secondary' ? 'secondary_marking' : 'practice_marking',
          }));
          setPracticeEntries([...entries, ...legacyPractice]);
        }
      } catch (err) {
        console.error('Failed to load dashboard activity:', err);
    
        if (!cancelled) {
          setActivity([]);
        }
      } finally {
        if (!cancelled) {
          setActivityLoading(false);
        }
      }
    }

    async function loadLatestCheckpoint() {
      setCheckpointLoading(true);

      try {
        /*
         * /entries/mine already returns the student's
         * entries ordered by created_at DESC.
         *
         * We only need the first checkpoint entry.
         */
        const entries = await apiFetch<ApiCheckpoint[]>('/entries/mine');
        const checkpoints = entries.filter(entry => entry.source_type === 'checkpoint');
        const checkpoint = checkpoints[0] ?? null;
        const reviewedCheckpoint = checkpoints.find(entry => entry.level_id === checkpoint?.level_id && (entry.status === 'reviewed' || entry.status === 'redo_needed')) ?? null;
        const resolveCheckpointFiles = async (item: ApiCheckpoint | null): Promise<ApiCheckpoint | null> => {
          if (!item) return null;
          const [submissionImageUrl, correctionImageUrl, correctionVoiceUrl] = await Promise.all([
            item.khat_image_storage_key ? getViewUrl(item.khat_image_storage_key).catch(() => null) : Promise.resolve(null),
            item.correction_image_storage_key ? getViewUrl(item.correction_image_storage_key).catch(() => null) : Promise.resolve(null),
            item.correction_voice_storage_key ? getViewUrl(item.correction_voice_storage_key).catch(() => null) : Promise.resolve(null),
          ]);
          return { ...item, submissionImageUrl, correctionImageUrl, correctionVoiceUrl };
        };
        const [checkpointWithFiles, reviewedWithFiles] = await Promise.all([
          resolveCheckpointFiles(checkpoint),
          resolveCheckpointFiles(reviewedCheckpoint),
        ]);

        if (!cancelled) {
          setLatestCheckpoint(checkpointWithFiles);
          setLatestCheckpointReview(reviewedWithFiles);
        }
      } catch (err) {
        console.error(
          'Failed to load latest checkpoint:',
          err
        );

        if (!cancelled) {
          setLatestCheckpoint(null);
          setLatestCheckpointReview(null);
        }
      } finally {
        if (!cancelled) {
          setCheckpointLoading(false);
        }
      }
    }

    async function loadDashboardBadges() {
      setBadgesLoading(true);
    
      try {
        const [studentBadges, artwork] = await Promise.all([
          apiFetch<ApiBadge[]>('/badges'),
          apiFetch<ApiBadgeArtwork[]>('/badges/assets').catch(() => []),
        ]);
    
        if (!cancelled) {
          setBadges(studentBadges);
          setBadgeArtwork(artwork);
        }
      } catch (err) {
        console.error('Failed to load dashboard badges:', err);
    
        if (!cancelled) {
          setBadges([]);
        }
      } finally {
        if (!cancelled) {
          setBadgesLoading(false);
        }
      }
    }

    loadDashboardCourses();
    loadDashboardEvents();
    loadLatestCheckpoint();
    loadDashboardBadges();
    loadDashboardActivity();

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Map the backend checkpoint's khat_type_id to the
   * frontend Script value.
   *
   * Backend:
   *   khat_type_id -> ApiKhatType.id
  *   ApiKhatType.code -> "naskh", "naskh_normal_pen", "sulus", "nastaaleeq"
   *
   * Frontend:
  *   Script -> the matching cut-pen or normal-pen script label
   */
  const checkpointScript =
    latestCheckpoint?.khat_type_id
      ? (() => {
          const checkpointKhatType =
            khatTypesList.find(
              khatType =>
                khatType.id ===
                latestCheckpoint.khat_type_id
            );

          if (!checkpointKhatType) {
            return undefined;
          }

          return scriptFromCode(checkpointKhatType.code) ?? undefined;
        })()
      : undefined;

  const checkpointLevel =
    latestCheckpoint?.level_title ?? null;

  const checkpointDate =
    latestCheckpoint
      ? new Date(
          latestCheckpoint.created_at
        ).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        })
      : null;

  const checkpointStatus =
    latestCheckpoint
      ? latestCheckpoint.status === 'reviewed'
        ? 'Passed'
        : latestCheckpoint.status === 'redo_needed'
          ? 'Redo needed'
          : latestCheckpoint.status === 'in_review'
            ? 'In review'
            : latestCheckpoint.status === 'assigned'
              ? 'Assigned'
              : 'Pending'
      : null;

  if (loading) {
    return (
      <main className="page portal-page">
        <PenLoader label="Loading your path…" />
      </main>
    );
  }

  const today = new Date();
  const weekStart = new Date(today);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
  const lastWeekStart = new Date(weekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const nextWeekStart = new Date(today);
  nextWeekStart.setDate(nextWeekStart.getDate() + 1);
  nextWeekStart.setHours(0, 0, 0, 0);
  const entriesThisWeek = practiceEntries.filter(entry => (entry.entry_kind === 'practice_marking' || entry.entry_kind === 'secondary_marking') && new Date(entry.created_at) >= weekStart && new Date(entry.created_at) < nextWeekStart);
  const entriesLastWeek = practiceEntries.filter(entry => (entry.entry_kind === 'practice_marking' || entry.entry_kind === 'secondary_marking') && new Date(entry.created_at) >= lastWeekStart && new Date(entry.created_at) < weekStart);
  const minutesThisWeek = entriesThisWeek.reduce((sum, entry) => sum + Number(entry.time_spent_minutes ?? 0), 0);
  const minutesLastWeek = entriesLastWeek.reduce((sum, entry) => sum + Number(entry.time_spent_minutes ?? 0), 0);
  const markOnlyEntries = practiceEntries.filter(entry => entry.entry_kind === 'practice_marking' || entry.entry_kind === 'secondary_marking');
  const markedEntries = markOnlyEntries.filter(entry => entry.mark_out_of_ten != null).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const averageLastThree = markedEntries.slice(0, 3).reduce((sum, entry) => sum + Number(entry.mark_out_of_ten), 0) / Math.max(1, Math.min(3, markedEntries.length));
  const previousThree = markedEntries.slice(3, 6);
  const previousAverage = previousThree.length ? previousThree.reduce((sum, entry) => sum + Number(entry.mark_out_of_ten), 0) / previousThree.length : null;
  const activityDays = [...new Set(activity.map(item => item.activity_date.slice(0, 10)))].sort();
  let longestStreak = 0;
  let runningStreak = 0;
  let previousActivityDay: number | null = null;
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  for (const day of activityDays) {
    const date = new Date(`${day}T00:00:00Z`);
    const dayNumber = Math.floor(date.getTime() / 86_400_000);
    runningStreak = previousActivityDay !== null && dayNumber === previousActivityDay + 1 ? runningStreak + 1 : 1;
    longestStreak = Math.max(longestStreak, runningStreak);
    previousActivityDay = dayNumber;
  }
  for (const entry of practiceEntries) {
    weekdayCounts[new Date(entry.created_at).getDay()] += 1;
  }
  const bestPracticeDay = practiceEntries.length
    ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekdayCounts.indexOf(Math.max(...weekdayCounts))]
    : '—';
  const allDashboardCourses = courses.filter(item => item.khatType.code !== 'tehseen_al_khat');
  const dashboardCourses = allDashboardCourses.filter(item => {
    if (!['naskh', 'istinsaakh'].includes(item.khatType.code)) return true;
    const stylePattern = /\bstyle\s*(one|two|1|2)\b/i;
    const hasStyleVariants = allDashboardCourses.some(candidate => candidate.khatType.code === item.khatType.code && stylePattern.test(candidate.course.title));
    if (hasStyleVariants && !stylePattern.test(item.course.title)) return false;
    const styleMatch = item.course.title.match(stylePattern);
    const styleNumber = styleMatch ? (/two|2/i.test(styleMatch[1]) ? 2 : 1) : null;
    return styleNumber === null || styleNumber === selectedCutStyles[item.khatType.code as 'naskh' | 'istinsaakh'];
  });
  const enrolledCourses = [
    ...dashboardCourses.filter(item => item.enrollment && item.levels.length),
    ...secondaryCourses.filter(item => item.enrollment && item.levels.length && !/mashq|worksheet/i.test(item.course.title)).map(item => ({ ...item, khatType: khatTypesList.find(type => type.id === item.course.khat_type_id) })),
  ];
  const masterLevelCount = enrolledCourses.reduce((sum, item) => sum + item.levels.length, 0);
  const masterCompletedCount = enrolledCourses.reduce((sum, item) => sum + Math.min(item.levels.length, item.enrollment?.current_level_index ?? Math.round(item.levels.length * Number(item.enrollment?.percent_complete ?? 0) / 100)), 0);
  const masterProgress = masterLevelCount ? Math.round(masterCompletedCount / masterLevelCount * 100) : 0;
  const upcomingAssessment = dashboardCourses.flatMap(item => {
    if (!item.enrollment) return [];
    const checkpoint = item.levels.find(level => level.level_type === 'test' && level.order_index >= item.enrollment!.current_level_index);
    return checkpoint ? [{ course: item, level: checkpoint, levelsAway: Math.max(0, checkpoint.order_index - item.enrollment.current_level_index) }] : [];
  }).sort((a, b) => a.levelsAway - b.levelsAway)[0];
  const focusCourse = dashboardCourses.find(item => item.enrollment && item.levels.length);
  const focusLevel = focusCourse?.levels[focusCourse.enrollment?.current_level_index ?? 0] ?? null;
  const courseStartedAt = (enrolledAt?: string) => enrolledAt ? new Date(enrolledAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  const rawCutPenCourses = allDashboardCourses.filter(item => !item.khatType.code.endsWith('_normal_pen'));
  const styledCutPenCourses = (['naskh', 'istinsaakh'] as const).flatMap(code => {
    const matching = rawCutPenCourses.filter(item => item.khatType.code === code);
    if (!matching.length) return [];
    const styleCourses = matching.filter(item => /\bstyle\s*(one|two|1|2)\b/i.test(item.course.title));
    if (styleCourses.length) {
      const selectedStyle = selectedCutStyles[code];
      const selectedCourse = styleCourses.find(item => new RegExp(`\\bstyle\\s*${selectedStyle === 1 ? '(?:one|1)' : '(?:two|2)'}\\b`, 'i').test(item.course.title));
      return [selectedCourse ?? matching.find(item => !styleCourses.includes(item)) ?? styleCourses[0]];
    }
    const sourceCourse = matching[0];
    const styleName = selectedCutStyles[code] === 1 ? 'One' : 'Two';
    const title = code === 'naskh' ? `Naskh Style ${styleName}` : `Instinsakh Style ${styleName}`;
    return [{ ...sourceCourse, course: { ...sourceCourse.course, title } }];
  });
  const cutPenCourses = [
    ...rawCutPenCourses.filter(item => !['naskh', 'istinsaakh'].includes(item.khatType.code)),
    ...styledCutPenCourses,
  ].sort((a, b) => dashboardCourseOrder(a.khatType.code) - dashboardCourseOrder(b.khatType.code));
  const normalPenCourses = dashboardCourses.filter(item => item.khatType.code.endsWith('_normal_pen'));
  const mashqCourses = secondaryCourses.filter(item => /mashq|worksheet/i.test(item.course.title));
  const crashCourses = secondaryCourses.filter(item => !/mashq|worksheet/i.test(item.course.title));
  const cutCrashCourses = crashCourses.filter(item => !(khatTypesList.find(type => type.id === item.course.khat_type_id)?.code ?? '').endsWith('_normal_pen'));
  const normalCrashCourses = crashCourses.filter(item => (khatTypesList.find(type => type.id === item.course.khat_type_id)?.code ?? '').endsWith('_normal_pen'));
  const visibleCourses = penTrack === 'cut' ? cutPenCourses : normalPenCourses;
  const visibleCrashCourses = crashCourses.filter(item => {
    const code = khatTypesList.find(type => type.id === item.course.khat_type_id)?.code ?? '';
    return penTrack === 'normal' ? code.endsWith('_normal_pen') : !code.endsWith('_normal_pen');
  });
  const visibleMashqCourses = mashqCourses.filter(item => {
    const code = khatTypesList.find(type => type.id === item.course.khat_type_id)?.code ?? '';
    const matchesPen = penTrack === 'normal' ? code.endsWith('_normal_pen') : !code.endsWith('_normal_pen');
    return matchesPen && (secondaryFilter === 'all' || code === secondaryFilter);
  });

  return (
    <main className="page portal-page student-home-redesign">
      <FixedReportsCard />
      <V2DashboardHighlights />
      <header className="student-home-heading">
        <div>
          <p className="eyebrow">{t('Your learning path')}</p>
          <h1>{t('Your Path')}</h1>
          <p>{t('First choose your pen. Then pick the course that matches what you want to learn.')}</p>
        </div>
        <div className="student-home-streak"><Flame size={15} /><strong>{activityLoading ? '—' : dayStreak}</strong><span>day streak</span></div>
      </header>

      {error && <p className="error-text" role="alert">{error}</p>}

      <section className="student-home-section" aria-label="Choose your pen">
        <span className="student-home-step">{t('Step 1 · Choose your pen')}</span>
        <div className="student-pen-options">
          <button type="button" className={`student-pen-option${penTrack === 'normal' ? ' active' : ''}`} aria-pressed={penTrack === 'normal'} onClick={() => setPenTrack('normal')}>
            <span><strong>{t('Normal pen courses')}</strong><small>{t('An everyday pen, for better daily handwriting')}</small><em>{t('Courses')} {normalPenCourses.length + normalCrashCourses.length} · {t('Worksheets soon')}</em></span>
          </button>
          <button type="button" className={`student-pen-option${penTrack === 'cut' ? ' active' : ''}`} aria-pressed={penTrack === 'cut'} onClick={() => setPenTrack('cut')}>
            <span><strong>{t('Cut pen courses')}</strong><small><b>Qalam al-Qasab</b> (wooden) or <b>Qalam al-Hadeed</b> (metal)</small><em>{t('Courses')} {cutPenCourses.length + cutCrashCourses.length} · {t('Worksheets')} {mashqCourses.length || 1}</em></span>
          </button>
        </div>
      </section>

      <div className="student-home-key" aria-label={t('Course card guide')}><strong>{t('Every card reads the same way:')}</strong><span className="home-key-q">{t('1 · Is this for you?')}</span><span className="home-key-levels">{t('2 · Levels')}</span><span className="home-key-progress">{t('3 · Your progress')}</span><span className="home-key-assessment">{t('4 · Assessment')}</span></div>
      <span className="student-home-step">{t('Step 2 · Pick a course')}</span>
      <div className="student-course-tabs" role="tablist" aria-label={t('Course type')}>
        {COURSE_TABS.map(tab => <button key={tab.id} type="button" role="tab" id={`course-tab-${tab.id}`} aria-selected={courseTab === tab.id} className={courseTab === tab.id ? 'active' : ''} onClick={() => chooseCourseTab(tab.id)}>{t(tab.label)}</button>)}
      </div>

      {courseTab === 'certification' && (
      <section className="student-home-course-section" aria-labelledby="certification-courses-heading">
        <div className="student-home-section-title"><div><h2 id="certification-courses-heading">{t('Certification courses')}</h2><p>{t('Complete every level to earn a certificate.')}</p></div></div>
        <div className="student-home-course-grid">
          {visibleCourses.map((item, index) => {
            const enrolled = Boolean(item.enrollment && item.levels.length);
            const currentIndex = item.enrollment?.current_level_index ?? 0;
            const progress = enrolled ? Number(item.enrollment?.percent_complete ?? 0) : 0;
            const nextAssessment = item.levels.find(level => level.level_type === 'test' && level.order_index >= currentIndex);
            const arabic = scriptFromCode(item.khatType.code) ? khatTypes[scriptFromCode(item.khatType.code)!].arabic : '';
            return <article className="student-course-card" key={item.course.id} role="link" tabIndex={0} aria-label={`Open ${item.course.title} course page`} onClick={() => openDashboardCourse(item.course, item.khatType)} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDashboardCourse(item.course, item.khatType); } }}>
              <div className="student-course-card-heading"><span className="student-course-number">{index + 1}</span><span className="student-course-tag">{t('Certification')}</span>{item.khatType.code.endsWith('_normal_pen') && <span className="student-course-tag pen-tag">{t('Normal pen')}</span>}{['naskh', 'istinsaakh'].includes(item.khatType.code) && <div className="student-course-style-toggle" role="group" aria-label={`${khatTypes[scriptFromCode(item.khatType.code)!].name} ${t('Course style')}`} onClick={event => event.stopPropagation()}>{([1, 2] as const).map(style => <button key={style} type="button" className={selectedCutStyles[item.khatType.code as 'naskh' | 'istinsaakh'] === style ? 'active' : ''} aria-pressed={selectedCutStyles[item.khatType.code as 'naskh' | 'istinsaakh'] === style} onClick={() => setSelectedCutStyles(current => ({ ...current, [item.khatType.code]: style }))}><span lang="ar" dir="rtl">{style === 1 ? 'الاسلوب الاول' : 'الاسلوب الثاني'}</span></button>)}</div>}<span className="student-course-arabic" lang="ar" dir="rtl">{arabic}</span></div>
              <div className="student-course-name"><h3>{['naskh', 'istinsaakh'].includes(item.khatType.code) ? displayCourseTitle(item.course.title) : scriptFromCode(item.khatType.code) ? khatTypes[scriptFromCode(item.khatType.code)!].name.replace(' · Normal pen', '') : item.khatType.display_name}</h3><p>{item.course.description || t('Build confident, measured handwriting with this guided certification path.')}</p></div>
              <div className="student-course-info"><small>1 · Is this for you?</small><p>“{courseGuidanceQuestion(item.course, scriptFromCode(item.khatType.code) ?? undefined)}”</p></div>
              <div className="student-course-levels"><div><small>2 · Levels</small><strong>{item.levels.length} levels</strong></div><div className="student-level-pips">{item.levels.map((level, levelIndex) => <i key={level.id} className={`${level.level_type === 'test' ? 'assessment' : ''}${enrolled && levelIndex < currentIndex ? ' complete' : ''}`} title={`${level.title}${level.level_type === 'test' ? ' · assessment' : ''}`} />)}</div><span><i className="student-assessment-diamond" /> marks an online assessment</span></div>
              <div className="student-course-progress"><div className="student-course-progress-copy"><small>3 · Your progress</small><span>{enrolled ? `Started ${courseStartedAt(item.enrollment?.enrolled_at) ?? 'earlier'} · Level ${Math.min(currentIndex, item.levels.length)} of ${item.levels.length}` : `Not started yet · 0 of ${item.levels.length} levels`}</span><strong>{enrolled ? `${Math.round(progress)}%` : '0%'}</strong></div><div className="student-progress-track"><i style={{ width: `${progress}%` }} /></div></div>
              <div className="student-course-assessment"><small>4 · Assessment</small><p>{nextAssessment ? `Online assessment and marking at ${nextAssessment.title}.` : 'Online assessment and marking after every 6–7 levels.'}</p><strong>{nextAssessment ? `Next assessment after Level ${nextAssessment.order_index}` : 'Practice levels receive marks; optional voice feedback may be included.'}</strong></div>
              <div className="student-course-actions" onClick={event => event.stopPropagation()}><Button outline onClick={() => openDashboardCourse(item.course, item.khatType)}>{enrolled ? 'Open course' : 'View course'} <ArrowRight size={14} /></Button></div>
            </article>;
          })}
          {!visibleCourses.length && <div className="student-home-empty">{penTrack === 'normal' ? 'Normal-pen certification courses will appear here when available.' : 'No certification courses are available yet.'}</div>}
        </div>
      </section>
      )}

      {courseTab === 'crash' && (
      <section className="student-home-course-section" aria-labelledby="crash-courses-heading">
        <div className="student-home-section-title"><div><h2 id="crash-courses-heading">{t('Crash courses')}</h2><p>{t('Short, focused courses to learn a new script.')}</p></div></div>
        {secondaryError && <p className="error-text" role="alert">{secondaryError}</p>}
        {secondaryLoading ? <div className="student-home-empty"><PenLoader label={t('Loading courses…')} compact /></div> : <div className="student-home-course-grid">
          {visibleCrashCourses.map((item, index) => {
            const khatType = khatTypesList.find(type => type.id === item.course.khat_type_id);
            const script = khatType ? scriptFromCode(khatType.code) : null;
            const enrolled = Boolean(item.enrollment && item.levels.length);
            const currentIndex = item.enrollment?.current_level_index ?? 0;
            const progress = enrolled ? Number(item.enrollment?.percent_complete ?? 0) : 0;
            const nextAssessment = item.levels.find(level => level.level_type === 'test' && level.order_index >= currentIndex);
            return <article className="student-course-card" key={item.course.id} role="link" tabIndex={0} aria-label={`Open ${item.course.title} course page`} onClick={() => khatType && openDashboardCourse(item.course, khatType)} onKeyDown={event => { if (khatType && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDashboardCourse(item.course, khatType); } }}>
              <div className="student-course-card-heading"><span className="student-course-number">{cutPenCourses.length + index + 1}</span><span className="student-course-tag crash-tag">Crash course</span><span className="student-course-arabic" lang="ar" dir="rtl">{script ? khatTypes[script].arabic : ''}</span></div>
              <div className="student-course-name"><h3>{script ? khatTypes[script].name : khatType?.display_name ?? item.course.title}</h3><p>{item.course.description || 'Learn the script through a short, focused sequence of guided levels.'}</p></div>
              <div className="student-course-info"><small>1 · Is this for you?</small><p>“{courseGuidanceQuestion(item.course, script ?? undefined)}”</p></div>
              <div className="student-course-levels"><div><small>2 · Levels</small><strong>{item.levels.length} levels</strong></div><div className="student-level-pips">{item.levels.map((level, levelIndex) => <i key={level.id} className={`${level.level_type === 'test' ? 'assessment' : ''}${enrolled && levelIndex < currentIndex ? ' complete' : ''}`} title={`${level.title}${level.level_type === 'test' ? ' · assessment' : ''}`} />)}</div>{item.levels.some(level => level.level_type === 'test') && <span><i className="student-assessment-diamond" /> marks an online assessment</span>}</div>
              <div className="student-course-progress"><div className="student-course-progress-copy"><small>3 · Your progress</small><span>{enrolled ? `Started ${courseStartedAt(item.enrollment?.enrolled_at) ?? 'earlier'} · Level ${Math.min(currentIndex, item.levels.length)} of ${item.levels.length}` : `Not started yet · 0 of ${item.levels.length} levels`}</span><strong>{enrolled ? `${Math.round(progress)}%` : '0%'}</strong></div><div className="student-progress-track"><i style={{ width: `${progress}%` }} /></div></div>
              <div className="student-course-assessment"><small>4 · Assessment</small><p>{nextAssessment ? `Checkpoint assessments receive a thorough review at ${nextAssessment.title}; normal practice levels receive marks.` : 'Practice levels receive marks; optional voice feedback may be included.'}</p><strong>{nextAssessment ? `Next assessment after Level ${nextAssessment.order_index}` : `Short course · ${item.levels.length} guided levels`}</strong></div>
              <div className="student-course-actions" onClick={event => event.stopPropagation()}><Button outline onClick={() => khatType && openDashboardCourse(item.course, khatType)}>{enrolled ? 'Open course' : 'View course'} <ArrowRight size={14} /></Button></div>
            </article>;
          })}
          {!visibleCrashCourses.length && <div className="student-home-empty">{penTrack === 'normal' ? 'Normal-pen crash courses are coming soon.' : 'More focused script courses will appear here when available.'}</div>}
        </div>}
      </section>
      )}

      {courseTab === 'mashq' && (
      <section className="student-home-course-section student-mashq-section" aria-labelledby="mashq-worksheets-heading">
        <div className="student-home-section-title"><div><h2 id="mashq-worksheets-heading">{t('Mashq worksheets')}</h2><p>{t('Downloadable practice sheets. Current sets are available in Naskh.')}</p></div></div>
        <div className="student-mashq-filters" role="group" aria-label="Filter Mashq worksheets by khat type">
          <button type="button" className={secondaryFilter === 'all' ? 'active' : ''} aria-pressed={secondaryFilter === 'all'} onClick={() => setSecondaryFilter('all')}>All khat types</button>
          {khatTypesList.filter(type => !type.code.endsWith('_normal_pen')).map(type => <button type="button" key={type.id} className={secondaryFilter === type.code ? 'active' : ''} aria-pressed={secondaryFilter === type.code} onClick={() => setSecondaryFilter(type.code)}>{type.display_name}</button>)}
        </div>
        {secondaryLoading ? <div className="student-home-empty"><PenLoader label="Loading worksheets…" compact /></div> : visibleMashqCourses.length ? <div className="student-mashq-list">
          {visibleMashqCourses.map(item => {
            const khatType = khatTypesList.find(type => type.id === item.course.khat_type_id);
            const isNaskhSet = khatType?.code === 'naskh';
            const worksheetRows = isNaskhSet
              ? mashqSetSamples.map(sample => ({ sample, sourceLevel: item.levels[sample.firstLevel] })).filter(row => row.sourceLevel)
              : item.levels.map((sourceLevel, index) => ({ sourceLevel, sample: { key: `other-${index}`, category: sourceLevel.title, title: sourceLevel.title, year: '', sheetCount: Object.keys(sourceLevel.sheet_files ?? {}).length || 1, firstLevel: index, levelCount: 1 } }));
            return worksheetRows.map(({ sample, sourceLevel }, index) => <article className="student-mashq-row" key={`${item.course.id}-${sourceLevel.id}`}>
              <span className="student-mashq-number">{isNaskhSet ? `5.${index + 1}` : index + 1}</span><div className="student-mashq-copy"><strong>{sample.category} worksheets</strong><span>{sample.title}{sample.year ? ` · ${sample.year}` : ''}</span><div><small>Script: {khatType?.display_name ?? 'Naskh'}</small><small>{sample.sheetCount} sheets</small></div></div><button type="button" className="student-mashq-view" onClick={() => navigateToMashqWorksheets(isNaskhSet ? sample.key : 'all')}>View sheets <ArrowRight size={13} /></button>
            </article>);
          })}
          <p className="student-mashq-footnote">More genres will be added soon.</p>
        </div> : <div className="student-home-empty">{penTrack === 'normal' ? 'Normal-pen worksheet sets are being prepared.' : 'No Mashq worksheet sets are available for this khat type yet.'}</div>}
      </section>
      )}

      <section className="student-home-panel student-master-progress" aria-label="Master progress">
        <div className="student-home-panel-heading"><div><p className="eyebrow">{t('Master progress')}</p><h2>{t('All your courses')}</h2></div><strong>{masterProgress}% <small>· {masterCompletedCount} {t('of')} {masterLevelCount} {t('levels')}</small></strong></div>
        <div className="student-master-bar"><i style={{ width: `${masterProgress}%` }} /></div>
        {enrolledCourses.length ? enrolledCourses.map(item => {
          const khatType = item.khatType;
          const script = khatType ? scriptFromCode(khatType.code) : null;
          const progress = Number(item.enrollment?.percent_complete ?? 0);
          const level = item.levels[item.enrollment?.current_level_index ?? 0] ?? item.levels[0];
          return <button type="button" className="student-master-row" key={item.course.id} onClick={() => khatType && openDashboardCourse(item.course, khatType)}>
            <span className="student-master-number">{script ? scriptList.indexOf(script) + 1 || 1 : '·'}</span><span className="student-master-course"><strong>{script ? khatTypes[script].name : khatType?.display_name ?? item.course.title} · {item.course.category === 'certification' ? 'Certification' : 'Crash course'}</strong><i><b style={{ width: `${progress}%` }} /></i></span><span className="student-master-level">Level {Math.min(item.enrollment?.current_level_index ?? 0, item.levels.length)} of {item.levels.length}</span><strong>{Math.round(progress)}%</strong>
          </button>;
        }) : <p className="student-home-empty">Enroll in a course to start building your overall progress.</p>}
      </section>

      <section className="student-home-events" aria-label={t('Upcoming events')}>
        <div className="student-home-inline-heading"><h2>{t('Upcoming events')}</h2><button type="button" onClick={() => navigate('events')}>{t('All events')} <ArrowRight size={13} /></button></div>
        {eventsLoading ? <div className="student-home-event-empty"><PenLoader label="Loading events…" compact /></div> : events.length === 0 ? <div className="student-home-event-empty">No upcoming events.</div> : events.map(event => <article className="student-home-event" key={event.id}><span className="student-home-event-date">{new Date(event.scheduled_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span><div><strong>{event.title}</strong><small>{event.host_name} · {event.branch_name}</small></div><StatusChip tone={event.status === 'live' ? 'green' : 'gold'}>{event.status === 'live' ? 'Live now' : 'Upcoming'}</StatusChip></article>)}
      </section>

      <section className="student-home-panel student-practice-rhythm" aria-label={t('Your practice rhythm')}>
        <div><h2>{t('Your practice rhythm')}</h2><p>{t('Your practice over the last 12 weeks, and what to do next.')}</p></div>
        <div className="student-rhythm-stats">
          <article className="rhythm-streak"><small>Current streak</small><strong>{activityLoading ? '—' : `${dayStreak} ${dayStreak === 1 ? 'day' : 'days'}`}</strong><span>Best: {longestStreak} days</span></article>
          <article className="rhythm-week"><small>Practice this week</small><strong>{activityLoading ? '—' : `${minutesThisWeek} min`}</strong><span>{minutesThisWeek - minutesLastWeek >= 0 ? '+' : ''}{minutesThisWeek - minutesLastWeek} min on last week</span></article>
          <article className="rhythm-mark"><small>Average mark (last 3)</small><strong>{markedEntries.length ? `${averageLastThree.toFixed(1)} / 10` : '—'}</strong><span>{previousAverage === null ? 'Marks appear after teacher review' : `${averageLastThree >= previousAverage ? 'Up' : 'Down'} from ${previousAverage.toFixed(1)}`}</span></article>
          <article className="rhythm-assessment"><small>Next assessment</small><strong>{upcomingAssessment ? `${upcomingAssessment.levelsAway} ${upcomingAssessment.levelsAway === 1 ? 'level' : 'levels'}` : '—'}</strong><span>{upcomingAssessment ? `After Level ${upcomingAssessment.level.order_index}` : 'No upcoming checkpoint'}</span></article>
        </div>
        <div className="student-practice-tip"><strong>Today:</strong><span>{focusLevel ? `Continue with ${focusLevel.title} in ${focusCourse?.khatType.display_name ?? 'your course'}${focusLevel.level_type === 'test' ? ' — this is a checkpoint assessment.' : ' to keep your learning moving.'}` : 'Choose a course and start a short practice session to build your rhythm.'}</span></div>
        <div className="student-home-heatmap-heading"><span>Last 12 weeks</span><span>Your best day: <strong>{bestPracticeDay}</strong></span></div>
        <ActivityHeatmap activity={activity} />
      </section>

      <ShowcaseHeading title="From Funun al-Quran" text="Recent shares from students and faculty." action={<button className="text-link" onClick={() => navigate('gallery')}>Visit gallery <ArrowRight size={14} /></button>} />
      {showcaseLoading ? <PenLoader label="Loading gallery…" compact /> : <DashboardShowcaseCarousels posts={showcasePosts.map(post => ({ id: post.id, role: post.user_role ?? 'student', imageUrl: post.imageUrl, caption: post.caption, authorName: post.author_name, branch: post.branch_name ?? post.branch, likes: Number(post.like_count), liked: post.liked_by_me }))} onLike={toggleShowcaseLike} />}
      {winners.length > 0 && <section className="dashboard-winners-section" aria-label="Latest competition winners"><SectionHeading eyebrow="Competitions" title="Latest competition winners" text="Celebrating our students and their calligraphy." action={<button className="text-link" onClick={() => navigate('v2-competitions')}>See all results <ArrowRight size={15} /></button>} /><div className="dashboard-winner-grid">{winners.map((winner, index) => <article className="dashboard-winner-card" key={`${winner.competitionTitle}-${winner.student_name}-${index}`}><span className="dashboard-winner-trophy"><Trophy size={17} /></span><div><strong>{winner.student_name}</strong><span>{winner.competitionTitle}</span></div><span className="dashboard-winner-rank">Winner</span></article>)}</div></section>}
    </main>
  );
}

// v3 note 4.9 + curriculum audit: new-system courses once (V2StudentCatalogSection), then only the
// old-system courses that are published for this branch and have levels (src/v2/content).
export function Catalog() {
  return (
    <main className="page portal-page">
      <V2StudentCatalogSection />
      <V3OlderCoursesSection />
    </main>
  );
}

export function CourseEnvironment() {
  const session = useCourseSession();
  const [courseCategory, setCourseCategory] = useState<'certification' | 'secondary'>('certification');
  const [courseTitle, setCourseTitle] = useState('Course levels');
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [levels, setLevels] = useState<ApiLevel[]>([]);
  const [activeLevelId, setActiveLevelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [minutes, setMinutes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [saved, setSaved] = useState(false);
  const [courseChatVersion, setCourseChatVersion] = useState(0);

  // Checkpoint-specific state — the student's most recent entry for this level, if any.
  const [myEntry, setMyEntry] = useState<{ id: string; status: string; feedback?: string | null; correction_image_storage_key?: string | null; correction_voice_storage_key?: string | null; mark_out_of_ten?: number | null; mark_passed?: boolean | null; entry_kind?: string | null; time_spent_minutes?: number | null; created_at?: string } | null>(null);
  const [reviewFeedbackEntry, setReviewFeedbackEntry] = useState<{ feedback?: string | null; correction_image_storage_key?: string | null; correction_voice_storage_key?: string | null } | null>(null);
  const [teacherVoiceUrl, setTeacherVoiceUrl] = useState<string | null>(null);
  const [teacherCorrectionUrl, setTeacherCorrectionUrl] = useState<string | null>(null);

  const loadLevels = async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const [progress, courseData] = await Promise.all([
        apiFetch<{ levels: ApiLevel[] }>(`/levels/courses/${session.courseId}/progress`),
        apiFetch<{ category: 'certification' | 'secondary'; title: string }>(`/courses/${session.courseId}`),
      ]);
      setLevels(progress.levels);
      setCourseCategory(courseData.category);
      setCourseTitle(courseData.title);
      setActiveLevelId(session.levelId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this course.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLevels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session?.courseId, session?.levelId]);

  const level = levels.find(l => l.id === activeLevelId);
  const isCheckpoint = courseCategory !== 'secondary' && level?.level_type === 'test';

  useEffect(() => {
    setPickedFile(null);
    setSaved(false);
    setMinutes('');
    setMyEntry(null);
    setReviewFeedbackEntry(null);
    setTeacherVoiceUrl(null);
    setTeacherCorrectionUrl(null);
    if (level) {
      apiFetch<{ id: string; level_id: string; status: string; feedback?: string | null; correction_image_storage_key?: string | null; correction_voice_storage_key?: string | null; mark_out_of_ten?: number | null; mark_passed?: boolean | null; entry_kind?: string | null; time_spent_minutes?: number | null; created_at?: string }[]>('/entries/mine')
        .then(async entries => {
          const levelEntries = entries.filter(e => e.level_id === level.id).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
          const latest = levelEntries[0];
          const latestReview = levelEntries.find(e => e.status === 'reviewed' || e.status === 'redo_needed') ?? null;
          setMyEntry(latest ?? null);
          setReviewFeedbackEntry(latestReview ?? null);
          const [voiceUrl, correctionUrl] = await Promise.all([
            latestReview?.correction_voice_storage_key ? getViewUrl(latestReview.correction_voice_storage_key).catch(() => null) : Promise.resolve(null),
            latestReview?.correction_image_storage_key ? getViewUrl(latestReview.correction_image_storage_key).catch(() => null) : Promise.resolve(null),
          ]);
          setTeacherVoiceUrl(voiceUrl);
          setTeacherCorrectionUrl(correctionUrl);
        })
        .catch(() => setMyEntry(null));
    }
  }, [level?.id]);

  if (!session) {
    return (
      <main className="page portal-page">
        <p className="muted">No level selected. <button className="text-link" onClick={() => navigate('catalog')}>Back to the catalog</button></p>
      </main>
    );
  }

  const goTo = (levelId: string) => {
    const target = levels.find(l => l.id === levelId);
    if (target && !target.locked) { openCourseLevel(session.courseId, levelId); }
  };

  const submitPractice = async () => {
    if (!level || !pickedFile) return;
    const numericMinutes = Number(minutes);
    if (!Number.isFinite(numericMinutes) || numericMinutes <= 0) {
      setError('Add how many minutes you practiced before submitting this work.');
      return;
    }
    setUploading(true);
    try {
      const { storageKey, originalFilename } = await uploadFile('entries', pickedFile);
      if (myEntry?.status === 'redo_needed') {
        await apiFetch(`/entries/${myEntry.id}/redo`, {
          method: 'POST',
          body: { khatImageStorageKey: storageKey, originalFilename, timeSpentMinutes: numericMinutes },
        });
      } else {
        await apiFetch('/entries', {
          method: 'POST',
          body: { sourceType: 'checkpoint', levelId: level.id, khatImageStorageKey: storageKey, originalFilename, timeSpentMinutes: numericMinutes },
        });
      }
      setSaved(true);
      await loadLevels();
      const entries = await apiFetch<{ id: string; level_id: string; status: string; mark_out_of_ten?: number | null; feedback?: string | null; time_spent_minutes?: number | null; created_at?: string }[]>('/entries/mine');
      setMyEntry(entries.filter(e => e.level_id === level.id).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null);
      setCourseChatVersion(version => version + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit your practice for marking.');
    } finally {
      setUploading(false);
    }
  };

  const submitTest = async () => {
    if (!level || !pickedFile) return;
    setUploading(true);
    try {
      const { storageKey, originalFilename } = await uploadFile('entries', pickedFile);
      if (myEntry?.status === 'redo_needed') {
        await apiFetch(`/entries/${myEntry.id}/redo`, {
          method: 'POST',
          body: { khatImageStorageKey: storageKey, originalFilename, timeSpentMinutes: null },
        });
      } else {
        await apiFetch('/entries', {
          method: 'POST',
          body: { sourceType: 'checkpoint', levelId: level.id, khatImageStorageKey: storageKey, originalFilename },
        });
      }
      setSaved(true);
      const entries = await apiFetch<{ id: string; level_id: string; status: string }[]>('/entries/mine');
      setMyEntry(entries.filter(e => e.level_id === level.id).sort((a, b) => (a.id < b.id ? 1 : -1))[0] ?? null);
      setCourseChatVersion(version => version + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit your test.');
    } finally {
      setUploading(false);
    }
  };

  const nextUnlockedLevel = () => {
    if (!level) return;
    const idx = levels.findIndex(l => l.id === level.id);
    const next = levels[idx + 1];
    if (next) openCourseLevel(session.courseId, next.id);
    else navigateToCatalogForCourse(session.courseId);
  };

  return (
    <div className={`course-env ${mobileSidebarOpen ? 'mobile-open' : ''}`}>
      {/* Small-screen hamburger for course sidebar */}
      <button className="page-sidebar-hamburger" onClick={() => setMobileSidebarOpen(v => !v)} aria-label="Open course menu" title="Course menu">
        <span className="hamburger-icon">☰</span>
      </button>

      <aside className="course-env-sidebar">
        <div className="course-env-header">
          <p className="eyebrow">{courseCategory === 'secondary' ? 'Self-paced course' : 'Certification course'}</p>
          <h3>{displayCourseTitle(courseTitle)}</h3>
        </div>
        <div className="course-env-levels">
          {levels.map((l, i) => (
            <button
              key={l.id}
              className={`course-env-level ${activeLevelId === l.id ? 'active' : ''} ${l.locked ? 'locked' : ''} ${l.level_type === 'test' ? 'is-checkpoint' : ''}`}
              onClick={() => { goTo(l.id); setMobileSidebarOpen(false); }}
            >
              <span className="level-icon">
                {l.locked ? <Lock size={14} /> : l.level_type === 'test' ? <ClipboardList size={14} /> : <span className="level-num">{i + 1}</span>}
              </span>
              <div><strong>Level {i + 1}</strong><small>{l.title}</small></div>
            </button>
          ))}
        </div>
        <button className="course-env-exit" onClick={() => { navigateToCatalogForCourse(session.courseId); setMobileSidebarOpen(false); }}><X size={16} /> Exit course</button>
      </aside>

      {/* Backdrop for course sidebar on mobile */}
      <div className={`course-env-backdrop${mobileSidebarOpen ? ' open' : ''}`} onClick={() => setMobileSidebarOpen(false)} />

      <main className="course-env-main">
        <div className="course-env-content">
          {loading && <PenLoader label="Loading…" compact />}
          {error && <p className="error-text">{error}</p>}
          {!loading && level && (
            <>
              <div className="lesson-course-progress-row">
                <button type="button" onClick={() => navigateToCatalogForCourse(session.courseId)}><ChevronLeft size={14} /> {displayCourseTitle(courseTitle)}</button>
                <span>Level {levels.findIndex(item => item.id === level.id) + 1} of {levels.length}</span>
                <i><b style={{ width: `${Math.max(4, (levels.findIndex(item => item.id === level.id) + 1) / Math.max(1, levels.length) * 100)}%` }} /></i>
              </div>
              {myEntry?.mark_out_of_ten != null && <div className="lesson-marks-banner"><small>Marks received</small><strong>{myEntry.mark_out_of_ten} / 10</strong><span>{myEntry.mark_passed ? 'Passed' : 'Keep practicing'} · Level {levels.findIndex(item => item.id === level.id) + 1} · {level.title}</span></div>}
              <div className="level-heading">
                <div>
                  <p className="eyebrow">Level {levels.findIndex(l => l.id === level.id) + 1}</p>
                  <h1>{level.title}</h1>
                  <p>{isCheckpoint ? 'Checkpoint assessment — a teacher reviews your work, score, and any feedback.' : 'Upload a clear photo of your practice. A course reviewer will mark it out of 10; 5/10 or higher passes this level.'}</p>
                </div>
                <StatusChip tone={isCheckpoint ? 'amber' : 'green'}>{isCheckpoint ? 'Checkpoint assessment' : courseCategory === 'secondary' ? 'Secondary · Mark only' : 'Practice · Mark only'}</StatusChip>
              </div>

              {isCheckpoint ? (
                <>
                  <div className="checkpoint-ref-section">
                    <p className="eyebrow">Reference — copy precisely</p>
                    <p className="editor-hint">Replicate exactly what you see in the reference images. Your upload will be sent to a teacher for review.</p>
                    <div className="checkpoint-ref-grid">
                      {level.media.length === 0 && <p className="muted">No reference uploaded yet for this test — check with your coordinator.</p>}
                      {level.media.map((m, i) => <CourseReferenceCard key={`${m.storageKey}-${i}`} media={m} checkpoint />)}
                    </div>
                    <SheetDownloadMenu files={level.sheet_files} label="Test sheets" />
                  </div>

                  {myEntry && ['pending', 'assigned', 'in_review'].includes(myEntry.status) ? (
                    <div className="submission-result-card">
                      <Check size={24} className="green-icon" />
                      <div><h3>Sent to a reviewer</h3><p>You'll be notified when the result is ready.</p></div>
                      <StatusChip tone="amber">Pending review</StatusChip>
                    </div>
                  ) : myEntry?.status === 'reviewed' ? (
                    <div className="course-checkpoint-result">
                      <div className="course-checkpoint-result-heading"><div><Check size={17} /><strong>Checkpoint passed</strong></div><StatusChip tone="green">Passed</StatusChip></div>
                      {reviewFeedbackEntry?.feedback && <p className="course-checkpoint-feedback-text">{reviewFeedbackEntry.feedback}</p>}
                      {teacherCorrectionUrl && <a className="student-correction-preview" href={teacherCorrectionUrl} target="_blank" rel="noreferrer"><img src={teacherCorrectionUrl} alt="Teacher's annotated checkpoint feedback" /><span>View teacher’s annotated feedback</span></a>}
                      {teacherVoiceUrl && <StudentVoicePlayer src={teacherVoiceUrl} />}
                    </div>
                  ) : (
                    <div className="practice-panel">
                      <SectionHeading
                        eyebrow="Submit your test"
                        title={myEntry?.status === 'redo_needed' ? 'Redo — same letters and text' : 'Upload your checkpoint sheet'}
                        text="This will be sent to a teacher for review. If a redo is needed, you'll re-attempt with the same letters and text, submitted as a new entry."
                      />
                      {reviewFeedbackEntry && (reviewFeedbackEntry.feedback || teacherVoiceUrl || teacherCorrectionUrl) && <div className="course-checkpoint-result course-checkpoint-result-previous"><div className="course-checkpoint-result-heading"><div><strong>Previous teacher feedback</strong></div><StatusChip tone="red">Needs redo</StatusChip></div>{reviewFeedbackEntry.feedback && <p className="course-checkpoint-feedback-text">{reviewFeedbackEntry.feedback}</p>}{teacherCorrectionUrl && <a className="student-correction-preview" href={teacherCorrectionUrl} target="_blank" rel="noreferrer"><img src={teacherCorrectionUrl} alt="Teacher's annotated checkpoint feedback" /><span>View teacher’s annotated feedback</span></a>}{teacherVoiceUrl && <StudentVoicePlayer src={teacherVoiceUrl} />}</div>}
                      <UploadBox tall label={pickedFile?.name || 'Upload your test sheet'} sublabel={pickedFile ? 'Ready to submit' : 'PNG, JPG up to 10 MB'} onChange={setPickedFile} />
                      <div className="practice-actions">
                        <Button onClick={submitTest}>{uploading ? <PenLoader label="Submitting entry" compact tiny /> : saved ? 'Submitted' : 'Submit for review'} {!uploading && <ArrowRight size={15} />}</Button>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {myEntry && ['pending', 'assigned', 'in_review'].includes(myEntry.status) && <div className="lesson-submission-status"><Check size={17} /><span><strong>Sent to your review chat</strong><small>Your teacher will reply with feedback and a mark out of 10.</small></span><StatusChip tone="amber">Waiting</StatusChip></div>}
                  {(myEntry?.status === 'reviewed' || myEntry?.status === 'redo_needed') && <div className="lesson-submission-status is-marked"><Check size={17} /><span><strong>{myEntry.status === 'redo_needed' ? 'A new attempt is needed' : 'Teacher feedback is ready'}</strong><small>{reviewFeedbackEntry?.feedback || 'Open your course chat to see the complete feedback.'}</small></span><StatusChip tone={myEntry.status === 'redo_needed' ? 'red' : 'green'}>{myEntry.status === 'redo_needed' ? 'Redo' : `${myEntry.mark_out_of_ten ?? 'Marked'} / 10`}</StatusChip></div>}

                  <div className="lesson-steps">
                    <section className="lesson-step-card">
                      <header><span>1</span><h2>Watch the video</h2><small>{level.media.some(media => media.kind === 'video') ? 'Lesson video' : 'Lesson material'}</small></header>
                      <div className="lesson-step-body lesson-video-list">
                        {level.media.filter(media => media.kind === 'video').map((media, index) => <CourseReferenceCard key={`${media.storageKey}-${index}`} media={media} />)}
                        {!level.media.some(media => media.kind === 'video') && <div className="lesson-video-placeholder"><span className="lesson-video-play"><Play size={20} fill="currentColor" /></span><small>{level.media.length ? `Study the lesson material · ${level.title}` : 'Lesson video will appear here when available'}</small></div>}
                      </div>
                    </section>

                    <section className="lesson-step-card">
                      <header><span>2</span><h2>Study the reference image</h2><small>Copy each form carefully</small></header>
                      <div className="lesson-step-body lesson-reference-list">
                        {level.media.filter(media => media.kind !== 'video').map((media, index) => <CourseReferenceCard key={`${media.storageKey}-${index}`} media={media} />)}
                        {!level.media.some(media => media.kind !== 'video') && <div className="lesson-reference-empty">No reference image has been added to this level yet.</div>}
                      </div>
                    </section>

                    <section className="lesson-step-card">
                      <header><span>3</span><h2>Practice the worksheet</h2><small>Use art paper</small></header>
                      <div className="lesson-step-body lesson-worksheet-body">
                        {Object.values(level.sheet_files ?? {}).some(Boolean) ? <SheetPreview file={Object.values(level.sheet_files ?? {}).find(Boolean)!} /> : <div className="lesson-worksheet-preview"><i /><i /><i /><i /><i /><i /></div>}
                        <div className="lesson-worksheet-copy"><p>Print the worksheet and practice each letter on <strong>art paper</strong> until the shapes match the reference.</p><div><SheetDownloadMenu files={level.sheet_files} label="View worksheet" /><SheetDownloadMenu files={level.sheet_files} label="Download worksheet" /></div><small>For more assistance, contact Funun al-Quran.</small></div>
                      </div>
                    </section>

                    <section className="lesson-step-card lesson-send-step">
                      <header><span>4</span><h2>Send your work for review</h2></header>
                      <div className="lesson-step-body">
                        <div className="lesson-upload-checklist"><small>What to upload for this level</small><p><i /> Upload 1 · Photo of your practice sheet</p><span>Send your upload here. Clear photo in daylight, whole page in frame.</span></div>
                        <div className="practice-form lesson-practice-form">
                          <label className="field-label">Minutes practiced<input className="field" type="number" value={minutes} onChange={event => setMinutes(event.target.value)} placeholder="e.g. 25" /></label>
                          <UploadBox label={pickedFile?.name || 'Choose a photo of your practice'} sublabel={pickedFile ? 'Ready to send' : 'PNG or JPG · up to 10 MB'} onChange={setPickedFile} />
                        </div>
                        {error && <p className="error-text" role="alert">{error}</p>}
                        <div className="lesson-send-actions"><Button disabled={!pickedFile || uploading} onClick={submitPractice}>{uploading ? <PenLoader label="Sending work" compact tiny /> : saved ? 'Sent to chat' : 'Send your work for review'} {!uploading && <ArrowRight size={15} />}</Button></div>
                        <CourseJourney key={`${session.courseId}-${level.id}-${courseChatVersion}`} courseId={session.courseId} levelId={level.id} compact />
                      </div>
                    </section>
                  </div>
                </>
              )}
              {isCheckpoint && <CourseJourney key={`${session.courseId}-${level.id}-${courseChatVersion}`} courseId={session.courseId} levelId={level.id} compact />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function SheetDownloadMenu({ files, label }: { files: ApiSheetFiles; label: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [urls, setUrls] = useState<Partial<Record<SheetSize, string>>>({});
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !pickerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const toggleMenu = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    setLoading(true);
    const resolved = await Promise.all(SHEET_SIZES.map(async size => {
      const file = files[size];
      if (!file) return [size, undefined] as const;
      const filename = file.originalFilename ?? `${size}-grid-sheet`;
      try { return [size, await getDownloadUrl(file.storageKey, filename)] as const; }
      catch { return [size, undefined] as const; }
    }));
    setUrls(Object.fromEntries(resolved));
    setLoading(false);
  };

  return (
    <div className="sheet-download-picker" ref={pickerRef}>
      <button className="sheet-download-trigger" type="button" aria-haspopup="listbox" aria-expanded={open} onClick={toggleMenu}>
        <span>{label}</span><ChevronDown size={15} />
      </button>
      {open && (
        <div className="sheet-download-menu" role="listbox" aria-label={label}>
          <p className="sheet-download-menu-heading">Download a grid sheet</p>
          {SHEET_SIZES.map(size => {
            const file = files[size];
            const url = urls[size];
            const filename = file?.originalFilename;
            const optionLabel = `Download ${size} grid sheet`;
            return url ? (
              <a key={size} role="option" aria-label={optionLabel} href={url} download={filename ?? `${size}-grid-sheet`} onClick={() => setOpen(false)}>
                <FileText size={15} /><span><strong>{optionLabel}</strong><small>{filename ?? 'Download sheet'}</small></span><Download size={14} />
              </a>
            ) : (
              <button key={size} type="button" role="option" aria-disabled="true" disabled>
                <FileText size={15} /><span><strong>{optionLabel}</strong><small>{loading && file ? 'Loading…' : file ? 'Unavailable' : 'Not uploaded yet'}</small></span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SheetPreview({ file }: { file: { storageKey: string; originalFilename?: string } }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getViewUrl(file.storageKey).then(value => { if (!cancelled) setUrl(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [file.storageKey]);
  return <div className="lesson-worksheet-file-preview">{url ? <iframe src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={file.originalFilename ?? 'Practice worksheet'} loading="lazy" /> : <span>{file.originalFilename ?? 'Loading worksheet…'}</span>}</div>;
}

function CourseReferenceCard({ media, checkpoint = false }: { media: ApiMediaItem; checkpoint?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setLoadError(false);
    getViewUrl(media.storageKey)
      .then(viewUrl => { if (!cancelled) setUrl(viewUrl); })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [media.storageKey]);

  const title = media.originalFilename ?? (media.kind === 'pdf' ? 'PDF reference' : media.kind === 'video' ? 'Video reference' : 'Image reference');
  const kindLabel = media.kind === 'pdf' ? 'PDF reference' : media.kind === 'video' ? 'Video reference' : checkpoint ? 'Reference image' : 'Image reference';

  return (
    <article className={`course-reference-card${media.kind === 'pdf' ? ' is-pdf' : ''}${checkpoint ? ' is-checkpoint' : ''}`}>
      <div className="course-reference-heading">
        <div><p className="eyebrow">{kindLabel}</p><strong title={title}>{title}</strong></div>
        {url && <a className="course-reference-open" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${title} in a new tab`}>Open file <ExternalLink size={14} /></a>}
      </div>
      <div className={`course-reference-preview${media.kind === 'pdf' ? ' pdf' : ''}`}>
        {!url && !loadError && <div className="course-reference-loading"><FileText size={22} /><span>Loading preview…</span></div>}
        {loadError && <div className="course-reference-loading"><FileText size={22} /><span>Preview unavailable</span></div>}
        {url && media.kind === 'pdf' && <iframe src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={title} loading="lazy" />}
        {url && media.kind === 'image' && <img src={url} alt={title} loading="lazy" />}
        {url && media.kind === 'video' && <video src={url} controls preload="metadata" aria-label={title} />}
      </div>
    </article>
  );
}

type ApiSelfProfile = {
  id: string; name: string; email: string; trNumber: string | null; branchId: string; joinedAt: string;
  enrollments: { id: string; course_id: string; course_title: string; category: string; khat_type_id: string; percent_complete: string | number }[];
  levelSubmissions: { id: string; level_title: string; khat_type_id: string; time_spent_minutes: number; submitted_at: string }[];
  certificates: { id: string; title: string; status: string; file_storage_key?: string | null; issued_at?: string; khat_type_id?: string | null }[];
  badges: { id: string; khat_type_id: string; tier: string }[];
  timeSpentByKhatType: { khat_type_id: string; total_minutes: string | number }[];
  activity: ApiActivity[];
  photo_storage_key?: string | null;
};


// v3 note 4.3: certificates and badges, each with a Download button (src/v2/content).
export function Achievements() {
  return <V3AchievementsPage />;
}

export function Profile() {
  const user = getSessionUser();

  // 1. ALL useState declarations grouped at the top
  const [profile, setProfile] = useState<ApiSelfProfile | null>(null);
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [branchName, setBranchName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [submissionUrls, setSubmissionUrls] = useState<Record<string, string>>({});

  // 2. Fetch branches when profile branchId changes
  useEffect(() => {
    if (!profile?.branchId) return;
    apiFetch<{ id: string; name: string }[]>('/branches')
      .then(list => {
        setBranchName(list.find(b => b.id === profile.branchId)?.name ?? '');
      })
      .catch(() => {});
  }, [profile?.branchId]);

  // 3. Fetch khat types, profile data, photo URL, AND practice submission URLs
  useEffect(() => {
    apiFetch<ApiKhatType[]>('/khat-types').then(setKhatTypesList).catch(() => {});
    if (!user?.id) return;

    apiFetch<any>(`/students/${user.id}/profile`)
      .then(async data => {
        setProfile(data);

        // Resolve profile avatar
        const photoKey = data.photoStorageKey ?? data.photo_storage_key;
        if (photoKey) {
          try {
            const url = await getViewUrl(photoKey);
            setAvatarUrl(url);
          } catch (err) {
            console.error('Failed to resolve photo URL:', err);
          }
        }

        // Resolve URLs for all level submissions
        if (Array.isArray(data.levelSubmissions)) {
          const urlMap: Record<string, string> = {};
          await Promise.all(
            data.levelSubmissions.map(async (upload: any) => {
              const key = upload.storage_key ?? upload.storageKey ?? upload.file_storage_key;
              if (key) {
                try {
                  const url = await getViewUrl(key);
                  urlMap[upload.id] = url;
                } catch (e) {
                  console.error(`Failed to resolve URL for submission ${upload.id}`, e);
                }
              }
            })
          );
          setSubmissionUrls(urlMap);
        }
      })
      .catch(err => console.error('Profile fetch error:', err));
  }, [user?.id]);

  // 4. Early return ONLY AFTER all hooks have executed
  if (!profile) {
    return (
      <main className="page portal-page">
        <PenLoader label="Loading profile…" />
      </main>
    );
  }

  const khatName = (id: string) => khatTypesList.find(k => k.id === id)?.display_name ?? '—';
  const totalMinutes = profile.timeSpentByKhatType.reduce((sum, t) => sum + Number(t.total_minutes), 0);
  const earnedCertificates = profile.certificates.filter(certificate => certificate.status === 'approved');

  const openProfileCertificate = async (certificate: ApiSelfProfile['certificates'][number]) => {
    if (!certificate.file_storage_key) {
      navigate('achievements');
      return;
    }
    try {
      window.open(await getViewUrl(certificate.file_storage_key), '_blank', 'noopener,noreferrer');
    } catch {
      navigate('achievements');
    }
  };

  return (
    <main className="page portal-page">
      <div className="profile-hero">
        <div className="profile-avatar" style={{ overflow: 'hidden', padding: 0 }}>
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={profile.name}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            profile.name.split(' ').map(n => n[0]).slice(0, 2).join('')
          )}
        </div>
        <div>
          <p className="eyebrow">Student profile · your full view</p>
          <h1>{profile.name}</h1>
          <p>{branchName} · {profile.trNumber ?? ''} · Joined {new Date(profile.joinedAt).toLocaleDateString()}</p>
        </div>
        <Button outline onClick={() => navigate('showcase')}>
          Share a piece <Upload size={15} />
        </Button>
      </div>

      <div className="profile-stats">
        <StatCard icon={Flame} value={`${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`} label="Total practice time" />
        <StatCard icon={Award} value={String(profile.certificates.filter(c => c.status === 'approved').length)} label="Certificates earned" />
        <StatCard icon={Trophy} value={String(profile.badges.length)} label="Badges earned" />
      </div>

      <section className="profile-achievement-preview">
        <div className="profile-achievement-heading"><div><p className="eyebrow">Milestones earned</p><h2>Your certificates</h2><p>View certificates awarded for your progress.</p></div><Button outline onClick={() => navigate('achievements')}>All achievements <ArrowRight size={14} /></Button></div>
        {earnedCertificates.length ? <div className="profile-certificate-list">{earnedCertificates.slice(0, 3).map(certificate => <article className="profile-certificate-row" key={certificate.id}><span><Award size={17} /></span><div><strong>{certificate.title}</strong><small>{certificate.issued_at ? `Earned ${new Date(certificate.issued_at).toLocaleDateString()}` : 'Approved certificate'}</small></div><button className="text-link" onClick={() => void openProfileCertificate(certificate)}>View certificate <ExternalLink size={13} /></button></article>)}</div> : <div className="achievement-empty profile-certificate-empty"><FileText size={19} /><div><strong>No certificates earned yet</strong><p>Certificates you earn will appear here.</p></div></div>}
      </section>

      <SectionHeading title="Your hands" text="Progress and achievements, tracked separately per script — no combined badge." />
      <div className="profile-script-grid">
        {profile.enrollments.filter(e => e.category === 'certification').map(enr => {
          const kt = khatTypesList.find(k => k.id === enr.khat_type_id);
          if (!kt) return null;
          const script = scriptFromCode(kt.code);
          if (!script) return null;
          const badge = profile.badges.find(b => b.khat_type_id === enr.khat_type_id);
          return (
            <div className="profile-script" key={enr.id} style={{ '--script': khatTypes[script].color } as React.CSSProperties}>
              <div className="profile-script-head">
                <strong>{khatTypes[script].arabic}</strong>
                <div><h3>{khatTypes[script].name}</h3><span>{Math.round(Number(enr.percent_complete))}%</span></div>
                {badge && <BadgeIcon script={script} tier={badge.tier as never} />}
              </div>
              <div className="progress"><i style={{ width: `${Number(enr.percent_complete)}%` }} /></div>
            </div>
          );
        })}
        {profile.enrollments.filter(e => e.category === 'certification').length === 0 && <p className="muted">Not enrolled in a certification course yet — visit the catalog to begin.</p>}
      </div>

      <SectionHeading title="Your practice uploads" text="Every regular level upload, saved here for your reference and visible to your teachers." />
      <div className="practice-upload-grid">
        {profile.levelSubmissions.length === 0 && <p className="muted">No practice uploads yet.</p>}
        {profile.levelSubmissions.map(upload => (
          <div className="practice-upload-tile" key={upload.id}>
            <div className="practice-tile-art" style={{ overflow: 'hidden', padding: 0 }}>
              {submissionUrls[upload.id] ? (
                <img 
                  src={submissionUrls[upload.id]} 
                  alt={upload.level_title} 
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} 
                />
              ) : (
                <FileImage size={20} />
              )}
            </div>
            <div className="practice-upload-meta">
              <strong>{upload.level_title}</strong>
              <small>{khatName(upload.khat_type_id)} · {new Date(upload.submitted_at).toLocaleDateString()}</small>
            </div>
            <span className="practice-time"><Clock size={13} /> {upload.time_spent_minutes} min</span>
          </div>
        ))}
      </div>

      <div className="activity-card">
        <SectionHeading title="Practice rhythm" />
        <ActivityHeatmap activity={profile.activity} />
      </div>
    </main>
  );
}


// v3 notes 4.7 / E: reflection question + time taken (src/v2/content).
export function ShowcaseSubmission() {
  return <V3MyShowcasePage mode="student" />;
}

type ApiCompetition = { id: string; title: string; description: string | null; khat_type_id: string | null; start_date: string; end_date: string; status: string; results_published_at: string | null };
type ApiWinner = { rank: number; student_name: string; awarded_at: string; image_storage_key: string | null; imageUrl?: string };

function isCompetitionAcceptingEntries(competition: ApiCompetition): boolean {
  if (['completed', 'closed', 'cancelled'].includes(competition.status.toLowerCase())) return false;
  const localToday = new Date();
  const today = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, '0')}-${String(localToday.getDate()).padStart(2, '0')}`;
  const startDate = competition.start_date.slice(0, 10);
  const endDate = competition.end_date.slice(0, 10);
  return startDate <= endDate && endDate >= today;
}

// v3 audit: students use "Competitions & calls" (#v2-competitions), where results are published.
// The old guild-wide competitions page is gone; anything still pointing at #competitions lands there.
export function Competitions() {
  useEffect(() => { window.location.replace('#v2-competitions'); }, []);
  return <PenLoader label="Opening competitions…" />;
}

export function StudentEvents() {
  return <V3EventsPage />;
}

type ApiBook = { id: string; title: string; khat_type_id: string | null; file_storage_key: string; original_filename?: string | null; author?: string | null; language?: string | null; description?: string | null };
type V3LibraryBook = { id: string; title: string; author: string | null; language: string | null; description: string | null; khatTypeId: string | null; fileStorageKey: string; originalFilename: string | null };

export function Resources() {
  const [filter, setFilter] = useState<Script | 'All'>('All');
  const [language, setLanguage] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [booksLoading, setBooksLoading] = useState(true);
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [booksList, setBooksList] = useState<ApiBook[]>([]);
  const [viewerBook, setViewerBook] = useState<ApiBook | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

  useEffect(() => { apiFetch<ApiKhatType[]>('/khat-types').then(setKhatTypesList).catch(() => {}); }, []);
  useEffect(() => { const timer = window.setTimeout(() => setSearch(searchDraft.trim()), 250); return () => window.clearTimeout(timer); }, [searchDraft]);

  // v3 note 4.6: books with a filter (script, language, search by title or author).
  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'All') { const kt = khatTypesList.find(k => k.code === scriptCode(filter)); if (kt) params.set('khatTypeId', kt.id); }
    if (language) params.set('language', language);
    if (search) params.set('q', search);
    setBooksLoading(true);
    apiFetch<V3LibraryBook[]>(`/v2/books?${params.toString()}`, { silent: true })
      .then(list => setBooksList(list.map(b => ({ id: b.id, title: b.title, khat_type_id: b.khatTypeId, file_storage_key: b.fileStorageKey, original_filename: b.originalFilename, author: b.author, language: b.language, description: b.description }))))
      .catch(() => apiFetch<ApiBook[]>(`/books?${params.toString()}`).then(setBooksList).catch(() => {}))
      .finally(() => setBooksLoading(false));
  }, [filter, khatTypesList, language, search]);

  useEffect(() => () => {
    if (viewerUrl?.startsWith('blob:')) URL.revokeObjectURL(viewerUrl);
  }, [viewerUrl]);

  // audit 20: a missing book file never fails silently — the student gets a friendly message instead
  const BOOK_MISSING = 'This book isn’t available yet — please ask your teacher.';
  const download = async (book: ApiBook) => {
    if (!book.file_storage_key) { setViewerBook(book); setViewerUrl(null); setViewerError(BOOK_MISSING); return; }
    try {
      const objectUrl = await getFileObjectUrl(book.file_storage_key); // fails when the file is not there
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = (book.original_filename || book.title.replace(/[\\/:*?"<>|]/g, '_') + '.pdf');
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    } catch {
      setViewerBook(book); setViewerUrl(null); setViewerLoading(false); setViewerError(BOOK_MISSING);
    }
  };

  const viewBook = async (book: ApiBook) => {
    setViewerBook(book);
    setViewerUrl(null);
    setViewerError(null);
    setViewerLoading(true);
    try {
      if (!book.file_storage_key) throw new ApiError(404, BOOK_MISSING);
      setViewerUrl(await getFileObjectUrl(book.file_storage_key));
    } catch (err) {
      setViewerError(err instanceof ApiError && err.status !== 404 && err.status < 500 && !/not found|no such|missing/i.test(err.message) ? err.message : BOOK_MISSING);
    } finally {
      setViewerLoading(false);
    }
  };

  const closeViewer = () => {
    setViewerBook(null);
    setViewerUrl(null);
    setViewerError(null);
  };

  return (
    <main className="page portal-page resources-page">
      <SectionHeading eyebrow="The library" title="Books" text="Books on calligraphy to read on the site or download." />
      <div className="v3c-toolbar v3c-books-toolbar">
        <label className="v3c-search"><Search size={16} /><input value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="Search title or author" aria-label="Search books" /></label>
        <select className="v3c-select" value={filter} onChange={event => setFilter(event.target.value as Script | 'All')} aria-label="Filter by script">
          <option value="All">All scripts</option>
          {scriptList.map(s => <option key={s} value={s}>{khatTypes[s].name}</option>)}
        </select>
        <select className="v3c-select" value={language} onChange={event => setLanguage(event.target.value)} aria-label="Filter by language">
          <option value="">All languages</option>
          {['Arabic', 'Lisan ud-Dawat', 'Urdu', 'English', 'Farsi'].map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <p className="v3c-branch-note">{booksLoading ? 'Looking for books…' : `${booksList.length} ${booksList.length === 1 ? 'book' : 'books'}${filter !== 'All' || language || search ? ' match your filter' : ''}`}</p>
      <div className="resource-grid">
        {!booksLoading && booksList.length === 0 && <div className="resources-empty-state"><span className="resources-empty-icon"><BookOpen size={20} /></span><div><span className="eyebrow">{filter !== 'All' || language || search ? 'No match' : 'A quiet shelf'}</span><h3>{filter !== 'All' || language || search ? 'No books match this filter' : 'No books yet'}</h3><p>{filter !== 'All' || language || search ? 'Try another script, language or word.' : 'Books will appear here as they are added.'}</p></div><span className="resources-empty-flourish" aria-hidden="true">✦</span></div>}
        {booksList.map(book => {
          const kt = khatTypesList.find(k => k.id === book.khat_type_id);
          const script = kt ? scriptFromCode(kt.code) : null;
          return (
            <div className="resource-card" key={book.id}>
              <div className="resource-book-cover-frame"><Suspense fallback={<div className="book-cover resource-book-cover"><span className="resource-cover-placeholder"><BookOpen size={25} /><span>{book.title}</span></span></div>}><ResourceBookCover book={book} /></Suspense>{script && <span className="resource-book-script-tag">{khatTypes[script].name}</span>}</div>
              <strong>{book.title}</strong>
              {(book.author || book.language) && <small className="v3c-book-meta">{[book.author, book.language].filter(Boolean).join(' · ')}</small>}
              {book.description && <small className="v3c-book-desc">{book.description}</small>}
              <div className="resource-card-actions"><button className="resource-view-button" onClick={() => void viewBook(book)}><BookOpen size={14} /> Read</button><button className="text-link" onClick={() => void download(book)}><Download size={14} /> Download</button></div>
            </div>
          );
        })}
      </div>
      {viewerBook && <div className="resource-reader-layer" onMouseDown={event => { if (event.target === event.currentTarget) closeViewer(); }}>
        {viewerLoading ? <div className="resource-reader-message resource-reader-loading-page"><span className="resource-reader-spinner" /><strong>Opening resource</strong><small>Preparing your reader…</small></div> : viewerError ? <div className="resource-reader-error-panel"><button type="button" onClick={closeViewer} aria-label="Close viewer"><X size={18} /></button><FileText size={28} /><strong>{viewerError === BOOK_MISSING ? 'Not available yet' : 'Could not open resource'}</strong><p>{viewerError}</p></div> : viewerUrl && <Suspense fallback={<div className="resource-reader-message resource-reader-loading-page"><span className="resource-reader-spinner" /><strong>Preparing reader</strong><small>Loading the page viewer…</small></div>}><ResourcePdfViewer book={viewerBook} url={viewerUrl} onClose={closeViewer} /></Suspense>}
      </div>}
    </main>
  );
}

type ApiNotification = { id: string; type: string; payload: Record<string, unknown>; read: boolean; created_at: string };

function notificationCopy(n: ApiNotification): { title: string; body: string } {
  if (n.type === 'test_result') {
    return { title: 'Checkpoint result', body: n.payload.decision === 'pass' ? 'Your checkpoint test passed.' : 'A redo is needed for your last checkpoint test.' };
  }
  return { title: n.type.replace(/_/g, ' '), body: '' };
}

export function Notifications() {
  const [items, setItems] = useState<ApiNotification[]>([]);

  const load = () => apiFetch<ApiNotification[]>('/notifications').then(setItems).catch(() => {});
  useEffect(() => { load(); }, []);

  const markRead = async (id: string) => {
    await apiFetch(`/notifications/${id}/read`, { method: 'PATCH' }).catch(() => {});
    setItems(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  };

  return (
    <main className="page portal-page">
      <SectionHeading eyebrow="Stay in the loop" title="Notifications" text="A gentle nudge when something in your path changes." />
      <div className="notification-list">
        {items.length === 0 && <p className="muted">Nothing yet.</p>}
        {items.map(n => {
          const copy = notificationCopy(n);
          return (
            <div className={`notification ${n.read ? '' : 'unread'}`} key={n.id} onClick={() => !n.read && markRead(n.id)}>
              <div className="notification-icon"><Bell size={17} /></div>
              <div><strong>{copy.title}</strong>{copy.body && <p>{copy.body}</p>}<small>{new Date(n.created_at).toLocaleString()}</small></div>
              <ChevronRight size={16} />
            </div>
          );
        })}
      </div>
    </main>
  );
}

function calculateDayStreak(activity: ApiActivity[]): number {
  if (activity.length === 0) {
    return 0;
  }

  const activeDates = new Set(
    activity.map(item => item.activity_date.slice(0, 10))
  );

  const today = new Date();

  const toDateKey = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
  };

  const cursor = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );

  const todayKey = toDateKey(cursor);

  // If the student has not logged in today,
  // a streak can still continue from yesterday.
  if (!activeDates.has(todayKey)) {
    cursor.setDate(cursor.getDate() - 1);

    if (!activeDates.has(toDateKey(cursor))) {
      return 0;
    }
  }

  let streak = 0;

  while (activeDates.has(toDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}
