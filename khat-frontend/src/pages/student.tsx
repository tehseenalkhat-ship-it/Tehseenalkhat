import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowRight, Award, Bell, BookOpen, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardList, ExternalLink, FileImage, FileText, FileVideo, Flame, Lock, Pause, Play, Search, Sparkles, Trophy, Upload, X,
  Clock, Download,
} from 'lucide-react';
import type { Script } from '@/data/types';
import {
  khatTypes, scriptList,
  scriptToCode, scriptFromCode,
  encouragementQuotes, galleryWorks,
} from '@/data/mock';
import {
  navigate, Button, SectionHeading, StatusChip, BadgeIcon, ActivityHeatmap,
  StatCard, ScriptTabs, UploadBox, Modal, BackLink, ShowcaseSections, ShowcaseFeedSections, DashboardShowcaseCarousels, ShowcaseHeading, Footer, PenLoader,
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
import { openCourseLevel, useCourseSession } from '@/courseSession';
import { ShowcaseImageEditor } from '@/components/ShowcaseImageEditor';
import type { LiveKitRoomAccess } from '@/components/LiveKitEventRoom';
const ResourcePdfViewer = lazy(() => import('@/components/ResourcePdfViewer'));
const ResourceBookCover = lazy(() => import('@/components/ResourcePdfViewer').then(module => ({ default: module.ResourceBookCover })));
const LiveKitEventRoom = lazy(() => import('@/components/LiveKitEventRoom').then(module => ({ default: module.LiveKitEventRoom })));

type ApiMediaItem = { kind: 'video' | 'image' | 'pdf'; storageKey: string; originalFilename?: string };
type SheetSize = '1mm' | '2mm' | '3mm';
const SHEET_SIZES: SheetSize[] = ['1mm', '2mm', '3mm'];
type ApiSheetFiles = Partial<Record<SheetSize, { storageKey: string; originalFilename?: string }>>;
type ApiLevel = {
  id: string; course_id: string; order_index: number; level_type: 'mufradat' | 'writing' | 'test';
  title: string; media: ApiMediaItem[]; sheet_files: ApiSheetFiles; badge_tier: string | null; locked?: boolean;
};
type ApiCourse = { id: string; khat_type_id: string; category: string; title: string; description?: string };
type ApiEnrollment = { id: string; current_level_index: number; percent_complete: string | number; status: string };
type ApiSecondaryCourse = { course: ApiCourse; enrollment: ApiEnrollment | null; levels: ApiLevel[] };
type ApiKhatType = { id: string; code: string; display_name: string };
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

const CATALOG_SCRIPT_KEY = 'khat_catalog_script';
const dashboardScriptOrder: Script[] = ['Naskh', 'Sulus', 'Nastaaleeq', 'Naskh (Normal Pen)'];

function navigateToCatalogForScript(script: Script) {
  window.sessionStorage.setItem(CATALOG_SCRIPT_KEY, script);
  navigate('catalog');
}

function preferredCatalogScript(): Script {
  const requested = window.sessionStorage.getItem(CATALOG_SCRIPT_KEY);
  return requested && scriptList.includes(requested as Script) ? requested as Script : 'Naskh';
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
        <div className="hero-script">نسخ<br /><span>خط</span></div>
      </section>
      <main>
        <ShowcaseSections works={galleryWorks} />
        <section className="page section">
          <div className="winner-strip">
            <div>
              <Trophy size={18} />
              <div><strong>Latest competition winners</strong><span>Celebrating patience, proportion, and practice.</span></div>
            </div>
            <button onClick={() => navigate('competitions')}>See results <ArrowRight size={15} /></button>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}

export function StudentDashboard() {
  type DashboardCourse = {
    course: ApiCourse;
    enrollment: ApiEnrollment | null;
    progress: number;
    levels: ApiLevel[];
  };

  const [courses, setCourses] = useState<
    Record<Script, DashboardCourse | null>
  >({
    Naskh: null,
    'Naskh (Normal Pen)': null,
    Sulus: null,
    Nastaaleeq: null,
  });
  const [secondaryCourses, setSecondaryCourses] = useState<ApiSecondaryCourse[]>([]);
  const [secondaryFilter, setSecondaryFilter] = useState<Script | 'all'>('all');
  const [secondaryLoading, setSecondaryLoading] = useState(true);
  const [secondaryError, setSecondaryError] = useState<string | null>(null);
  const [enrollingSecondaryId, setEnrollingSecondaryId] = useState<string | null>(null);

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
  const [enrolling, setEnrolling] = useState<Script | null>(null);

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
          try {
            const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(`/levels/courses/${course.id}/progress`);
            return { course, enrollment: progress.enrollment, levels: progress.levels };
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              return { course, enrollment: null, levels: [] };
            }
            throw err;
          }
        }));
        if (!cancelled) {
          setKhatTypesList(types);
          setSecondaryCourses(coursesWithProgress);
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

  const enrollInSecondaryCourse = async (item: ApiSecondaryCourse) => {
    setEnrollingSecondaryId(item.course.id);
    setSecondaryError(null);
    try {
      await apiFetch('/levels/enroll', { method: 'POST', body: { courseId: item.course.id } });
      const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(`/levels/courses/${item.course.id}/progress`);
      const enrolled = { ...item, enrollment: progress.enrollment, levels: progress.levels };
      setSecondaryCourses(current => current.map(course => course.course.id === item.course.id ? enrolled : course));
      const firstAvailable = progress.levels.find(level => !level.locked);
      if (firstAvailable) {
        openCourseLevel(item.course.id, firstAvailable.id);
        navigate('course');
      }
    } catch (err) {
      setSecondaryError(err instanceof ApiError ? err.message : 'Could not enroll in this course.');
    } finally {
      setEnrollingSecondaryId(null);
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

        const results = await Promise.all(
          scriptList.map(async (script) => {
            const khatType = fetchedKhatTypes.find(
              k => k.code === scriptCode(script)
            );

            if (!khatType) {
              return [script, null] as const;
            }

            const certCourses =
              await apiFetch<ApiCourse[]>(
                `/courses?khatTypeId=${khatType.id}&category=certification`
              );

            const course = certCourses[0];

            if (!course) {
              return [script, null] as const;
            }

            const authoredLevels = await apiFetch<ApiLevel[]>(`/courses/${course.id}/levels`);

            /*
             * IMPORTANT:
             * We only READ progress here.
             * We do NOT automatically enroll the student.
             *
             * If the student is not enrolled, the progress endpoint
             * will fail and we treat it as "not enrolled".
             */
            try {
              const progress =
                await apiFetch<{
                  enrollment: ApiEnrollment;
                  levels: ApiLevel[];
                }>(
                  `/levels/courses/${course.id}/progress`
                );

              return [
                script,
                {
                  course,
                  enrollment: progress.enrollment,
                  progress: Number(
                    progress.enrollment?.percent_complete ?? 0
                  ),
                  levels: progress.levels,
                },
              ] as const;
            } catch {
              return [
                script,
                {
                  course,
                  enrollment: null,
                  progress: 0,
                  levels: [],
                },
              ] as const;
            }
          })
        );

        if (!cancelled) {
          setCourses(
            Object.fromEntries(results) as Record<
              Script,
              DashboardCourse | null
            >
          );
        }
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
    
        const profile = await apiFetch<{
          activity: ApiActivity[];
        }>(`/students/${user.id}/profile`);
    
        if (!cancelled) {
          setActivity(profile.activity ?? []);
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

  const enroll = async (script: Script) => {
    const dashboardCourse = courses[script];

    if (!dashboardCourse?.course) return;

    setEnrolling(script);
    setError(null);

    try {
      await apiFetch('/levels/enroll', {
        method: 'POST',
        body: {
          courseId: dashboardCourse.course.id,
        },
      });

      const progress =
        await apiFetch<{
          enrollment: ApiEnrollment;
          levels: ApiLevel[];
        }>(
          `/levels/courses/${dashboardCourse.course.id}/progress`
        );

      setCourses(prev => ({
        ...prev,
        [script]: {
          ...dashboardCourse,
          enrollment: progress.enrollment,
          progress: Number(
            progress.enrollment?.percent_complete ?? 0
          ),
          levels: progress.levels,
        },
      }));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : `Could not enroll in ${script}.`
      );
    } finally {
      setEnrolling(null);
    }
  };

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

  return (
    <main className="page portal-page">
      <div className="portal-welcome">
        <div>
          <p className="eyebrow">
            Your learning path
          </p>

          <h1>Your Path</h1>

          <p>
            Continue your calligraphy journey at your own pace.
          </p>
        </div>

        <div className="streak">
          <Flame size={22} />
        
          <strong>
            {activityLoading ? '—' : dayStreak}
          </strong>
        
          <span>day streak</span>
        </div>
      </div>

      {error && (
        <p className="error-text">
          {error}
        </p>
      )}

      <div className="certification-section-heading">
        <span className="certification-course-badge"><Award size={13} /> Certification courses</span>
      </div>
      <div className="script-progress-grid">
        {dashboardScriptOrder.map(script => {
          const dashboardCourse =
            courses[script];

          const active = Boolean(dashboardCourse?.enrollment && dashboardCourse.levels.length > 0);

          const progress =
            dashboardCourse?.progress ?? 0;

          const levels =
            dashboardCourse?.levels ?? [];

          const currentLevelIndex =
            dashboardCourse?.enrollment
              ?.current_level_index ?? 0;

          const currentLevel =
            levels[currentLevelIndex] ?? null;

          const nextLevel =
            levels[currentLevelIndex + 1] ?? null;

          return (
            <div
              className={`progress-card ${!active ? 'not-enrolled' : ''} ${script === 'Naskh (Normal Pen)' ? 'normal-pen-progress-card' : ''}`}
              key={script}
              style={
                {
                  '--script':
                    khatTypes[script].color,
                } as React.CSSProperties
              }
            >
              <div className="card-top">
                <strong
                  style={{
                    color:
                      khatTypes[script].color,
                  }}
                >
                  {khatTypes[script].arabic}
                </strong>

                <span>
                  {khatTypes[script].name}
                </span>

                {script === 'Naskh (Normal Pen)' && <small className="normal-pen-card-label">Ordinary pen · no cut qalam</small>}

                {active && (
                  <small>
                    <Flame size={13} />
                    Active
                  </small>
                )}
              </div>

              <div className={script === 'Naskh (Normal Pen)' ? 'normal-pen-card-body' : undefined}>
              {active ? (
                <>
                  <p>
                    Level:{' '}
                    <b>
                      {currentLevel?.title ??
                        'Getting started'}
                    </b>{' '}
                    · {Math.round(progress)}%
                  </p>

                  <div className="progress">
                    <i
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(0, progress)
                        )}%`,
                      }}
                    />
                  </div>

                  <small className="next">
                    {nextLevel
                      ? `Next: ${nextLevel.title}`
                      : 'You have reached the current final level.'}
                  </small>

                  <div className="card-actions">
                    <Button
                      onClick={() =>
                        navigateToCatalogForScript(script)
                      }
                    >
                      Continue
                      <ArrowRight size={14} />
                    </Button>

                    <Button
                      outline
                      onClick={() =>
                        navigateToCatalogForScript(script)
                      }
                    >
                      Submit practice
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    {script === 'Naskh (Normal Pen)'
                      ? 'A dedicated Naskh certification path for everyday pen practice, separate from the three cut-qalam courses.'
                      : "Not yet enrolled. Start whenever you're ready — no prerequisite from your other tracks."}
                  </p>

                  {dashboardCourse?.course ? (
                    dashboardCourse.levels.length > 0 ? (
                      <Button
                        outline
                        onClick={() => enroll(script)}
                      >
                        {enrolling === script ? 'Enrolling…' : 'Enroll free'}
                        <ArrowRight size={14} />
                      </Button>
                    ) : (
                      <small className="muted">Course design in progress · enrollment opens when lessons are ready.</small>
                    )
                  ) : (
                    <small className="muted">
                      This course is not available yet.
                    </small>
                  )}
                </>
              )}
              </div>
            </div>
          );
        })}
      </div>

      <section className="dashboard-secondary-section" aria-labelledby="dashboard-secondary-title">
        <div className="dashboard-secondary-heading">
          <div>
            <p className="eyebrow">Explore at your own pace</p>
            <h2 id="dashboard-secondary-title">Secondary courses</h2>
            <p>Optional lessons in technique, history, and composition — no certification prerequisites.</p>
          </div>
          <span className="dashboard-secondary-count">{secondaryCourses.length} {secondaryCourses.length === 1 ? 'course' : 'courses'}</span>
        </div>
        <div className="dashboard-secondary-filters" role="group" aria-label="Filter secondary courses by script">
          {(['all', ...scriptList] as (Script | 'all')[]).map(filter => (
            <button
              type="button"
              key={filter}
              className={`secondary-filter-chip${secondaryFilter === filter ? ' active' : ''}`}
              aria-pressed={secondaryFilter === filter}
              onClick={() => setSecondaryFilter(filter)}
            >
              {filter === 'all' ? 'All scripts' : filter === 'Sulus' ? 'Thuluth' : khatTypes[filter].name}
            </button>
          ))}
        </div>
        {secondaryError && <p className="error-text" role="alert">{secondaryError}</p>}
        {secondaryLoading ? (
          <div className="dashboard-secondary-loading"><PenLoader label="Loading secondary courses…" compact /> <span>Finding courses for your scripts…</span></div>
        ) : (
          <div className="dashboard-secondary-grid">
            {secondaryCourses.filter(item => {
              if (secondaryFilter === 'all') return true;
              const script = scriptFromCode(khatTypesList.find(type => type.id === item.course.khat_type_id)?.code ?? '');
              return script === secondaryFilter;
            }).map(item => {
              const script = scriptFromCode(khatTypesList.find(type => type.id === item.course.khat_type_id)?.code ?? '');
              const type = script ? khatTypes[script] : null;
              const enrolled = Boolean(item.enrollment);
              const currentIndex = item.enrollment?.current_level_index ?? 0;
              const currentLevel = item.levels[currentIndex] ?? item.levels.find(level => !level.locked) ?? null;
              const progress = Number(item.enrollment?.percent_complete ?? 0);
              const complete = Boolean(item.enrollment && item.levels.length > 0 && currentIndex >= item.levels.length);

              return (
                <article className="dashboard-secondary-card" key={item.course.id}>
                  <div className="dashboard-secondary-card-top">
                    <span className="secondary-course-tag"><BookOpen size={13} /> Self-learning</span>
                    {enrolled && <StatusChip tone="green">{complete ? 'Complete' : 'In progress'}</StatusChip>}
                  </div>
                  <div className="dashboard-secondary-title-row">
                    {type && script !== 'Naskh' && <span className="secondary-script-mark" aria-hidden="true">{type.arabic}</span>}
                    <div><h3>{item.course.title}</h3>{type && <span className="secondary-script-name">{type.name}</span>}</div>
                  </div>
                  <p className="dashboard-secondary-description">{item.course.description || 'Explore this self-paced course and work through its lessons in your own time.'}</p>
                  {enrolled ? (
                    <>
                      <div className="dashboard-secondary-progress-copy"><span>{complete ? 'Course progress' : currentLevel?.title ?? 'Ready to begin'}</span><strong>{Math.round(progress)}%</strong></div>
                      <div className="progress dashboard-secondary-progress"><i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>
                      <Button disabled={!currentLevel} onClick={() => currentLevel && (openCourseLevel(item.course.id, currentLevel.id), navigate('course'))}>{complete ? 'Review course' : 'Continue learning'} <ArrowRight size={14} /></Button>
                    </>
                  ) : (
                    <>
                      <div className="dashboard-secondary-progress-copy"><span>Not started</span><strong>0%</strong></div>
                      <div className="progress dashboard-secondary-progress"><i style={{ width: '0%' }} /></div>
                      <Button outline disabled={enrollingSecondaryId === item.course.id} onClick={() => void enrollInSecondaryCourse(item)}>{enrollingSecondaryId === item.course.id ? 'Enrolling…' : 'Start learning'} <ArrowRight size={14} /></Button>
                    </>
                  )}
                </article>
              );
            })}
            {secondaryCourses.length === 0 && <div className="dashboard-secondary-empty"><Sparkles size={19} /><div><strong>More ways to explore are on their way</strong><p>New secondary courses will appear here when they’re available.</p></div></div>}
            {secondaryCourses.length > 0 && secondaryFilter !== 'all' && !secondaryCourses.some(item => khatTypesList.find(type => type.id === item.course.khat_type_id)?.code === scriptCode(secondaryFilter)) && <div className="dashboard-secondary-empty"><BookOpen size={19} /><div><strong>No {secondaryFilter === 'Sulus' ? 'Thuluth' : secondaryFilter} courses yet</strong><p>Try another script filter to explore available courses.</p></div></div>}
          </div>
        )}
      </section>

      <div className="dashboard-lower">
        {/* ==============================
            LAST CHECKPOINT TEST
            ============================== */}

        <div className="submission-card">
          <p className="eyebrow">
            Your last checkpoint test
          </p>

          {checkpointLoading ? (
            <PenLoader label="Loading checkpoint activity…" compact />
          ) : latestCheckpoint ? (
            <div className="checkpoint-result-content">
              <div className="submission-title">
                <div>
                  <h3>{checkpointScript ? `${checkpointScript} checkpoint` : 'Checkpoint test'}</h3>
                  <p>{checkpointLevel ? `Level: ${checkpointLevel}` : 'Checkpoint submission'} · Submitted {checkpointDate}</p>
                </div>
                <StatusChip tone={latestCheckpoint.status === 'reviewed' ? 'green' : latestCheckpoint.status === 'redo_needed' ? 'red' : 'amber'}>{checkpointStatus}</StatusChip>
              </div>
              {latestCheckpointReview && (
                <div className="checkpoint-teacher-result">
                  <div className="checkpoint-result-heading">
                    <div><strong>Teacher’s review</strong><small>{latestCheckpointReview.reviewed_by_name ? `Reviewed by ${latestCheckpointReview.reviewed_by_name}` : 'Reviewed by your teacher'}{latestCheckpointReview.reviewed_at ? ` · ${new Date(latestCheckpointReview.reviewed_at).toLocaleDateString()}` : ''}</small></div>
                    <StatusChip tone={latestCheckpointReview.status === 'reviewed' ? 'green' : 'red'}>{latestCheckpointReview.status === 'reviewed' ? 'Passed' : 'Needs redo'}</StatusChip>
                  </div>
                  {latestCheckpointReview.feedback && <p className="checkpoint-result-feedback">{latestCheckpointReview.feedback}</p>}
                  <div className="checkpoint-result-files">
                    {latestCheckpointReview.submissionImageUrl && <a href={latestCheckpointReview.submissionImageUrl} target="_blank" rel="noreferrer"><img src={latestCheckpointReview.submissionImageUrl} alt="Your reviewed checkpoint submission" /><span>Your submitted sheet</span></a>}
                    {latestCheckpointReview.correctionImageUrl && <a href={latestCheckpointReview.correctionImageUrl} target="_blank" rel="noreferrer"><img src={latestCheckpointReview.correctionImageUrl} alt="Teacher's annotated correction" /><span>Teacher’s annotated feedback</span></a>}
                  </div>
                  {latestCheckpointReview.correctionVoiceUrl && <StudentVoicePlayer src={latestCheckpointReview.correctionVoiceUrl} />}
                  {!latestCheckpointReview.feedback && !latestCheckpointReview.correctionImageUrl && !latestCheckpointReview.correctionVoiceUrl && <p className="muted">Your teacher did not add written, annotated, or voice feedback for this attempt.</p>}
                </div>
              )}
            </div>
          ) : (
            <div className="submission-title">
              <div>
                <h3>
                  No checkpoint submitted yet
                </h3>

                <p>
                  Your checkpoint activity will appear
                  here once you submit a test.
                </p>
              </div>

              <StatusChip tone="gold">
                No submission
              </StatusChip>
            </div>
          )}
        </div>

        {/* ==============================
            BADGES
            ============================== */}
        
        <div className="badge-panel dashboard-badge-panel">
          <div className="dashboard-badge-heading"><div><p className="eyebrow">Milestones earned</p><h2>Your badges</h2><p>Recognition for your dedication to each script.</p></div><span className="dashboard-badge-total">{badges.length} {badges.length === 1 ? 'badge' : 'badges'}</span></div>
        
          <div className="badge-row dashboard-badge-grid">
            {badgesLoading ? (
              <PenLoader label="Loading your badges…" compact />
            ) : badges.length === 0 ? (
              <div className="dashboard-badge-empty"><span className="dashboard-badge-placeholder"><img src="/mock-badge.svg" alt="" /></span><div><strong>Your first badge is waiting</strong><p>Pass a checkpoint to earn a badge for your script.</p></div></div>
            ) : (
              badges.map(badge => {
                const badgeScript = scriptFromCode(badge.khat_type_code);
        
                if (!badgeScript) {
                  return null;
                }
        
                const asset = badgeArtwork.find(item => item.key === `${badge.khat_type_id}:${badge.tier}`);
                const tierLabel = badge.tier.charAt(0).toUpperCase() + badge.tier.slice(1);
                return <article className="dashboard-badge-card" key={badge.id} style={{ '--badge-accent': khatTypes[badgeScript].color, '--badge-accent-soft': khatTypes[badgeScript].soft } as React.CSSProperties}>
                  <div className="dashboard-badge-art">
                    {asset?.mediaType === 'image' && asset.url
                      ? <img src={asset.url} alt={`${tierLabel} ${badge.khat_type_name} badge`} />
                      : <img className="dashboard-badge-mock" src="/mock-badge.svg" alt={`${tierLabel} badge artwork`} />}
                    {asset?.mediaType === 'pdf' && asset.url && <a href={asset.url} target="_blank" rel="noreferrer" className="dashboard-badge-pdf-link"><FileText size={13} /> View PDF</a>}
                  </div>
                  <div className="dashboard-badge-card-copy"><span className="dashboard-badge-script">{badge.khat_type_name}</span><strong>{tierLabel}</strong><small>Earned {new Date(badge.awarded_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</small></div>
                  <span className="dashboard-badge-check"><Check size={14} /></span>
                </article>;
              })
            )}
          </div>
        </div>
      </div>

      {/* ==============================
          UPCOMING EVENTS
          ============================== */}

      <div className="upcoming-events-strip">
        <SectionHeading
          title="Upcoming events"
          action={
            <button
              className="text-link"
              onClick={() =>
                navigate('events')
              }
            >
              All events
              <ArrowRight size={14} />
            </button>
          }
        />

        <div className="event-mini-row">
          {eventsLoading ? (
            <div className="event-mini">
              <PenLoader label="Loading upcoming events…" compact />
            </div>
          ) : events.length === 0 ? (
            <div className="event-mini">
              <span className="muted">
                No upcoming events.
              </span>
            </div>
          ) : (
            events.map(event => (
              <div
                className="event-mini"
                key={event.id}
              >
                <StatusChip
                  tone={
                    event.status === 'live'
                      ? 'green'
                      : 'gold'
                  }
                >
                  {event.status === 'live'
                    ? 'Live now'
                    : 'Upcoming'}
                </StatusChip>

                <strong>
                  {event.title}
                </strong>

                <small>
                  {event.host_name}
                  {' · '}
                  {event.branch_name}
                </small>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ==============================
          PRACTICE RHYTHM
          
          Still intentionally untouched.
          We will connect this to login
          activity after tracing the backend.
          ============================== */}

      <div className="activity-card">
        <SectionHeading
          title="Your practice rhythm"
          text="Your login activity over the last 12 weeks."
          action={
            <span className="muted">
              Login activity
            </span>
          }
        />

        <ActivityHeatmap activity={activity} />
      </div>
      <ShowcaseHeading title="From the guild" text="Recent shares from students and faculty." action={<button className="text-link" onClick={() => navigate('gallery')}>Visit gallery <ArrowRight size={14} /></button>} />
      {showcaseLoading ? (
        <PenLoader label="Loading gallery…" compact />
      ) : (
        <DashboardShowcaseCarousels posts={showcasePosts.map(post => ({
          id: post.id,
          role: post.user_role ?? 'student',
          imageUrl: post.imageUrl,
          caption: post.caption,
          authorName: post.author_name,
          branch: post.branch_name ?? post.branch,
          likes: Number(post.like_count),
          liked: post.liked_by_me,
        }))} onLike={toggleShowcaseLike} />
      )}
      {winners.length > 0 && (
        <section className="dashboard-winners-section" aria-label="Latest competition winners">
          <SectionHeading
            eyebrow="Guild honors"
            title="Latest competition winners"
            text="Celebrating the students and their work across the guild."
            action={<button className="text-link" onClick={() => navigate('competitions')}>See all results <ArrowRight size={15} /></button>}
          />
          <div className="dashboard-winner-grid">
            {winners.map((winner, index) => (
              <article className="dashboard-winner-card" key={`${winner.competitionTitle}-${winner.student_name}-${index}`}>
                <span className="dashboard-winner-trophy"><Trophy size={17} /></span>
                <div><strong>{winner.student_name}</strong><span>{winner.competitionTitle}</span></div>
                <span className="dashboard-winner-rank">Winner</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

export function Catalog() {
  const [script, setScript] = useState<Script>(preferredCatalogScript);
  const [course, setCourse] = useState<ApiCourse | null>(null);
  const [levels, setLevels] = useState<ApiLevel[]>([]);
  const [enrollment, setEnrollment] = useState<ApiEnrollment | null>(null);
  const [secondary, setSecondary] = useState<ApiSecondaryCourse[]>([]);
  const [enrollingSecondaryId, setEnrollingSecondaryId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.sessionStorage.removeItem(CATALOG_SCRIPT_KEY);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const khatTypesList = await apiFetch<ApiKhatType[]>('/khat-types');
        const khatType = khatTypesList.find(k => k.code === scriptCode(script));
        if (!khatType) throw new Error('This script is not set up on the server yet.');

        const [certCourses, secondaryCourses] = await Promise.all([
          apiFetch<ApiCourse[]>(`/courses?khatTypeId=${khatType.id}&category=certification`),
          apiFetch<ApiCourse[]>(`/courses?khatTypeId=${khatType.id}&category=secondary`),
        ]);
        const cert = certCourses[0] ?? null;

        if (cert) {
          const authoredLevels = await apiFetch<ApiLevel[]>(`/courses/${cert.id}/levels`);
          if (!cancelled) {
            setCourse(cert);
            setLevels(authoredLevels);
          }
          if (authoredLevels.length > 0) {
            await apiFetch('/levels/enroll', { method: 'POST', body: { courseId: cert.id } });
            const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(
              `/levels/courses/${cert.id}/progress`
            );
            if (!cancelled) {
              setLevels(progress.levels);
              setEnrollment(progress.enrollment);
            }
          } else if (!cancelled) {
            setEnrollment(null);
          }
        } else if (!cancelled) {
          setCourse(null);
          setLevels([]);
          setEnrollment(null);
        }
        const secondaryWithProgress = await Promise.all(secondaryCourses.map(async secondaryCourse => {
          try {
            const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(`/levels/courses/${secondaryCourse.id}/progress`);
            return { course: secondaryCourse, enrollment: progress.enrollment, levels: progress.levels };
          } catch (progressError) {
            if (progressError instanceof ApiError && progressError.status === 404) {
              return { course: secondaryCourse, enrollment: null, levels: [] };
            }
            throw progressError;
          }
        }));
        if (!cancelled) setSecondary(secondaryWithProgress);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load this course.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [script]);

  const openLevel = (courseId: string, levelId: string) => {
    openCourseLevel(courseId, levelId);
    navigate('course');
  };

  const enrollAndOpenSecondary = async (secondaryCourse: ApiSecondaryCourse) => {
    setEnrollingSecondaryId(secondaryCourse.course.id);
    setError(null);
    try {
      await apiFetch('/levels/enroll', { method: 'POST', body: { courseId: secondaryCourse.course.id } });
      const progress = await apiFetch<{ enrollment: ApiEnrollment; levels: ApiLevel[] }>(`/levels/courses/${secondaryCourse.course.id}/progress`);
      setSecondary(current => current.map(item => item.course.id === secondaryCourse.course.id
        ? { ...item, enrollment: progress.enrollment, levels: progress.levels }
        : item));
      if (progress.levels[0]) openLevel(secondaryCourse.course.id, progress.levels[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not enroll in this course.');
    } finally {
      setEnrollingSecondaryId(null);
    }
  };

  return (
    <main className="page portal-page">
      <SectionHeading eyebrow="Course catalog" title={`${khatTypes[script].name} curriculum`} text="Build the hand one measured exercise at a time." action={<ScriptTabs script={script} setScript={setScript} />} />
      {loading && <PenLoader label="Loading course…" />}
      {error && <p className="error-text">{error}</p>}

      {!loading && course && (
        <>
          <div className="course-banner" style={{ '--script': khatTypes[script].color, '--script-soft': khatTypes[script].soft } as React.CSSProperties}>
            <div>
              <p className="eyebrow">Certification course</p>
              <h2>{khatTypes[script].name} · The complete hand</h2>
              <p>{levels.length > 0 ? `${levels.length} levels. Regular practice levels unlock immediately on upload — only checkpoint tests are teacher-reviewed.` : 'This certification path is being prepared. Enrollment opens once its lessons and teacher-reviewed checkpoints are ready.'}</p>
            </div>
            <StatusChip>{levels.length > 0 ? `${Math.round(Number(enrollment?.percent_complete ?? 0))}% complete` : 'In preparation'}</StatusChip>
          </div>
          {levels.length > 0 ? <div className="level-list">
            {levels.map((level, i) => (
              <button
                className={`level-row ${level.locked ? 'locked' : ''} ${level.level_type === 'test' ? 'is-checkpoint' : ''}`}
                onClick={() => !level.locked && openLevel(course.id, level.id)}
                key={level.id}
              >
                <span className="level-number">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{level.title}</strong>
                  <small>{level.level_type === 'test' ? 'Checkpoint test · teacher reviewed' : 'Practice level · instant unlock'}</small>
                </div>
                <span>{level.locked ? <Lock size={16} /> : level.level_type === 'test' ? <StatusChip tone="amber">Test</StatusChip> : <Check size={16} />}</span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div> : <div className="course-preparation-note"><BookOpen size={19} /><span>Course design is in progress. Please check back soon.</span></div>}
        </>
      )}
      {!loading && !course && !error && <p className="muted">No certification course has been set up yet for {khatTypes[script].name} — check back soon.</p>}

      <SectionHeading eyebrow="Open once enrolled" title="Secondary & self-learning" text="Explore technique, history, and composition without locks." />
      <div className="secondary-grid">
        {!loading && secondary.length === 0 && (
          <div className="secondary-empty-state">
            <div className="secondary-empty-mark" aria-hidden="true"><Sparkles size={20} /></div>
            <div>
              <span className="eyebrow">A space for your next chapter</span>
              <h3>More ways to explore are on their way</h3>
              <p>There are no open self-learning courses for {khatTypes[script].name} just yet. Check back as new lessons are added.</p>
            </div>
            <span className="secondary-empty-flourish" aria-hidden="true">✦</span>
          </div>
        )}
        {secondary.map(item => {
          const { course: secondaryCourse, enrollment: secondaryEnrollment, levels: secondaryLevels } = item;
          const active = Boolean(secondaryEnrollment);
          const currentIndex = secondaryEnrollment?.current_level_index ?? 0;
          const currentLevel = secondaryLevels[currentIndex] ?? secondaryLevels[secondaryLevels.length - 1] ?? null;
          const nextLevel = secondaryLevels[currentIndex + 1] ?? null;
          const progress = Number(secondaryEnrollment?.percent_complete ?? 0);
          const completed = Boolean(secondaryEnrollment && secondaryLevels.length > 0 && currentIndex >= secondaryLevels.length);

          return (
            <article
              className={`progress-card secondary-course-card${active ? '' : ' not-enrolled'}`}
              key={secondaryCourse.id}
            >
              <div className="card-top">
                <span>{secondaryCourse.title}</span>
                {active && <small><Flame size={13} /> Active</small>}
              </div>

              {active ? (
                <>
                  {currentLevel ? (
                    <>
                      <p>Level: <b>{currentLevel.title}</b> · {Math.round(progress)}%</p>
                      <div className="progress"><i style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>
                      <small className="next">{completed ? 'Course completed — revisit any level when you like.' : nextLevel ? `Next: ${nextLevel.title}` : 'You are on the final level.'}</small>
                      <div className="card-actions">
                        <Button onClick={() => openLevel(secondaryCourse.id, currentLevel.id)}>{completed ? 'Review course' : 'Continue'} <ArrowRight size={14} /></Button>
                        {!completed && currentLevel.level_type !== 'test' && <Button outline onClick={() => openLevel(secondaryCourse.id, currentLevel.id)}>Submit practice</Button>}
                      </div>
                    </>
                  ) : (
                    <p>This course has no levels available yet.</p>
                  )}
                </>
              ) : (
                <>
                  <p className="secondary-course-description">{secondaryCourse.description || 'Explore this self-paced course and work through its lessons in your own time.'}</p>
                  <p className="secondary-course-progress-label">Progress: <b>Not started</b> · 0%</p>
                  <div className="progress"><i style={{ width: '0%' }} /></div>
                  <div className="card-actions">
                    <Button outline disabled={enrollingSecondaryId === secondaryCourse.id} onClick={() => enrollAndOpenSecondary(item)}>{enrollingSecondaryId === secondaryCourse.id ? 'Enrolling…' : 'Enroll now'} <ArrowRight size={14} /></Button>
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}

export function CourseEnvironment() {
  const session = useCourseSession();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [levels, setLevels] = useState<ApiLevel[]>([]);
  const [activeLevelId, setActiveLevelId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [minutes, setMinutes] = useState('');
  const [uploading, setUploading] = useState(false);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [saved, setSaved] = useState(false);
  const [quote] = useState(() => encouragementQuotes[Math.floor(Math.random() * encouragementQuotes.length)]);

  // Checkpoint-specific state — the student's most recent entry for this level, if any.
  const [myEntry, setMyEntry] = useState<{ id: string; status: string; feedback?: string | null; correction_image_storage_key?: string | null; correction_voice_storage_key?: string | null } | null>(null);
  const [reviewFeedbackEntry, setReviewFeedbackEntry] = useState<{ feedback?: string | null; correction_image_storage_key?: string | null; correction_voice_storage_key?: string | null } | null>(null);
  const [teacherVoiceUrl, setTeacherVoiceUrl] = useState<string | null>(null);
  const [teacherCorrectionUrl, setTeacherCorrectionUrl] = useState<string | null>(null);

  const loadLevels = async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const progress = await apiFetch<{ levels: ApiLevel[] }>(`/levels/courses/${session.courseId}/progress`);
      setLevels(progress.levels);
      setActiveLevelId(session.levelId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load this course.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLevels(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [session?.courseId, session?.levelId]);

  const level = levels.find(l => l.id === activeLevelId);
  const isCheckpoint = level?.level_type === 'test';

  useEffect(() => {
    setPickedFile(null);
    setSaved(false);
    setMinutes('');
    setMyEntry(null);
    setReviewFeedbackEntry(null);
    setTeacherVoiceUrl(null);
    setTeacherCorrectionUrl(null);
    if (level && level.level_type === 'test') {
      apiFetch<{ id: string; level_id: string; status: string; feedback?: string | null; correction_image_storage_key?: string | null; correction_voice_storage_key?: string | null; created_at?: string }[]>('/entries/mine')
        .then(async entries => {
          const levelEntries = entries.filter(e => e.level_id === level.id);
          const latest = levelEntries[0];
          const latestReview = levelEntries.find(e => e.status === 'reviewed' || e.status === 'redo_needed');
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
    setUploading(true);
    try {
      const { storageKey, originalFilename } = await uploadFile('level-submissions', pickedFile);
      await apiFetch(`/levels/${level.id}/submissions`, {
        method: 'POST',
        body: { fileStorageKey: storageKey, originalFilename, timeSpentMinutes: Number(minutes) || 0 },
      });
      setSaved(true);
      await loadLevels();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your practice.');
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
          body: { khatImageStorageKey: storageKey, originalFilename },
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
    else navigate('catalog');
  };

  return (
    <div className={`course-env ${mobileSidebarOpen ? 'mobile-open' : ''}`}>
      {/* Small-screen hamburger for course sidebar */}
      <button className="page-sidebar-hamburger" onClick={() => setMobileSidebarOpen(v => !v)} aria-label="Open course menu" title="Course menu">
        <span className="hamburger-icon">☰</span>
      </button>

      <aside className="course-env-sidebar">
        <div className="course-env-header">
          <p className="eyebrow">Certification</p>
          <h3>Course levels</h3>
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
        <button className="course-env-exit" onClick={() => { navigate('catalog'); setMobileSidebarOpen(false); }}><X size={16} /> Exit course</button>
      </aside>

      {/* Backdrop for course sidebar on mobile */}
      <div className={`course-env-backdrop${mobileSidebarOpen ? ' open' : ''}`} onClick={() => setMobileSidebarOpen(false)} />

      <main className="course-env-main">
        <div className="course-env-content">
          {loading && <PenLoader label="Loading…" compact />}
          {error && <p className="error-text">{error}</p>}
          {!loading && level && (
            <>
              <div className="level-heading">
                <div>
                  <p className="eyebrow">Level {levels.findIndex(l => l.id === level.id) + 1}</p>
                  <h1>{level.title}</h1>
                  <p>{isCheckpoint ? 'Checkpoint test — teacher reviewed. Upload a clear photo of your completed sheet.' : 'Practice at your own pace. Uploading your practice immediately unlocks the next level.'}</p>
                </div>
                <StatusChip tone={isCheckpoint ? 'amber' : 'green'}>{isCheckpoint ? 'Test · Teacher reviewed' : 'Practice · Instant unlock'}</StatusChip>
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
                  <div className="lesson-grid">
                    {level.media.length === 0 && <p className="muted">No reference uploaded yet for this level.</p>}
                    {level.media.map((m, i) => <CourseReferenceCard key={`${m.storageKey}-${i}`} media={m} />)}
                  </div>
                  <div className="practice-panel">
                    <SectionHeading eyebrow="Make it yours" title="Submit your practice" text="A clear photo in natural light is best. Your practice is saved to your profile and the next level unlocks immediately — no review needed." />
                    <div className="practice-form">
                      <label className="field-label">Minutes practiced<input className="field" type="number" value={minutes} onChange={e => setMinutes(e.target.value)} placeholder="e.g. 25" /></label>
                      <UploadBox label={pickedFile?.name || 'Drop your practice sheet here'} sublabel={pickedFile ? 'Ready to save' : 'PNG, JPG up to 10 MB · tap to browse'} onChange={setPickedFile} />
                    </div>
                    <div className="practice-actions">
                      <SheetDownloadMenu files={level.sheet_files} label="Practice sheets" />
                      <Button onClick={submitPractice}>{uploading ? <PenLoader label="Saving practice" compact tiny /> : saved ? 'Saved' : 'Save practice'} {!uploading && <ArrowRight size={15} />}</Button>
                    </div>
                  </div>
                  {saved && (
                    <Modal onClose={nextUnlockedLevel}>
                      <Sparkles size={30} className="gold-icon" />
                      <p className="eyebrow">A note for your desk</p>
                      <h2>"{quote}"</h2>
                      <p>Practice saved — next level unlocked. Your upload is on your profile for your teacher to see, but it's never queued for review.</p>
                      <Button onClick={nextUnlockedLevel}>Continue</Button>
                    </Modal>
                  )}
                </>
              )}
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

type ApiEarnedCertificate = {
  id: string;
  title: string;
  file_storage_key: string;
  issued_at: string;
  khat_type_id: string;
  status?: string;
  previewUrl?: string | null;
};
type ApiEarnedBadge = {
  id: string;
  khat_type_id: string;
  tier: string;
  awarded_at: string;
  khat_type_code: string;
  khat_type_name: string;
};
type ApiBadgeArtworkItem = { key: string; filename: string; mediaType: 'image' | 'pdf'; url: string | null };
type ApiCompetitionAchievement = {
  rank: number;
  awarded_at: string;
  competition_id: string;
  competition_title: string;
  khat_type_id: string | null;
  khat_type_name: string | null;
  image_storage_key: string | null;
  imageUrl?: string;
};

export function Achievements() {
  const [certificates, setCertificates] = useState<ApiEarnedCertificate[]>([]);
  const [badges, setBadges] = useState<ApiEarnedBadge[]>([]);
  const [badgeArtwork, setBadgeArtwork] = useState<ApiBadgeArtworkItem[]>([]);
  const [competitionAwards, setCompetitionAwards] = useState<ApiCompetitionAchievement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadAchievements() {
      setLoading(true);
      setError(null);
      const [certificateResult, badgeResult, artworkResult, competitionResult] = await Promise.allSettled([
        apiFetch<ApiEarnedCertificate[]>('/certificates/mine'),
        apiFetch<ApiEarnedBadge[]>('/badges'),
        apiFetch<ApiBadgeArtworkItem[]>('/badges/assets'),
        apiFetch<ApiCompetitionAchievement[]>('/competitions/mine/achievements'),
      ]);
      if (cancelled) return;
      if (certificateResult.status === 'fulfilled') {
        const resolvedCertificates = await Promise.all(certificateResult.value.map(async certificate => {
          try { return { ...certificate, previewUrl: await getViewUrl(certificate.file_storage_key) }; }
          catch { return { ...certificate, previewUrl: null }; }
        }));
        if (!cancelled) setCertificates(resolvedCertificates);
      }
      if (badgeResult.status === 'fulfilled') setBadges(badgeResult.value);
      if (artworkResult.status === 'fulfilled') setBadgeArtwork(artworkResult.value);
      if (competitionResult.status === 'fulfilled') {
        const resolvedAwards = await Promise.all(competitionResult.value.map(async award => {
          if (!award.image_storage_key) return award;
          try { return { ...award, imageUrl: await getViewUrl(award.image_storage_key) }; }
          catch { return award; }
        }));
        if (!cancelled) setCompetitionAwards(resolvedAwards);
      }
      if ([certificateResult, badgeResult, competitionResult].every(result => result.status === 'rejected')) {
        setError('Could not load your achievements. Please try again.');
      }
      if (!cancelled) setLoading(false);
    }
    void loadAchievements();
    return () => { cancelled = true; };
  }, []);

  const viewCertificate = async (certificate: ApiEarnedCertificate) => {
    try {
      const url = await getViewUrl(certificate.file_storage_key);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setError(`Could not open “${certificate.title}”.`);
    }
  };

  const downloadCertificate = async (certificate: ApiEarnedCertificate) => {
    try {
      const extension = certificate.file_storage_key.match(/\.(pdf|png|jpe?g|webp)$/i)?.[0] ?? '';
      const filename = `${certificate.title}${extension}`;
      const url = await getDownloadUrl(certificate.file_storage_key, filename);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${certificate.title.replace(/[\\/:*?"<>|]/g, '_')}${extension}`;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.click();
    } catch {
      setError(`Could not download “${certificate.title}”.`);
    }
  };

  const earnedCount = certificates.length + badges.length + competitionAwards.length;

  return (
    <main className="page portal-page achievements-page">
      <SectionHeading eyebrow="Your calligraphy journey" title="Achievements" text="A personal archive of certificates, script badges, and published competition awards." />
      <div className="achievement-summary-strip">
        <div><Award size={19} /><strong>{earnedCount}</strong><span>honors earned</span></div>
        <div><FileText size={18} /><strong>{certificates.length}</strong><span>certificates</span></div>
        <div><Trophy size={18} /><strong>{badges.length + competitionAwards.length}</strong><span>badges & awards</span></div>
      </div>
      {error && <p className="error-text" role="alert">{error}</p>}
      {loading ? <PenLoader label="Gathering your achievements…" /> : (
        <>
          <section className="achievement-section">
            <SectionHeading eyebrow="Course milestones" title="Certificates" text="Approved certificates earned from your course milestones." />
            {certificates.length ? <div className="achievement-certificate-grid">{certificates.map(certificate => {
              const khatName = certificate.khat_type_id ? badges.find(badge => badge.khat_type_id === certificate.khat_type_id)?.khat_type_name : null;
              const isPdf = /\.pdf$/i.test(certificate.file_storage_key);
              return <article className="achievement-certificate-card" key={certificate.id}>
                <div className={`achievement-certificate-preview${isPdf ? ' is-pdf' : ''}`}>
                  {certificate.previewUrl ? (isPdf
                    ? <iframe src={`${certificate.previewUrl}#toolbar=0&navpanes=0&view=FitH`} title={`${certificate.title} certificate preview`} loading="lazy" />
                    : <img src={certificate.previewUrl} alt={`${certificate.title} certificate`} loading="lazy" />)
                    : <div><Award size={27} /><span>Certificate preview unavailable</span></div>}
                </div>
                <div className="achievement-card-icon"><Award size={21} /></div>
                <div className="achievement-card-copy"><small>{khatName ?? 'Calligraphy certification'}</small><h3>{certificate.title}</h3><span>Earned {new Date(certificate.issued_at).toLocaleDateString()}</span></div>
                <div className="achievement-card-actions"><Button onClick={() => void viewCertificate(certificate)}>View certificate <ExternalLink size={14} /></Button><Button outline onClick={() => void downloadCertificate(certificate)}><Download size={14} /> Download</Button></div>
              </article>;
            })}</div> : <div className="achievement-empty"><FileText size={20} /><div><strong>No certificates earned yet</strong><p>Approved course certificates will be collected here when you reach their milestones.</p></div></div>}
          </section>

          <section className="achievement-section">
            <SectionHeading eyebrow="Script milestones" title="Badges" text="Badges recognize progress in each hand and remain part of your permanent record." />
            {badges.length ? <div className="achievement-badge-grid">{badges.map(badge => {
              const script = scriptFromCode(badge.khat_type_code) ?? 'Naskh';
              const artwork = badgeArtwork.find(item => item.key === `${badge.khat_type_id}:${badge.tier}`);
              return <article className="achievement-badge-card" key={badge.id} style={{ '--script': khatTypes[script].color } as React.CSSProperties}>
                <div className="achievement-badge-art">{artwork?.url && artwork.mediaType === 'image' ? <img src={artwork.url} alt={`${badge.khat_type_name} ${badge.tier} badge`} /> : <><Award size={24} /><strong>{khatTypes[script].arabic}</strong></>}</div>
                <div><small>{badge.khat_type_name}</small><h3>{badge.tier} badge</h3><span>Awarded {new Date(badge.awarded_at).toLocaleDateString()}</span></div>
                {artwork?.url && artwork.mediaType === 'pdf' && <a className="text-link" href={artwork.url} target="_blank" rel="noreferrer"><FileText size={14} /> View badge artwork <ExternalLink size={13} /></a>}
              </article>;
            })}</div> : <div className="achievement-empty"><Award size={20} /><div><strong>No badges earned yet</strong><p>Badges appear here as you pass course checkpoints and reach award tiers.</p></div></div>}
          </section>

          <section className="achievement-section">
            <SectionHeading eyebrow="Guild honors" title="Competition awards" text="Awards from competitions with published results." />
            {competitionAwards.length ? <div className="achievement-competition-list">{competitionAwards.map(award => <article className="achievement-competition-card" key={`${award.competition_id}-${award.rank}`}>
              <span className="achievement-medal"><Trophy size={19} /></span><div className="achievement-card-copy"><small>{award.khat_type_name ?? 'Guild competition'}</small><h3>{award.competition_title}</h3><span>Placed #{award.rank} · {new Date(award.awarded_at).toLocaleDateString()}</span></div><StatusChip tone={award.rank === 1 ? 'gold' : 'blue'}>{award.rank === 1 ? 'Winner' : `Rank ${award.rank}`}</StatusChip>{award.imageUrl && <a className="achievement-winning-piece" href={award.imageUrl} target="_blank" rel="noreferrer"><img src={award.imageUrl} alt={`${award.competition_title} award entry`} /><span>View entry</span></a>}
            </article>)}</div> : <div className="achievement-empty"><Trophy size={20} /><div><strong>No competition awards yet</strong><p>Published competition placements will be added to your archive.</p></div></div>}
          </section>
        </>
      )}
    </main>
  );
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

type ApiShowcasePost = { id: string; caption: string | null; status: string; created_at: string; image_storage_key?: string | null; imageStorageKey?: string | null };

export function ShowcaseSubmission() {
  const [posts, setPosts] = useState<ApiShowcasePost[]>([]);
  const [postImageUrls, setPostImageUrls] = useState<Record<string, string>>({});
  const [postsLoading, setPostsLoading] = useState(true);
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const nextPosts = await apiFetch<ApiShowcasePost[]>('/showcase/mine');
      setPosts(nextPosts);
      const imageEntries = await Promise.all(nextPosts.map(async post => {
        const storageKey = post.image_storage_key ?? post.imageStorageKey;
        if (!storageKey) return null;
        try { return [post.id, await getViewUrl(storageKey)] as const; } catch { return null; }
      }));
      setPostImageUrls(Object.fromEntries(imageEntries.filter((entry): entry is readonly [string, string] => Boolean(entry))));
    } catch {
      setPosts([]);
    } finally {
      setPostsLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const submit = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const { storageKey } = await uploadFile('showcase', file);
      await apiFetch('/showcase', { method: 'POST', body: { imageStorageKey: storageKey, caption } });
      setCaption(''); setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="page portal-page showcase-page">
      <SectionHeading eyebrow="Share with the guild" title="Showcase submission" text="Share a finished exercise or a moment from your practice desk." />
      {error && <p className="error-text">{error}</p>}
      <div className="showcase-form">
        <label className="field-label">Caption<textarea className="field textarea" value={caption} onChange={e => setCaption(e.target.value)} placeholder="What did you notice while making this piece?" /></label>
        <UploadBox tall label={file?.name ?? 'Add a photo of your work'} sublabel={file ? 'Photo ready — tap to replace or edit' : "Enters moderation — admin approves before it's public"} icon={FileImage} onChange={setEditingFile} />
        <Button onClick={submit}>{submitting ? <PenLoader label="Submitting showcase post" compact tiny /> : 'Send to moderation'} {!submitting && <ArrowRight size={15} />}</Button>
      </div>
      <SectionHeading title="My showcase submissions" />
      <div className="submission-list">
        {postsLoading ? <PenLoader label="Loading your submissions…" compact /> : posts.length === 0 && <p className="muted">Nothing submitted yet.</p>}
        {posts.map(post => (
          <article className="submission-card" key={post.id}>
            <div className="submission-card-image">{postImageUrls[post.id] ? <img src={postImageUrls[post.id]} alt={post.caption ?? 'Showcase submission'} /> : <FileImage size={25} />}</div>
            <div className="submission-card-content"><div><strong>{post.caption ?? 'Untitled piece'}</strong><small>{new Date(post.created_at).toLocaleDateString()}</small></div><StatusChip tone={post.status === 'approved' ? 'green' : post.status === 'rejected' ? 'red' : 'amber'}>{post.status}</StatusChip></div>
          </article>
        ))}
      </div>
      {editingFile && <ShowcaseImageEditor file={editingFile} onCancel={() => setEditingFile(null)} onSave={editedFile => { setFile(editedFile); setEditingFile(null); }} />}
    </main>
  );
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

export function Competitions() {
  const [active, setActive] = useState<ApiCompetition[]>([]);
  const [past, setPast] = useState<(ApiCompetition & { winners: ApiWinner[] })[]>([]);
  const [files, setFiles] = useState<Record<string, File>>({});
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const winnerImageUrls = useRef<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const list = await apiFetch<ApiCompetition[]>('/competitions');
        const completed = list.filter(c => c.status === 'completed' && c.results_published_at);
        const withWinners = await Promise.all(completed.map(async c => {
          const winners = await apiFetch<ApiWinner[]>(`/competitions/${c.id}/winners`).catch(() => []);
          const resolvedWinners = await Promise.all(winners.map(async winner => {
            const key = winner.image_storage_key;
            if (!key) return winner;
            if (winnerImageUrls.current[key]) return { ...winner, imageUrl: winnerImageUrls.current[key] };
            try {
              const imageUrl = await getViewUrl(key);
              winnerImageUrls.current[key] = imageUrl;
              return { ...winner, imageUrl };
            } catch {
              return winner;
            }
          }));
          return { ...c, winners: resolvedWinners };
        }));
        if (!cancelled) {
          setActive(list.filter(isCompetitionAcceptingEntries));
          setPast(withWinners);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load competitions.');
      } finally {
        inFlight = false;
        if (!cancelled) setLoading(false);
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  const submitEntry = async (competitionId: string) => {
    const file = files[competitionId];
    if (!file) return;
    setError(null);
    try {
      const { storageKey } = await uploadFile('competition-entries', file);
      await apiFetch(`/competitions/${competitionId}/entries`, { method: 'POST', body: { imageStorageKey: storageKey } });
      setSubmitted(prev => ({ ...prev, [competitionId]: true }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit entry.');
    }
  };

  return (
    <main className="page portal-page competitions-page">
      <SectionHeading eyebrow="Guild-wide" title="Competitions" text="Open to every branch. Your entries are never shown on your profile — only to the assigned judge and admin, until results are posted." />
      {error && <p className="error-text">{error}</p>}
      <div className="competition-grid">
        {loading && <p className="muted">Loading competitions…</p>}
        {!loading && !error && active.length === 0 && (
          <div className="competition-empty-state">
            <span className="competition-empty-icon"><Trophy size={17} /></span>
            <div><strong>No open competitions</strong><p>New challenges will appear here when they’re announced.</p></div>
          </div>
        )}
        {active.map(comp => (
          <div className="competition-card" key={comp.id}>
            <div className="competition-card-topline">
              <span className="competition-card-kicker"><Trophy size={14} /> Guild challenge</span>
              <span className="competition-open-label"><i /> Entries open</span>
            </div>
            <div className="competition-card-copy">
              <h3>{comp.title}</h3>
              {comp.description && <p>{comp.description}</p>}
              <div className="competition-deadline"><CalendarDays size={15} /><span>Submit by <strong>{new Date(comp.end_date).toLocaleDateString()}</strong></span></div>
            </div>
            {submitted[comp.id] ? (
              <StatusChip tone="green">Submitted · awaiting judging</StatusChip>
            ) : (
              <>
                <UploadBox label={files[comp.id]?.name ?? 'Upload your entry'} sublabel="Not shown on your profile — visible only to the judge and admin" onChange={file => setFiles(prev => ({ ...prev, [comp.id]: file }))} />
                <Button onClick={() => submitEntry(comp.id)}>Submit entry <ArrowRight size={14} /></Button>
              </>
            )}
          </div>
        ))}
      </div>
      <SectionHeading title="Past competitions" text="Winners, once posted by admin." />
      <div className="winners-list">
        {past.length === 0 && (
          <div className="competition-empty-state competition-empty-past">
            <span className="competition-empty-icon"><Award size={17} /></span>
            <div><strong>No results published yet</strong><p>When results are ready, the winning entries will be gathered here.</p></div>
          </div>
        )}
        {past.flatMap(comp => comp.winners.map(w => (
          <div className="winner-row" key={`${comp.id}-${w.rank}`}>
            <span className="winner-medal"><Trophy size={19} /></span>
            <div className="winner-copy"><strong>{comp.title}</strong><small><span>{w.student_name}</span><i>·</i> Rank {w.rank}</small></div>
            {w.imageUrl ? (
              <a className="winner-piece" href={w.imageUrl} target="_blank" rel="noreferrer" aria-label={`View ${w.student_name}'s winning entry`}>
                <img src={w.imageUrl} alt={`${w.student_name}'s winning calligraphy entry`} loading="lazy" />
                <span>View winning piece <ExternalLink size={13} /></span>
              </a>
            ) : (
              <div className="winner-piece winner-piece-unavailable"><FileImage size={20} /><span>Winning entry preview unavailable</span></div>
            )}
            <StatusChip tone="gold"><Award size={13} /> Winner</StatusChip>
          </div>
        )))}
      </div>
    </main>
  );
}

export function StudentEvents() {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [player, setPlayer] = useState<{ title: string; videoUrl?: string; room?: LiveKitRoomAccess } | null>(null);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void apiFetch<ApiEvent[]>('/events')
        .then(data => { if (mounted) setEvents(data); })
        .catch(err => { if (mounted) setError(err instanceof ApiError ? err.message : 'Could not refresh live events.'); });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);

  const upcoming = events.filter(e => e.status === 'scheduled' || e.status === 'live');
  const past = events.filter(e => e.status === 'ended');

  const join = async (ev: ApiEvent) => {
    try {
      const room = await apiFetch<LiveKitRoomAccess>(`/events/${ev.id}/join`, { method: 'POST' });
      setPlayer({ title: ev.title, room });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join.');
    }
  };

  const watchRecording = async (ev: ApiEvent) => {
    await apiFetch(`/events/${ev.id}/watched-recording`, { method: 'POST' }).catch(() => {});
    if (ev.recording_storage_key) {
      try {
        setPlayer({ title: ev.title, videoUrl: await getViewUrl(ev.recording_storage_key) });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the recording.');
      }
    }
  };

  return (
    <main className="page portal-page events-page">
      <SectionHeading eyebrow="Gather around the page" title="Live events" text="Join a study circle, watch a demonstration, or revisit a recording." />
      {error && <p className="error-text">{error}</p>}
      <div className="event-list">
        {upcoming.length === 0 && <div className="events-empty-state"><span className="events-empty-icon"><CalendarDays size={18} /></span><div><strong>No upcoming events</strong><p>New study circles and demonstrations will appear here when they are scheduled.</p></div></div>}
        {upcoming.map(ev => (
          <div className="event-row" key={ev.id}>
            <div className="event-date"><span>{new Date(ev.scheduled_at).getDate()}</span><small>{new Date(ev.scheduled_at).toLocaleString('en', { month: 'short' }).toUpperCase()}</small></div>
            <div><strong>{ev.title}</strong><span>{ev.host_name} · {ev.branch_name}</span></div>
            <StatusChip tone={ev.status === 'live' ? 'green' : 'gold'}>{ev.status === 'live' ? 'Live now' : 'Upcoming'}</StatusChip>
            {ev.status === 'live' ? (
              <Button outline onClick={() => join(ev)}>Join now</Button>
            ) : (
              <small className="muted">Not live yet</small>
            )}
          </div>
        ))}
      </div>
      <SectionHeading title="Past recordings" />
      <div className="recordings">
        {past.length === 0 && <div className="events-empty-state"><span className="events-empty-icon"><Play size={18} /></span><div><strong>No recordings yet</strong><p>Completed events with available recordings will be collected here.</p></div></div>}
        {past.map(ev => (
          <article className="recording-card" key={ev.id}>
            <div className="recording-art"><Play size={20} /></div>
            <div className="recording-copy"><strong>{ev.title}</strong><small>{ev.branch_name} · {new Date(ev.scheduled_at).toLocaleDateString()}</small></div>
            {ev.recording_status === 'processing' ? (
              <small className="muted">Preparing the recording…</small>
            ) : ev.recording_storage_key ? (
              <button className="text-link" onClick={() => watchRecording(ev)}>Watch recording <ArrowRight size={14} /></button>
            ) : (
              <small className="muted">No recording uploaded yet</small>
            )}
          </article>
        ))}
      </div>
      {player && (
        <Modal onClose={() => setPlayer(null)}>
          <p className="eyebrow">{player.room ? 'Live event · in-site' : 'Event recording'}</p>
          <h2>{player.title}</h2>
          {player.room ? (
            <Suspense fallback={<div className="live-video-waiting">Joining the live room…</div>}>
              <LiveKitEventRoom
                access={player.room}
                publishMedia={false}
                onDisconnected={() => setPlayer(null)}
                onError={err => setError(err.message || 'Could not connect to the live event.')}
              />
            </Suspense>
          ) : (
            <div className="live-video-frame">
              <video src={player.videoUrl} controls autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </div>
          )}
        </Modal>
      )}
    </main>
  );
}

type ApiBook = { id: string; title: string; khat_type_id: string | null; file_storage_key: string; original_filename?: string | null };

export function Resources() {
  const [filter, setFilter] = useState<Script | 'All'>('All');
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [booksList, setBooksList] = useState<ApiBook[]>([]);
  const [viewerBook, setViewerBook] = useState<ApiBook | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);

  useEffect(() => { apiFetch<ApiKhatType[]>('/khat-types').then(setKhatTypesList).catch(() => {}); }, []);

  useEffect(() => {
    const params = new URLSearchParams();
    if (filter !== 'All') { const kt = khatTypesList.find(k => k.code === scriptCode(filter)); if (kt) params.set('khatTypeId', kt.id); }
    apiFetch<ApiBook[]>(`/books?${params.toString()}`).then(setBooksList).catch(() => {});
  }, [filter, khatTypesList]);

  useEffect(() => () => {
    if (viewerUrl?.startsWith('blob:')) URL.revokeObjectURL(viewerUrl);
  }, [viewerUrl]);

  const download = async (book: ApiBook) => {
    const url = await getDownloadUrl(book.file_storage_key, book.original_filename ?? `${book.title}.pdf`);
    const link = document.createElement('a');
    link.href = url;
    link.download = book.title.replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.click();
  };

  const viewBook = async (book: ApiBook) => {
    setViewerBook(book);
    setViewerUrl(null);
    setViewerError(null);
    setViewerLoading(true);
    try {
      setViewerUrl(await getFileObjectUrl(book.file_storage_key));
    } catch (err) {
      setViewerError(err instanceof ApiError ? err.message : 'Could not load this resource.');
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
      <SectionHeading eyebrow="The library" title="Resource library" text="Books, references, and quiet companions for your desk." />
      <div className="tabs small">
        <button className={filter === 'All' ? 'active' : ''} onClick={() => setFilter('All')}>All</button>
        {scriptList.map(s => <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>{khatTypes[s].name}</button>)}
      </div>
      <div className="resource-grid">
        {booksList.length === 0 && <div className="resources-empty-state"><span className="resources-empty-icon"><BookOpen size={20} /></span><div><span className="eyebrow">A quiet shelf</span><h3>No resources yet</h3><p>Books, practice sheets, and references for this library will appear here as they are added.</p></div><span className="resources-empty-flourish" aria-hidden="true">✦</span></div>}
        {booksList.map(book => {
          const kt = khatTypesList.find(k => k.id === book.khat_type_id);
          const script = kt ? scriptFromCode(kt.code) : null;
          return (
            <div className="resource-card" key={book.id}>
              <div className="resource-book-cover-frame"><Suspense fallback={<div className="book-cover resource-book-cover"><span className="resource-cover-placeholder"><BookOpen size={25} /><span>{book.title}</span></span></div>}><ResourceBookCover book={book} /></Suspense>{script && <span className="resource-book-script-tag">{khatTypes[script].name}</span>}</div>
              <strong>{book.title}</strong>
              <div className="resource-card-actions"><button className="resource-view-button" onClick={() => void viewBook(book)}><BookOpen size={14} /> View</button><button className="text-link" onClick={() => void download(book)}>Download <ArrowRight size={14} /></button></div>
            </div>
          );
        })}
      </div>
      {viewerBook && <div className="resource-reader-layer" onMouseDown={event => { if (event.target === event.currentTarget) closeViewer(); }}>
        {viewerLoading ? <div className="resource-reader-message resource-reader-loading-page"><span className="resource-reader-spinner" /><strong>Opening resource</strong><small>Preparing your reader…</small></div> : viewerError ? <div className="resource-reader-error-panel"><button type="button" onClick={closeViewer} aria-label="Close viewer"><X size={18} /></button><FileText size={28} /><strong>Could not open resource</strong><p>{viewerError}</p></div> : viewerUrl && <Suspense fallback={<div className="resource-reader-message resource-reader-loading-page"><span className="resource-reader-spinner" /><strong>Preparing reader</strong><small>Loading the page viewer…</small></div>}><ResourcePdfViewer book={viewerBook} url={viewerUrl} onClose={closeViewer} /></Suspense>}
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
