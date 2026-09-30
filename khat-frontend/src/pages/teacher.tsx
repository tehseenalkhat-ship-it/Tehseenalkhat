import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowRight, Award, CalendarDays, Check, ChevronRight, ClipboardList, Clock,
  FileImage, FileText, Inbox, Lock, Search, ShieldCheck, Trophy,
  RefreshCw, Upload, Users, Zap, Eye, MapPin, PenTool, Mic, Pause, Play, Trash2,
  StopCircle,
  Radio,
  ExternalLink,
} from 'lucide-react';
import type { Script } from '@/data/types';
import { khatTypes, scriptList, scriptToCode, scriptFromCode as mapScriptFromCode } from '@/data/mock';
import {
  navigate, Button, SectionHeading, StatusChip, StatCard, ActivityHeatmap, AlertsPage,
  UploadBox, BackLink, DashboardShowcaseCarousels, ShowcasePostCard, ShowcaseHeading, BadgeIcon, PenLoader, Modal,
} from '@/components/ui';
import { apiFetch, uploadFile, getSessionUser, ApiError, getViewUrl, getDownloadUrl } from '@/api';
import { openEntry, useActiveEntryId } from '@/entrySession';
import { viewStudentProfile, useActiveStudentId } from '@/studentViewSession';
import { viewTeacherProfile, useViewedTeacherId, clearViewedTeacher } from '@/teacherViewSession';
import { ShowcaseImageEditor } from '@/components/ShowcaseImageEditor';
import { SubmissionAnnotator } from '@/components/SubmissionAnnotator';
import type { LiveKitRoomAccess } from '@/components/LiveKitEventRoom';
import {
  ActivityTrendChart, EntryStatusChart, EntryTrendChart, EventTrendChart, StudentProgressChart, TeacherThroughputChart,
  type BranchActivityPoint, type BranchEntryPoint, type BranchEventPoint, type BranchProgress, type BranchStatus, type BranchTeacher,
} from '@/components/BranchAnalyticsCharts';

const LiveKitEventRoom = lazy(() => import('@/components/LiveKitEventRoom').then(module => ({ default: module.LiveKitEventRoom })));

type ApiQueueRow = {
  id: string; source_type: string; status: string; created_at: string; locked_at: string | null;
  level_title: string | null; khat_type_id: string | null; khat_type_code?: string | null; khat_type_name?: string | null;
  student_name: string; student_branch_id: string;
};
type ApiKhatType = { id: string; code: string; display_name: string };
type ApiBranch = {
  branch_id: string; id: string; name: string 
};
type ApiAssignedScript = { id: string; code: string; display_name: string };

type ApiActivity = {
  activity_date: string;
  login_count: number;
};

type ApiShowcasePost = {
  id: string;
  user_role: string;
  image_storage_key: string;
  imageUrl?: string;
  caption: string | null;
  author_name?: string;
  branch_name?: string | null;
  branch?: string | null;
  like_count: string | number;
  liked_by_me: boolean;
  created_at: string;
  status?: string;
};

function scriptFromCode(code?: string | null): Script | null {
  if (!code) return null;
  return mapScriptFromCode(code.toLowerCase());
}

// A rough, client-side estimate for the queue's "time remaining" display —
// the real 2-day diversion window lives in site_settings on the backend and
// isn't fetched here, so this assumes the default. Good enough for display;
// the backend's own sweep is the actual source of truth for diversion timing.
function hoursRemaining(createdAt: string): number {
  const elapsedHours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  return Math.max(0, Math.round(48 - elapsedHours));
}

type VoiceRecorderSession = {
  context: AudioContext;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  mutedOutput: GainNode;
  chunks: Float32Array[];
  stopped: boolean;
  paused: boolean;
};

function makeWavFile(chunks: Float32Array[], sampleRate: number): { file: File; durationSeconds: number } {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  if (!samples) throw new Error('No audio was captured. Check your microphone permission and try again.');
  const bytesPerSample = 2;
  const dataSize = samples * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return {
    file: new File([wav], 'teacher-feedback.wav', { type: 'audio/wav', lastModified: Date.now() }),
    durationSeconds: samples / sampleRate,
  };
}

// TODO: still used by TeacherProfile/BranchStats/BranchTeachers, which are
// not wired to the real backend yet — remove once those are done too.
// const currentTeacher = teachers[0];

export function TeacherDashboard({ coordinator = false }: { coordinator?: boolean }) {
  const [queue, setQueue] = useState<ApiQueueRow[]>([]);
  const [assignedScripts, setAssignedScripts] = useState<ApiAssignedScript[]>([]);
  const [stats, setStats] = useState<{ totalReviewed: number; avgResponseHours: number | null } | null>(null);
  const user = getSessionUser();
  const userId = user?.id;
  const userBranchId = user?.branchId;
  const [activity, setActivity] = useState<ApiActivity[]>([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [queueLoading, setQueueLoading] = useState(true);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [coordinatorData, setCoordinatorData] = useState<{
    branchName: string;
    studentCount: number;
    eventCount: number;
    teachers: { id: string; name: string; entriesReviewed: number }[];
  } | null>(null);
  const [coordinatorLoading, setCoordinatorLoading] = useState(coordinator);
  const [coordinatorError, setCoordinatorError] = useState<string | null>(null);

  const [showcasePosts, setShowcasePosts] = useState<ApiShowcasePost[]>([]);
  const [showcaseLoading, setShowcaseLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
  
    apiFetch<ApiQueueRow[]>('/entries/queue')
      .then(setQueue)
      .catch(err => setDashboardError(err instanceof ApiError ? err.message : 'Could not load your review queue.'))
      .finally(() => setQueueLoading(false));
  
    apiFetch<{
      assignedScripts: ApiAssignedScript[];
      totalReviewed: number;
      avgResponseHours: number | null;
      activity: ApiActivity[];
    }>(`/teachers/${userId}/profile`)
      .then(profile => {
        setAssignedScripts(profile.assignedScripts);
        setStats(profile);
        setActivity(profile.activity);
        setActivityLoading(false);
      })
      .catch(() => {
        setDashboardError('Could not load your teaching activity.');
        setActivityLoading(false);
      });
  
    apiFetch<ApiShowcasePost[]>('/showcase')
      .then(async posts => {
        const resolvedPosts = await Promise.all(
          posts.map(async post => {
            if (!post.image_storage_key) return post;
  
            try {
              const imageUrl = await getViewUrl(post.image_storage_key);
              return { ...post, imageUrl };
            } catch (err) {
              console.error(
                'Failed to resolve showcase image URL:',
                post.id,
                err
              );
              return post;
            }
          })
        );
  
        setShowcasePosts(resolvedPosts);
      })
      .catch(err => setDashboardError(err instanceof ApiError ? err.message : 'Could not load the gallery.'))
      .finally(() => {
        setShowcaseLoading(false);
      });

    if (coordinator) {
      setCoordinatorLoading(true);
      setCoordinatorError(null);
      Promise.all([
        apiFetch<ApiBranch[]>('/branches'),
        apiFetch<ApiStudentRow[]>('/students'),
        apiFetch<ApiStaffRow[]>('/admin/users?role=teacher'),
        apiFetch<ApiLiveEvent[]>('/events'),
      ]).then(async ([branches, students, staff, events]) => {
        const branch = branches.find(item => item.id === userBranchId);
        if (!branch) throw new Error('Your appointed branch could not be found.');

        const teachers = await Promise.all(staff.map(async teacher => {
          const profile = await apiFetch<{ totalReviewed: number }>(`/teachers/${teacher.id}/profile`).catch(() => ({ totalReviewed: 0 }));
          return { id: teacher.id, name: teacher.name, entriesReviewed: profile.totalReviewed };
        }));

        setCoordinatorData({
          branchName: branch.name,
          studentCount: students.length,
          eventCount: events.filter(event => event.branch_id === userBranchId).length,
          teachers,
        });
      }).catch(err => {
        setCoordinatorError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not load branch information.');
      }).finally(() => setCoordinatorLoading(false));
    }
  }, [userId, userBranchId, coordinator]);

  const maxBranchReviewed = Math.max(1, ...(coordinatorData?.teachers.map(teacher => teacher.entriesReviewed) ?? []));

  const toggleShowcaseLike = async (id: string, liked: boolean) => {
    try {
      await apiFetch(`/showcase/${id}/like`, { method: liked ? 'DELETE' : 'POST' });
      const refreshed = await apiFetch<ApiShowcasePost[]>('/showcase');
      const resolved = await Promise.all(refreshed.map(async item => {
        if (!item.image_storage_key) return item;
        try {
          return { ...item, imageUrl: await getViewUrl(item.image_storage_key) };
        } catch {
          return item;
        }
      }));
      setShowcasePosts(resolved);
    } catch {
      // Ignore like failures for now.
    }
  };

  return (
    <main className="page portal-page">
      <div className="portal-welcome">
        <div>
          <p className="eyebrow">{coordinator ? `Branch coordinator${coordinatorData?.branchName ? ` · ${coordinatorData.branchName}` : ''}` : 'Faculty workspace'}</p>
          <h1>Good morning, {user?.name.split(' ')[0] ?? 'there'}.</h1>
          <p>{coordinator ? 'Your teaching desk and branch overview are ready. Review student work and support your local guild.' : 'Your teaching desk is ready. Review work, follow your students, and keep the hand moving.'}</p>
          {coordinator && coordinatorData?.branchName && <span className="coordinator-branch-badge"><MapPin size={14} /> Appointed branch <strong>{coordinatorData.branchName}</strong></span>}
        </div>
        <div className="queue-count"><strong>{queueLoading ? '—' : queue.length}</strong><span>entries to review</span></div>
      </div>
      {dashboardError && <p className="error-text" role="alert">{dashboardError}</p>}
      <div className="stats-grid">
        <StatCard icon={ClipboardList} value={String(stats?.totalReviewed ?? '—')} label="Total reviewed" />
        <StatCard icon={Zap} value={stats?.avgResponseHours != null ? `${Math.round(stats.avgResponseHours)} hrs` : '—'} label="Average response" />
      </div>
      {coordinator && (
        <section className="coordinator-overview">
          <div className="coordinator-overview-heading">
            <div><p className="eyebrow">Your branch at a glance</p><h2>{coordinatorLoading ? 'Loading branch overview…' : coordinatorData?.branchName ?? 'Branch overview'}</h2></div>
            <button className="text-link" onClick={() => navigate('branch-stats')}>Open branch statistics <ArrowRight size={14} /></button>
          </div>
          {coordinatorError && <p className="error-text" role="alert">{coordinatorError}</p>}
          <div className="coordinator-metric-grid">
            <button className="coordinator-metric" onClick={() => navigate('branch-students')}><span className="coordinator-metric-icon"><Users size={17} /></span><strong>{coordinatorLoading || !coordinatorData ? '—' : coordinatorData.studentCount}</strong><small>Students in branch</small><span className="coordinator-metric-link">View students <ArrowRight size={13} /></span></button>
            <button className="coordinator-metric" onClick={() => navigate('branch-teachers')}><span className="coordinator-metric-icon"><ClipboardList size={17} /></span><strong>{coordinatorLoading || !coordinatorData ? '—' : coordinatorData.teachers.length}</strong><small>Teachers in branch</small><span className="coordinator-metric-link">View teachers <ArrowRight size={13} /></span></button>
            <button className="coordinator-metric" onClick={() => navigate('events-host')}><span className="coordinator-metric-icon"><CalendarDays size={17} /></span><strong>{coordinatorLoading || !coordinatorData ? '—' : coordinatorData.eventCount}</strong><small>Branch events</small><span className="coordinator-metric-link">Manage events <ArrowRight size={13} /></span></button>
          </div>
          {!coordinatorLoading && coordinatorData && (
            <div className="coordinator-teacher-throughput">
              <div><strong>Teacher review throughput</strong><small>Reviewed entries by teachers in {coordinatorData.branchName}</small></div>
              {coordinatorData.teachers.length === 0 ? <p className="muted">No teachers are currently assigned to this branch.</p> : (
                <div className="coordinator-throughput-list">
                  {coordinatorData.teachers.map(teacher => <div className="coordinator-throughput-row" key={teacher.id}><span>{teacher.name}</span><i><b style={{ width: `${(teacher.entriesReviewed / maxBranchReviewed) * 100}%` }} /></i><strong>{teacher.entriesReviewed}</strong></div>)}
                </div>
              )}
            </div>
          )}
          <div className="coordinator-quick-links">
            <button onClick={() => navigate('branch-stats')}><span><CalendarDays size={16} /></span><div><strong>Branch statistics</strong><small>Review activity and branch throughput</small></div><ChevronRight size={16} /></button>
            <button onClick={() => navigate('branch-teachers')}><span><Users size={16} /></span><div><strong>Teacher overview</strong><small>See assigned scripts and review totals</small></div><ChevronRight size={16} /></button>
            <button onClick={() => navigate('branch-students')}><span><Users size={16} /></span><div><strong>Student directory</strong><small>Open your branch student roster</small></div><ChevronRight size={16} /></button>
          </div>
        </section>
      )}
      {assignedScripts.length > 0 && (
        <div className="info-banner"><Check size={16} /><span>You are assigned to review: {assignedScripts.map(s => s.display_name).join(', ')}. You will only see entries matching these scripts in your queue.</span></div>
      )}
      <div className="admin-dashboard-grid">
        <div className="chart-card">
          <SectionHeading title="Today's queue" text="The entries closest to their response deadline — filtered to your assigned scripts." action={<button className="text-link" onClick={() => navigate('queue')}>Open queue <ArrowRight size={14} /></button>} />
          {queueLoading ? <PenLoader label="Loading your review queue…" compact /> : queue.slice(0, 3).map(row => (
            <div className="dashboard-list-row" key={row.id}>
              <div><strong>{row.student_name}</strong><small>{row.level_title ?? row.source_type}</small></div>
              <StatusChip tone="amber">{hoursRemaining(row.created_at)} hrs left</StatusChip>
            </div>
          ))}
          {!queueLoading && queue.length === 0 && (
            <div className="dashboard-queue-empty">
              <span><Inbox size={16} /></span>
              <div><strong>Queue is clear</strong><small>New entries will appear here when they’re assigned.</small></div>
            </div>
          )}
        </div>
        <div className="chart-card">
          <SectionHeading
            title="Your teaching rhythm"
            text="Login activity over recent weeks."
          />
          {activityLoading ? (
            <PenLoader label="Loading activity…" compact />
          ) : (
            <ActivityHeatmap activity={activity} />
          )}
        </div>
      </div>
      <section className="showcase-section">
        <ShowcaseHeading
          title="Gallery"
          text="Practice shared across every branch."
        />
      
        {showcaseLoading ? (
          <PenLoader label="Loading gallery…" compact />
        ) : showcasePosts.length === 0 ? (
          <p className="muted">Nothing shared yet.</p>
        ) : (
          <DashboardShowcaseCarousels
            posts={showcasePosts.map(post => ({
              id: post.id,
              role: post.user_role,
              imageUrl: post.imageUrl,
              caption: post.caption,
              authorName: post.author_name,
              branch: post.branch_name ?? post.branch,
              likes: Number(post.like_count),
              liked: post.liked_by_me,
            }))}
            onLike={toggleShowcaseLike}
          />
        )}
      </section>
    </main>
  );
}

export function CoordinatorDashboard() {
  return <TeacherDashboard coordinator />;
}

export function TeacherQueue({ coordinator = false }: { coordinator?: boolean }) {
  const [filter, setFilter] = useState<Script | 'All'>('All');
  const [rows, setRows] = useState<ApiQueueRow[]>([]);
  const [assignedScripts, setAssignedScripts] = useState<ApiAssignedScript[]>([]);
  const [branchMap, setBranchMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = getSessionUser();

  const load = async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const [queue, profile, branchList] = await Promise.all([
        apiFetch<ApiQueueRow[]>('/entries/queue'),
        apiFetch<{ assignedScripts: ApiAssignedScript[] }>(`/teachers/${user.id}/profile`),
        apiFetch<ApiBranch[]>('/branches'),
      ]);
      setRows(queue);
      setAssignedScripts(profile.assignedScripts);
      setBranchMap(Object.fromEntries(branchList.map(b => [b.id, b.name])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load your queue.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [user?.id]);

  const filtered = filter === 'All' ? rows : rows.filter(row => {
    const assignedCode = assignedScripts.find(item => item.id === row.khat_type_id)?.code;
    return scriptFromCode(row.khat_type_code ?? assignedCode) === filter;
  });

  const openRow = async (row: ApiQueueRow) => {
    if (row.status === 'assigned') {
      try {
        await apiFetch(`/entries/${row.id}/open`, { method: 'POST' });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not open this entry.');
        return;
      }
    }
    openEntry(row.id);
    navigate('review');
  };

  return (
    <main className="page portal-page">
      <div className="portal-welcome">
        <div>
          <p className="eyebrow">Teacher portal {coordinator && '· Branch coordinator'}</p>
          <h1>Review Queue</h1>
          <p>Submissions assigned to you, ordered by how soon they're due. Only entries matching your assigned khat type(s) appear here.</p>
        </div>
        <div className="queue-count"><strong>{filtered.length}</strong><span>awaiting review</span></div>
      </div>
      {error && <p className="error-text">{error}</p>}
      {!coordinator && assignedScripts.length > 0 && (
        <div className="info-banner"><Check size={16} /><span>Your assigned scripts: {assignedScripts.map(s => s.display_name).join(', ')}. Entries from other scripts are routed to their assigned teachers.</span></div>
      )}
      <div className="tabs">
        <button className={filter === 'All' ? 'active' : ''} onClick={() => setFilter('All')}>All</button>
        {assignedScripts.map(s => {
          const assignedScript = scriptFromCode(s.code);
          if (!assignedScript) return null;
          return <button key={s.id} className={filter === assignedScript ? 'active' : ''} onClick={() => setFilter(assignedScript)}>{s.display_name}</button>;
        })}
      </div>
      {loading ? (
        <PenLoader label="Loading review queue…" compact />
      ) : filtered.length === 0 ? (
        <div className="queue-empty-state">
          <div className="queue-empty-icon"><Inbox size={24} strokeWidth={1.7} /></div>
          <p className="eyebrow">Review queue</p>
          <h3>{filter === 'All' ? 'You’re all caught up' : `No ${filter} entries right now`}</h3>
          <p>{filter === 'All' ? 'There are no entries waiting for review. New student work will appear here as it arrives.' : `There are no entries matching ${filter} in your current queue. Try another script or check back later.`}</p>
          {filter !== 'All' && <button className="text-link" onClick={() => setFilter('All')}>View all assigned scripts <ArrowRight size={14} /></button>}
        </div>
      ) : (
        <div className="entry-table">
          <div className="table-head">
            <span>Student</span><span>Script</span><span>Level / exercise</span><span>Branch</span><span>Time remaining</span><span />
          </div>
          {filtered.map((row) => {
            const script = assignedScripts.find(s => s.id === row.khat_type_id);
            const scriptName = row.khat_type_name ?? script?.display_name ?? 'Unknown script';
            const scriptType = scriptFromCode(row.khat_type_code ?? script?.code);
            const hrs = hoursRemaining(row.created_at);
            return (
              <div className="entry-row" key={row.id}>
                <div><strong>{row.student_name}</strong><small>Submitted {new Date(row.created_at).toLocaleDateString()} · {row.source_type}</small></div>
                <span style={{ color: scriptType ? khatTypes[scriptType].color : undefined }}>{scriptName}</span>
                <span>{row.level_title ?? '—'}</span>
                <span>{branchMap[row.student_branch_id] ?? '—'}</span>
                {row.status === 'in_review' ? (
                  <StatusChip tone="blue"><Lock size={13} /> In review</StatusChip>
                ) : (
                  <StatusChip tone={hrs < 12 ? 'red' : hrs < 24 ? 'amber' : 'green'}>{hrs} hrs left</StatusChip>
                )}
                <Button onClick={() => openRow(row)}>{row.status === 'in_review' ? 'Continue review' : 'Open'} <ArrowRight size={14} /></Button>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}

type ApiEntryDetail = {
  id: string; student_id: string; status: string; khat_image_storage_key: string; original_filename?: string | null;
  scopedSubmissions: { id: string; file_storage_key: string; original_filename?: string | null; time_spent_minutes: number; submitted_at: string }[];
};

export function ReviewPage() {
  const entryId = useActiveEntryId();
  const [entry, setEntry] = useState<ApiEntryDetail | null>(null);
  const [submissionImageUrl, setSubmissionImageUrl] = useState<string | null>(null);
  const [submissionDownloadUrl, setSubmissionDownloadUrl] = useState<string | null>(null);
  const [practiceImageUrls, setPracticeImageUrls] = useState<Record<string, string>>({});
  const [studentName, setStudentName] = useState('');
  const [feedback, setFeedback] = useState('');
  const [correctionFile, setCorrectionFile] = useState<File | null>(null);
  const [voiceNoteFile, setVoiceNoteFile] = useState<File | null>(null);
  const [voiceNoteUrl, setVoiceNoteUrl] = useState<string | null>(null);
  const voiceAudioRef = useRef<HTMLAudioElement>(null);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voicePlaybackSeconds, setVoicePlaybackSeconds] = useState(0);
  const [voiceRecorder, setVoiceRecorder] = useState<VoiceRecorderSession | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [voiceNoteDuration, setVoiceNoteDuration] = useState(0);
  const recordingStartedAt = useRef<number | null>(null);
  const [uploadedCorrectionKey, setUploadedCorrectionKey] = useState<string | null>(null);
  const [uploadedCorrectionName, setUploadedCorrectionName] = useState<string | null>(null);
  const [showAnnotator, setShowAnnotator] = useState(false);
  const [decision, setDecision] = useState<'pass' | 'redo' | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewSidebarOpen, setReviewSidebarOpen] = useState(false);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => setRecordingSeconds(seconds => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (!voiceNoteFile) { setVoiceNoteUrl(null); return; }
    const url = URL.createObjectURL(voiceNoteFile);
    setVoiceNoteUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [voiceNoteFile]);

  useEffect(() => {
    setVoicePlaying(false);
    setVoicePlaybackSeconds(0);
    voiceAudioRef.current?.load();
  }, [voiceNoteUrl]);

  useEffect(() => () => {
    if (!voiceRecorder || voiceRecorder.stopped) return;
    voiceRecorder.stopped = true;
    voiceRecorder.processor.disconnect();
    voiceRecorder.source.disconnect();
    voiceRecorder.mutedOutput.disconnect();
    voiceRecorder.stream.getTracks().forEach(track => track.stop());
    void voiceRecorder.context.close();
  }, [voiceRecorder]);

  useEffect(() => {
    if (!entryId) return;
    apiFetch<ApiEntryDetail & { student_name?: string }>(`/entries/${entryId}`)
      .then(async data => {
        setEntry(data);
        setStudentName(data.student_name ?? '');
        const [submissionUrl, downloadUrl, practiceImages] = await Promise.all([
          data.khat_image_storage_key ? getViewUrl(data.khat_image_storage_key).catch(() => null) : Promise.resolve(null),
          data.khat_image_storage_key ? getDownloadUrl(data.khat_image_storage_key, data.original_filename ?? `checkpoint-submission-${data.id}`).catch(() => null) : Promise.resolve(null),
          Promise.all(data.scopedSubmissions.map(async submission => {
            try { return [submission.id, await getViewUrl(submission.file_storage_key)] as const; }
            catch { return [submission.id, ''] as const; }
          })),
        ]);
        setSubmissionImageUrl(submissionUrl);
        setSubmissionDownloadUrl(downloadUrl);
        setPracticeImageUrls(Object.fromEntries(practiceImages.filter(([, url]) => url)));
      })
      .catch(err => setError(err instanceof ApiError ? err.message : 'Failed to load this entry.'));
  }, [entryId]);

  const submitDecision = async (choice: 'pass' | 'redo') => {
    if (!entry) return;
    setSubmitting(true);
    setError(null);
    try {
      let correctionImageStorageKey: string | undefined = uploadedCorrectionKey ?? undefined;
      let correctionVoiceStorageKey: string | undefined;
      if (correctionFile) {
        const uploaded = await uploadFile('corrections', correctionFile);
        correctionImageStorageKey = uploaded.storageKey;
      }
      if (voiceNoteFile) {
        const uploaded = await uploadFile('corrections', voiceNoteFile);
        correctionVoiceStorageKey = uploaded.storageKey;
      }
        await apiFetch(`/entries/${entry.id}/review`, {
        method: 'POST',
        body: { decision: choice, feedback, correctionImageStorageKey, correctionVoiceStorageKey },
      });
      setDecision(choice);
      // Close mobile sidebar after submitting decision for a smoother mobile flow
      setReviewSidebarOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit your decision.');
    } finally {
      setSubmitting(false);
    }
  };

  const startVoiceRecording = async () => {
    setRecordingError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof window.AudioContext === 'undefined') {
      setRecordingError('Voice recording is not supported by this browser.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const mutedOutput = context.createGain();
      const session: VoiceRecorderSession = { context, stream, source, processor, mutedOutput, chunks: [], stopped: false, paused: false };
      processor.onaudioprocess = event => {
        if (!session.stopped && !session.paused) session.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      mutedOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(mutedOutput);
      mutedOutput.connect(context.destination);
      setRecordingSeconds(0);
      setVoiceNoteDuration(0);
      setVoiceNoteFile(null);
      setVoiceRecorder(session);
      recordingStartedAt.current = Date.now();
      setRecording(true);
    } catch (err) {
      setRecordingError(err instanceof Error && err.name === 'NotAllowedError'
        ? 'Microphone permission was denied. Allow microphone access to record feedback.'
        : 'Could not access the microphone. Check your device permissions and try again.');
      setRecording(false);
    }
  };

  const stopVoiceRecording = () => {
    const session = voiceRecorder;
    if (!session || session.stopped) return;
    session.stopped = true;
    session.processor.onaudioprocess = null;
    session.processor.disconnect();
    session.source.disconnect();
    session.mutedOutput.disconnect();
    session.stream.getTracks().forEach(track => track.stop());
    const startedAt = recordingStartedAt.current;
    recordingStartedAt.current = null;
    try {
      const result = makeWavFile(session.chunks, session.context.sampleRate);
      setVoiceNoteFile(result.file);
      setVoiceNoteDuration(result.durationSeconds);
    } catch (err) {
      setVoiceNoteFile(null);
      setVoiceNoteDuration(0);
      setRecordingError(err instanceof Error ? err.message : 'Could not prepare the voice note.');
    }
    setRecordingSeconds(startedAt === null ? 0 : Math.round((Date.now() - startedAt) / 1000));
    setRecording(false);
    setRecordingPaused(false);
    setVoiceRecorder(null);
    void session.context.close();
  };

  const cancelVoiceRecording = () => {
    const session = voiceRecorder;
    if (session && !session.stopped) {
      session.stopped = true;
      session.processor.onaudioprocess = null;
      session.processor.disconnect();
      session.source.disconnect();
      session.mutedOutput.disconnect();
      session.stream.getTracks().forEach(track => track.stop());
      void session.context.close();
    }
    recordingStartedAt.current = null;
    setVoiceRecorder(null);
    setRecording(false);
    setRecordingPaused(false);
    setRecordingSeconds(0);
    setVoiceNoteFile(null);
    setVoiceNoteDuration(0);
    setRecordingError(null);
  };

  const toggleRecordingPause = () => {
    if (!voiceRecorder || voiceRecorder.stopped) return;
    voiceRecorder.paused = !voiceRecorder.paused;
    setRecordingPaused(voiceRecorder.paused);
  };

  const toggleVoicePlayback = () => {
    const audio = voiceAudioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play().then(() => setVoicePlaying(true)).catch(() => setRecordingError('Could not play this voice note. Please record it again.'));
    else { audio.pause(); setVoicePlaying(false); }
  };

  const seekVoicePlayback = (value: number) => {
    const audio = voiceAudioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = (value / 100) * audio.duration;
    setVoicePlaybackSeconds(audio.currentTime);
  };

  const formatRecordingTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  if (!entryId || !entry) {
    return (
      <main className="page portal-page review-page">
        <BackLink to="queue" label="Back to Review Queue" />
        {error ? <p className="error-text">{error}</p> : <PenLoader label="Loading review…" />}
      </main>
    );
  }

  return (
    <main className="page portal-page review-page">
      <BackLink to="queue" label="Back to Review Queue" />
      <div className="review-context">
        <div>
          <p className="eyebrow">Checkpoint review</p>
          <h1>{studentName || 'Student'}</h1>
          <p className="review-context-note">Review the submitted checkpoint and course-specific practice uploads below.</p>
        </div>
        <StatusChip tone="blue"><Lock size={13} /> Locked by you — won't be reassigned while open</StatusChip>
      </div>
      <div className="info-banner"><Eye size={16} /><span>Only practice uploads from this student's course and the levels covered by this checkpoint are shown here. Other course uploads and profile/activity information are not included.</span></div>
      {error && <p className="error-text">{error}</p>}
      <div className="review-grid">
        <div>
          <div className="sheet-preview review-submission-preview">
            {submissionImageUrl ? <img src={submissionImageUrl} alt={`${studentName || 'Student'} checkpoint submission`} /> : <div className="review-image-unavailable"><FileImage size={30} /><span>Submission image unavailable</span></div>}
          </div>
          {submissionDownloadUrl && <a
            className="text-link print-link"
            href={submissionDownloadUrl}
            download={entry.original_filename ?? `checkpoint-submission-${entry.id}`}
          ><FileText size={16} /> Download submission sheet</a>}
        </div>
      <button className="page-sidebar-hamburger" onClick={() => setReviewSidebarOpen(v => !v)} aria-label="Open review sidebar">
        <span className="hamburger-icon">☰</span>
      </button>

      <aside className={`rubric ${reviewSidebarOpen ? 'mobile-open' : ''}`}>
        <p className="eyebrow">Feedback</p>
        <div className="review-feedback-box">
          <label className="field-label">Feedback<textarea className="field textarea" value={feedback} onChange={e => setFeedback(e.target.value)} placeholder="Write feedback here..." /></label>
          <div className="review-voice-note">
            <div className="review-voice-heading"><div><strong>Voice note</strong><small>Add a spoken explanation with your written feedback</small></div><Mic size={16} /></div>
            {recording ? (
              <div className={`voice-message-bar is-recording${recordingPaused ? ' is-paused' : ''}`}>
                <button type="button" className="voice-message-delete" onClick={cancelVoiceRecording} aria-label="Discard recording"><Trash2 size={18} /></button>
                <span className="voice-message-recording-dot" />
                <span className="voice-message-time">{formatRecordingTime(recordingSeconds)}</span>
                <div className="voice-message-waveform" aria-label={recordingPaused ? 'Recording paused' : 'Recording'}>
                  {Array.from({ length: 42 }, (_, index) => <i key={index} style={{ '--wave-height': `${18 + ((index * 37 + 13) % 76)}%` } as React.CSSProperties} />)}
                </div>
                <button type="button" className="voice-message-control" onClick={toggleRecordingPause} aria-label={recordingPaused ? 'Resume recording' : 'Pause recording'}>{recordingPaused ? <Play size={19} fill="currentColor" /> : <Pause size={20} fill="currentColor" />}</button>
                <button type="button" className="voice-message-send" onClick={stopVoiceRecording} aria-label="Finish voice note"><Check size={20} strokeWidth={3} /></button>
              </div>
            ) : voiceNoteFile ? (
              <div className="review-voice-ready">
                <audio ref={voiceAudioRef} preload="auto" src={voiceNoteUrl ?? undefined} onTimeUpdate={event => setVoicePlaybackSeconds(event.currentTarget.currentTime)} onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setVoiceNoteDuration(event.currentTarget.duration); }} onEnded={() => setVoicePlaying(false)} />
                <div className="voice-message-bar">
                  <button type="button" className="voice-message-play" onClick={toggleVoicePlayback} aria-label={voicePlaying ? 'Pause voice note' : 'Play voice note'}>{voicePlaying ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button>
                  <span className="voice-message-time">{formatRecordingTime(Math.floor(voicePlaybackSeconds))}</span>
                  <div className="voice-message-waveform voice-message-seek">
                    {Array.from({ length: 42 }, (_, index) => <i key={index} className={(index / 41) <= (voicePlaybackSeconds / Math.max(voiceNoteDuration, 0.01)) ? 'played' : ''} style={{ '--wave-height': `${18 + ((index * 37 + 13) % 76)}%` } as React.CSSProperties} />)}
                    <input type="range" min="0" max="100" value={Math.min(100, (voicePlaybackSeconds / Math.max(voiceNoteDuration, 0.01)) * 100)} onChange={event => seekVoicePlayback(Number(event.target.value))} aria-label="Seek through voice note" />
                  </div>
                  <span className="voice-message-time">{formatRecordingTime(Math.ceil(voiceNoteDuration))}</span>
                  <button type="button" className="voice-message-delete" onClick={cancelVoiceRecording} aria-label="Delete voice note"><Trash2 size={17} /></button>
                </div>
                <small className="voice-message-status">Voice note ready · included with your review</small>
              </div>
            ) : (
              <Button outline disabled={submitting} onClick={startVoiceRecording}><Mic size={14} /> Record voice note</Button>
            )}
            {recordingError && <p className="review-voice-error" role="alert">{recordingError}</p>}
          </div>
        </div>
        <div className="review-annotation-tools">
          <Button outline disabled={!submissionImageUrl} onClick={() => setShowAnnotator(true)}><PenTool size={15} /> Annotate submitted sheet</Button>
          <p>Use touch, Apple Pencil, mouse, or trackpad to mark directly on the student's sheet.</p>
          {(uploadedCorrectionName || correctionFile) && <div className="review-annotation-attached"><Check size={14} /><span>{uploadedCorrectionName ?? correctionFile?.name} attached as correction</span><button type="button" className="text-link danger" onClick={() => { setCorrectionFile(null); setUploadedCorrectionKey(null); setUploadedCorrectionName(null); }}>Remove</button></div>}
          <details className="review-annotation-upload-existing">
            <summary>Upload an existing annotated image instead</summary>
            <UploadBox label={correctionFile?.name ?? 'Choose annotated image'} sublabel="For this student's reference only" icon={FileImage} accept="image/*" onChange={file => { setCorrectionFile(file); setUploadedCorrectionKey(null); setUploadedCorrectionName(null); }} />
          </details>
        </div>
        <div className="review-actions">
          <Button disabled={submitting || recording} onClick={() => submitDecision('pass')}>{submitting ? <PenLoader label="Submitting review" compact tiny /> : 'Pass'} {!submitting && <Check size={15} />}</Button>
          <Button outline disabled={submitting || recording} onClick={() => submitDecision('redo')}>{submitting ? <PenLoader label="Submitting review" compact tiny /> : 'Needs redo'}</Button>
        </div>
        {decision && (
          <div className="review-result">
            <StatusChip tone={decision === 'pass' ? 'green' : 'red'}>{decision === 'pass' ? 'Passed' : 'Needs redo'} · student notified</StatusChip>
            {decision === 'pass' && <p>Next levels are now unlocked for this student. If a certificate template exists for this checkpoint, it's now pending your approval in Certificates & Data.</p>}
            {decision === 'redo' && <p>The student will re-attempt with the same letters and text, submitted as a brand-new entry. It will go through normal routing and may land with a different teacher. Your annotated sheet is for the student's reference only — it will NOT be shown to whoever reviews the redo.</p>}
          </div>
        )}
      </aside>

      {reviewSidebarOpen && <div className="rubric-backdrop" onClick={() => setReviewSidebarOpen(false)} /> }
      </div>
      {entry.scopedSubmissions.length > 0 ? (
        <section className="scoped-submissions review-practice-gallery">
          <div className="scoped-submissions-heading"><div><p className="eyebrow">Course practice uploads</p><span>{entry.scopedSubmissions.length} upload{entry.scopedSubmissions.length === 1 ? '' : 's'} from this checkpoint range</span></div></div>
          <div className="scoped-submission-grid">
            {entry.scopedSubmissions.map(s => (
              <article key={s.id} className="scoped-submission-card">
                <div className="scoped-submission-image">
                  {practiceImageUrls[s.id]
                    ? <img src={practiceImageUrls[s.id]} alt={s.original_filename ?? 'Student practice upload'} loading="lazy" />
                    : <div className="review-image-unavailable"><FileImage size={24} /><span>Image unavailable</span></div>}
                </div>
                <div className="scoped-submission-meta"><strong>{s.time_spent_minutes} min practiced</strong><small>{new Date(s.submitted_at).toLocaleDateString()}</small></div>
              </article>
            ))}
          </div>
        </section>
      ) : <section className="scoped-submissions scoped-submissions-empty review-practice-gallery"><p className="eyebrow">Course practice uploads</p><p>No regular practice uploads were submitted in the levels covered by this checkpoint.</p></section>}
      {showAnnotator && submissionImageUrl && <SubmissionAnnotator
        imageStorageKey={entry.khat_image_storage_key}
        fallbackImageUrl={submissionImageUrl}
        imageName={entry.original_filename ?? `checkpoint-submission-${entry.id}`}
        onCancel={() => setShowAnnotator(false)}
        onUpload={async file => {
          const uploaded = await uploadFile('corrections', file);
          setUploadedCorrectionKey(uploaded.storageKey);
          setUploadedCorrectionName(uploaded.originalFilename);
          setCorrectionFile(null);
          setShowAnnotator(false);
        }}
      />}
    </main>
  );
}

type ApiReviewHistoryRow = {
  id: string;
  reviewed_at: string;
  status: 'reviewed' | 'redo_needed';
  decision: 'pass' | 'redo';
  source_type: string;
  level_title: string | null;
  script_name: string | null;
  student_name: string;
};

type ApiReviewHistory = {
  reviews: ApiReviewHistoryRow[];
  stats: {
    totalReviewed: number;
    avgResponseHours: number | null;
    escalatedAwayCount: number;
  };
};

export function Reviews() {
  const [reviews, setReviews] = useState<ApiReviewHistoryRow[]>([]);
  const [stats, setStats] = useState<ApiReviewHistory['stats'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = getSessionUser();

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setLoading(false);
      setError('Your teacher session could not be found. Please sign in again.');
      return;
    }

    apiFetch<ApiReviewHistory>('/entries/reviews')
      .then(data => {
        if (cancelled) return;
        setReviews(data.reviews ?? []);
        setStats(data.stats);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load your review history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [user?.id]);

  return (
    <main className="page portal-page">
      <SectionHeading title="My Reviews" text="Your review history and response rhythm." />
      {error && <p className="error-text">{error}</p>}
      <div className="stats-grid">
        <StatCard icon={ClipboardList} value={stats ? String(stats.totalReviewed) : '—'} label="Total reviewed" />
        <StatCard icon={Zap} value={stats?.avgResponseHours != null ? `${Math.round(stats.avgResponseHours)} hrs` : '—'} label="Average response time" />
        <StatCard icon={ShieldCheck} value={stats ? String(stats.escalatedAwayCount) : '—'} label="Escalated away" />
      </div>
      <div className="history-table">
        <div className="table-head"><span>Date</span><span>Script</span><span>Level</span><span>Decision</span></div>
        {loading ? (
          <PenLoader label="Loading review history…" compact />
        ) : reviews.length === 0 ? (
          <div className="history-empty"><ClipboardList size={21} /><strong>No completed reviews yet</strong><span>Your completed reviews will appear here.</span></div>
        ) : reviews.map(review => (
          <div className="history-row" key={review.id}>
            <span>{new Date(review.reviewed_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
            <span>{review.script_name ?? '—'}</span>
            <span>{review.level_title ?? review.source_type}</span>
            <span className={review.status === 'reviewed' ? 'pass-text' : ''}>{review.status === 'reviewed' ? 'Pass' : 'Needs revision'}</span>
          </div>
        ))}
      </div>
    </main>
  );
}


type ApiAsset = {
  id: string;
  title: string;
  tags: string[] | null;
  khat_type_id: string;
  uploader_name: string;
  file_storage_key: string;
  original_filename?: string | null;
  created_at?: string;
  imageUrl?: string;
};

export function TeacherShowcase() {
  const [posts, setPosts] = useState<ApiShowcasePost[]>([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [caption, setCaption] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [editingFile, setEditingFile] = useState<File | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => apiFetch<ApiShowcasePost[]>('/showcase/mine').then(async list => {
    const resolved = await Promise.all(list.map(async item => {
      if (!item.image_storage_key) return item;
      try {
        return { ...item, imageUrl: await getViewUrl(item.image_storage_key) };
      } catch {
        return item;
      }
    }));
    setPosts(resolved);
  }).catch(() => {}).finally(() => setPostsLoading(false));
  useEffect(() => { load(); }, []);

  const post = async () => {
    if (!file) return;
    setPosting(true);
    setError(null);
    try {
      const { storageKey } = await uploadFile('showcase', file);
      await apiFetch('/showcase', { method: 'POST', body: { imageStorageKey: storageKey, caption } });
      setCaption('');
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to post.');
    } finally {
      setPosting(false);
    }
  };

  return (
    <main className="page portal-page showcase-page">
      <SectionHeading eyebrow="Share your work" title="My Showcase" text="Teacher posts are auto-approved — no moderation gate. Admin retains the ability to remove any post." />
      {error && <p className="error-text">{error}</p>}
      <div className="showcase-form">
        <label className="field-label">Caption<textarea className="field textarea" value={caption} onChange={e => setCaption(e.target.value)} placeholder="What did you notice while making this piece?" /></label>
        <UploadBox tall label={file?.name ?? 'Add a photo of your work'} sublabel={file ? 'Photo ready — tap to replace or edit' : 'Posts immediately — no approval needed'} icon={FileImage} onChange={setEditingFile} />
        <Button onClick={post}>{posting ? <PenLoader label="Posting showcase work" compact tiny /> : 'Post to gallery'} {!posting && <ArrowRight size={15} />}</Button>
      </div>
      {editingFile && <ShowcaseImageEditor file={editingFile} onCancel={() => setEditingFile(null)} onSave={editedFile => { setFile(editedFile); setEditingFile(null); }} />}
      <SectionHeading title="My posted work" />
      <div className="gallery-grid">
        {postsLoading ? <PenLoader label="Loading your showcase posts…" compact /> : posts.length === 0 && (
          <div className="showcase-empty-state">
            <span><FileImage size={17} /></span>
            <div><strong>You haven’t posted anything yet</strong><p>Your shared pieces will appear here.</p></div>
          </div>
        )}
        {posts.map(post => (
          <ShowcasePostCard key={post.id} post={{
            id: post.id,
            role: 'teacher',
            imageUrl: post.imageUrl,
            caption: post.caption,
            authorName: post.author_name ?? 'You',
            branch: post.branch_name ?? post.branch,
            status: post.status,
          }} />
        ))}
      </div>
    </main>
  );
}

export function AssetLibrary() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Script | 'All'>('All');
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [assetsList, setAssetsList] = useState<ApiAsset[]>([]);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [uploadKhatTypeId, setUploadKhatTypeId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    apiFetch<ApiKhatType[]>('/khat-types')
      .then(list => {
        setKhatTypesList(list);
        setUploadKhatTypeId(list[0]?.id ?? '');
      })
      .catch(err => setError(err instanceof ApiError ? err.message : 'Failed to load script types.'));
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (filter !== 'All') { const kt = khatTypesList.find(k => k.code === scriptToCode(filter)); if (kt) params.set('khatTypeId', kt.id); }
    try {
      const assets = await apiFetch<ApiAsset[]>(`/assets?${params.toString()}`);
      const withUrls = await Promise.all(assets.map(async asset => {
        try {
          return { ...asset, imageUrl: await getViewUrl(asset.file_storage_key) };
        } catch {
          return asset;
        }
      }));
      setAssetsList(withUrls);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load shared assets.');
      setAssetsList([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [search, filter, khatTypesList]);

  const upload = async () => {
    if (!file || !title || !uploadKhatTypeId) return;
    setUploading(true);
    setError(null);
    try {
      const { storageKey } = await uploadFile('assets', file);
      await apiFetch('/assets', {
        method: 'POST',
        body: { khatTypeId: uploadKhatTypeId, title, tags: tags.split(',').map(t => t.trim()).filter(Boolean), fileStorageKey: storageKey, originalFilename: file.name },
      });
      setTitle(''); setTags(''); setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to upload asset.');
    } finally {
      setUploading(false);
    }
  };

  const openAsset = (asset: ApiAsset) => {
    if (asset.imageUrl) window.open(asset.imageUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <main className="page portal-page">
      <SectionHeading eyebrow="Shared resources" title="Asset Library" text="A shared visual reference shelf for every script. Browse contributions from teachers across all branches." />
      {error && <p className="error-text">{error}</p>}
      <div className="asset-upload-form">
        <div className="asset-upload-heading"><div className="asset-upload-mark"><Upload size={17} /></div><div><strong>Contribute a reference</strong><small>Share a useful example with the teaching community.</small></div></div>
        <label className="field-label">Asset title<input className="field" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Alif in six weights" /></label>
        <label className="field-label">Khat type
          <select className="field" value={uploadKhatTypeId} onChange={e => setUploadKhatTypeId(e.target.value)} disabled={khatTypesList.length === 0}><option value="" disabled>Select a script</option>{khatTypesList.map(k => <option key={k.id} value={k.id}>{k.display_name}</option>)}</select>
        </label>
        <label className="field-label">Tags <small className="asset-field-hint">Comma-separated</small><input className="field" value={tags} onChange={e => setTags(e.target.value)} placeholder="alif, mufradat, weight" /></label>
        <UploadBox label={file?.name ?? 'Choose an image'} sublabel="JPG or PNG · shared reference" onChange={setFile} />
        <Button onClick={upload} className="asset-upload-button">{uploading ? <PenLoader label="Uploading asset" compact tiny /> : 'Add to library'} {!uploading && <ArrowRight size={15} />}</Button>
      </div>
      <SectionHeading eyebrow="Reference shelf" title="Browse assets" text={`${assetsList.length} ${assetsList.length === 1 ? 'reference' : 'references'} available in this view.`} action={
        <div className="search-field"><Search size={16} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search title or tag" aria-label="Search assets by title or tag" /></div>
      } />
      <div className="tabs small">
        <button className={filter === 'All' ? 'active' : ''} onClick={() => setFilter('All')}>All</button>
        {scriptList.map(s => <button key={s} className={filter === s ? 'active' : ''} onClick={() => setFilter(s)}>{khatTypes[s].name}</button>)}
      </div>
      <div className="asset-grid">
        {loading ? <PenLoader label="Loading asset library…" compact /> : assetsList.length === 0 && <div className="asset-empty-state"><div className="asset-empty-mark"><Search size={18} /></div><strong>{search ? 'No matching references' : 'The shelf is ready for its first reference'}</strong><p>{search ? 'Try a different title, tag, or script filter.' : 'Upload an image above to begin building the shared library.'}</p></div>}
        {!loading && assetsList.map(asset => {
          const kt = khatTypesList.find(k => k.id === asset.khat_type_id);
          const script = kt ? scriptFromCode(kt.code) : null;
          return (
            <div className="asset-card" key={asset.id}>
              <button className="asset-art" onClick={() => openAsset(asset)} aria-label={`Open ${asset.title}`} style={{ '--script': script ? khatTypes[script].color : 'var(--gold)' } as React.CSSProperties}>
                {asset.imageUrl ? <img src={asset.imageUrl} alt={asset.title} /> : <span>{script ? khatTypes[script].arabic : <FileImage size={28} />}</span>}
                {kt && <span className="asset-script-badge">{kt.display_name}</span>}
              </button>
              <div className="asset-card-body"><strong>{asset.title}</strong><small>Added by {asset.uploader_name}{asset.created_at ? ` · ${new Date(asset.created_at).toLocaleDateString()}` : ''}</small></div>
              {!!asset.tags?.length && <div className="asset-tags">{asset.tags.map(t => <span key={t}>{t}</span>)}</div>}
              <button className="asset-open-link" onClick={() => openAsset(asset)} disabled={!asset.imageUrl}>View reference <ArrowRight size={13} /></button>
            </div>
          );
        })}
      </div>
    </main>
  );
}

type ApiTeacherProfile = {
  id: string; name: string; branchId: string; isCoordinator: boolean; entryLoadThreshold: number;
  photoStorageKey?: string | null;
  assignedScripts: ApiAssignedScript[];
  showcasePosts: ApiShowcasePost[];
  activity: { activity_date: string; login_count: number }[];
  totalReviewed: number; avgResponseHours: number | null; escalatedAwayCount: number;
};

export function TeacherProfile() {
  const [profile, setProfile] = useState<ApiTeacherProfile | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const viewedId = useViewedTeacherId();
  const user = getSessionUser();
  const targetId = viewedId ?? user?.id;

  useEffect(() => {
    if (!targetId) return;
    let cancelled = false;
    apiFetch<ApiTeacherProfile>(`/teachers/${targetId}/profile`).then(async data => {
      const [showcasePosts, resolvedPhotoUrl] = await Promise.all([
        Promise.all(data.showcasePosts.map(async post => {
          if (!post.image_storage_key) return post;
          try {
            return { ...post, imageUrl: await getViewUrl(post.image_storage_key) };
          } catch {
            return post;
          }
        })),
        data.photoStorageKey ? getViewUrl(data.photoStorageKey).catch(() => null) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      setPhotoUrl(resolvedPhotoUrl);
      setProfile({ ...data, showcasePosts });
    }).catch(() => {});
    return () => {
      cancelled = true;
      clearViewedTeacher();
    };
  }, [targetId]);

  if (!profile) return <main className="page portal-page">{viewedId && <BackLink to="branch-teachers" label="Back to Branch Teachers" />}<PenLoader label="Loading teacher profile…" /></main>;

  return (
    <main className="page portal-page">
      {viewedId && <BackLink to="branch-teachers" label="Back to Branch Teachers" />}
      <div className="profile-hero">
        <div className="profile-avatar" style={{ overflow: 'hidden', padding: 0 }}>
          {photoUrl ? (
            <img src={photoUrl} alt={`${profile.name}'s profile`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            profile.name.split(' ').map(n => n[0]).slice(0, 2).join('')
          )}
        </div>
        <div>
          <p className="eyebrow">Teacher profile{profile.isCoordinator ? ' · Branch coordinator' : ''}</p>
          <h1>{profile.name}</h1>
          <p>Assigned scripts: {profile.assignedScripts.length > 0 ? profile.assignedScripts.map(s => s.display_name).join(', ') : 'None yet'}</p>
        </div>
      </div>
      <div className="profile-stats">
        <StatCard icon={ClipboardList} value={String(profile.totalReviewed)} label="Entries checked to date" />
        <StatCard icon={Zap} value={profile.avgResponseHours != null ? `${Math.round(profile.avgResponseHours)} hrs` : '—'} label="Average turnaround" />
        <StatCard icon={Users} value={String(profile.escalatedAwayCount)} label="Escalated away" />
      </div>
      <SectionHeading title="My posted showcase works" />
      <div className="gallery-grid">
        {profile.showcasePosts.length === 0 && (
          <div className="showcase-empty-state">
            <span><FileImage size={17} /></span>
            <div><strong>No posts yet</strong><p>Your shared showcase work will appear here.</p></div>
          </div>
        )}
        {profile.showcasePosts.map(post => (
          <ShowcasePostCard key={post.id} post={{
            id: post.id,
            role: 'teacher',
            imageUrl: post.imageUrl,
            caption: post.caption,
            authorName: profile.name,
            branch: post.branch_name ?? post.branch,
            status: post.status,
          }} />
        ))}
      </div>
      <div className="activity-card">
        <SectionHeading title="Site activity" />
        <ActivityHeatmap activity={profile.activity ?? []} />
      </div>
    </main>
  );
}

type ApiStudentProfile = {
  id: string; name: string; branchId: string;
  enrollments: { id: string; course_id: string; course_title: string; category: string; khat_type_id: string; percent_complete: string | number }[];
  levelSubmissions: { id: string; level_title: string; khat_type_id: string; time_spent_minutes: number; submitted_at: string }[];
  certificates: { id: string; title: string; status: string }[];
  badges: { id: string; khat_type_id: string; tier: string }[];
  activity: { activity_date: string; login_count: number }[];
  timeSpentByKhatType: { khat_type_id: string; total_minutes: string | number }[];
};

export function RestrictedStudentProfile() {
  const studentId = useActiveStudentId();
  const [profile, setProfile] = useState<ApiStudentProfile | null>(null);
  const [khatTypesList, setKhatTypesList] = useState<ApiKhatType[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ApiKhatType[]>('/khat-types').then(setKhatTypesList).catch(() => {});
    if (!studentId) return;
    apiFetch<ApiStudentProfile>(`/students/${studentId}/profile`)
      .then(setProfile)
      .catch(err => setError(err instanceof ApiError ? err.message : 'Failed to load this profile.'));
  }, [studentId]);

  const khatName = (id: string) => khatTypesList.find(k => k.id === id)?.display_name ?? '—';
  const khatColorScript = (id: string): Script | null => {
    const kt = khatTypesList.find(k => k.id === id);
    return kt ? scriptFromCode(kt.code) : null;
  };

  if (!studentId) return <main className="page portal-page"><p className="muted">No student selected. Open this from an entry review or the branch student list.</p></main>;
  if (error) return <main className="page portal-page"><BackLink to="queue" label="Back" /><p className="error-text">{error}</p></main>;
  if (!profile) return <main className="page portal-page"><PenLoader label="Loading student profile…" /></main>;

  const totalMinutes = profile.timeSpentByKhatType.reduce((sum, t) => sum + Number(t.total_minutes), 0);

  return (
    <main className="page portal-page">
      <BackLink to="queue" label="Back to Review Queue" />
      <div className="profile-hero">
        <div className="profile-avatar">{profile.name.split(' ').map(n => n[0]).slice(0, 2).join('')}</div>
        <div>
          <p className="eyebrow">Student profile · practice & activity view</p>
          <h1>{profile.name}</h1>
        </div>
      </div>
      <div className="info-banner"><Eye size={16} /><span>You are viewing this student's practice and activity data. Contact details and student-only actions (like sharing to showcase) are not shown. This view is available for any student across any branch — entries can be diverted across branches.</span></div>
      <div className="profile-stats">
        <StatCard icon={Clock} value={`${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`} label="Total practice time" />
        <StatCard icon={Award} value={String(profile.certificates.filter(c => c.status === 'approved').length)} label="Certificates earned" />
        <StatCard icon={Trophy} value={String(profile.badges.length)} label="Badges earned" />
      </div>
      <SectionHeading title="Practice uploads" text="Every regular level upload — browseable, not just a count. Judge how much and how well the student has practiced." />
      <div className="practice-upload-grid">
        {profile.levelSubmissions.length === 0 && <p className="muted">No practice uploads yet.</p>}
        {profile.levelSubmissions.map(upload => {
          const script = khatColorScript(upload.khat_type_id);
          return (
            <div className="practice-upload-tile" key={upload.id}>
              <div className="practice-tile-art" style={{ color: script ? khatTypes[script].color : undefined }}><FileImage size={20} /></div>
              <div><strong>{upload.level_title}</strong><small>{khatName(upload.khat_type_id)} · {new Date(upload.submitted_at).toLocaleDateString()}</small></div>
              <span className="practice-time"><Clock size={13} /> {upload.time_spent_minutes} min</span>
            </div>
          );
        })}
      </div>
      <SectionHeading title="Progress per khat type" text="Separate tracks — no combined badge." />
      <div className="profile-script-grid">
        {profile.enrollments.filter(e => e.category === 'certification').map(enr => {
          const script = khatColorScript(enr.khat_type_id);
          const badge = profile.badges.find(b => b.khat_type_id === enr.khat_type_id);
          if (!script) return null;
          return (
            <div className="profile-script" key={enr.id} style={{ '--script': khatTypes[script].color } as React.CSSProperties}>
              <div className="profile-script-head">
                <strong>{khatTypes[script].arabic}</strong>
                <div><h3>{khatTypes[script].name}</h3><span>{Math.round(Number(enr.percent_complete))}%</span></div>
                {badge && <BadgeIcon script={script} tier={badge.tier as never} />}
              </div>
              <div className="progress"><i style={{ width: `${Number(enr.percent_complete)}%`, background: khatTypes[script].color }} /></div>
            </div>
          );
        })}
      </div>
      <div className="activity-card">
        <SectionHeading title="Practice rhythm" />
        <ActivityHeatmap activity={profile.activity ?? []} />
      </div>
    </main>
  );
}

type ApiCompetition = { id: string; title: string; judging_deadline: string | null; judge_teacher_id: string | null; status: string };
type ApiCompetitionEntry = { id: string; student_id: string; student_name: string; image_storage_key: string; submitted_at: string; imageUrl?: string };

export function CompetitionJudging() {
  const [competitions, setCompetitions] = useState<ApiCompetition[]>([]);
  const [competitionId, setCompetitionId] = useState('');
  const [entries, setEntries] = useState<ApiCompetitionEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const user = getSessionUser();
  const competition = competitions.find(item => item.id === competitionId) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setError('Your teacher session could not be found. Please sign in again.');
      setLoading(false);
      return;
    }

    apiFetch<ApiCompetition[]>('/competitions?status=judging')
      .then(list => {
        if (cancelled) return;
        const assigned = list.filter(item => item.judge_teacher_id === user.id);
        setCompetitions(assigned);
        setCompetitionId(current => assigned.some(item => item.id === current) ? current : assigned[0]?.id ?? '');
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load assigned competitions.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;
    if (!competitionId) {
      setEntries([]);
      return;
    }

    setEntriesLoading(true);
    setError(null);
    setSelected([]);
    setDone(false);
    apiFetch<ApiCompetitionEntry[]>(`/competitions/${competitionId}/entries`)
      .then(async list => {
        const resolved = await Promise.all(list.map(async entry => {
          try {
            return { ...entry, imageUrl: await getViewUrl(entry.image_storage_key) };
          } catch {
            return entry;
          }
        }));
        if (!cancelled) setEntries(resolved);
      })
      .catch(err => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load competition entries.');
      })
      .finally(() => {
        if (!cancelled) setEntriesLoading(false);
      });

    return () => { cancelled = true; };
  }, [competitionId]);

  const toggle = (entryId: string) => setSelected(prev => prev.includes(entryId) ? prev.filter(id => id !== entryId) : [...prev, entryId]);

  const submitWinners = async () => {
    if (!competition || selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch(`/competitions/${competition.id}/submit-winners`, {
        method: 'POST',
        body: { winners: selected.map((competitionEntryId, i) => ({ competitionEntryId, rank: i + 1 })) },
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to submit winners.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <main className="page portal-page"><PenLoader label="Loading assigned competitions…" /></main>;

  if (!competition) {
    return (
      <main className="page portal-page">
        <SectionHeading eyebrow="Guild challenges" title="Competition judging" text="Review assigned entries and submit your ranked selections to the admin team." />
        {error ? <p className="error-text">{error}</p> : (
          <div className="judging-empty-state">
            <div className="judging-empty-icon"><Trophy size={23} /></div>
            <p className="eyebrow">No assignment yet</p>
            <h2>You’re not assigned to judge a competition</h2>
            <p>When an admin assigns you as a judge, the competition and its submitted entries will appear here.</p>
          </div>
        )}
      </main>
    );
  }

  if (done) {
    return (
      <main className="page portal-page">
        <div className="judging-success-card">
          <div className="judging-success-icon"><Check size={24} /></div>
          <p className="eyebrow">Judging complete</p>
          <h1>Winners submitted</h1>
          <p>Your selections for <strong>{competition.title}</strong> have been sent to admin. Results will be visible to students after publication.</p>
          <Button outline onClick={() => navigate('teacher-dashboard')}>Return to dashboard <ArrowRight size={15} /></Button>
        </div>
      </main>
    );
  }

  return (
    <main className="page portal-page">
      <div className="judging-banner">
        <Trophy size={20} />
        <div><small>ASSIGNED COMPETITION</small><strong>{competition.title}</strong><span>{competition.judging_deadline ? `Submit before ${new Date(competition.judging_deadline).toLocaleDateString()}` : 'Select and rank the winning entries below'}</span></div>
      </div>
      {competitions.length > 1 && <div className="judging-competition-switcher">{competitions.map(item => <button key={item.id} className={item.id === competitionId ? 'active' : ''} onClick={() => setCompetitionId(item.id)}>{item.title}</button>)}</div>}
      {error && <p className="error-text">{error}</p>}
      <SectionHeading eyebrow="Anonymous submissions" title="Select winner(s)" text="Entries are shown without names or branch details to support impartial judging. Your selection order sets each winner’s rank." />
      <div className="judging-grid">
        {entriesLoading ? <PenLoader label="Loading competition entries…" compact /> : entries.length === 0 ? (
          <div className="judging-no-entries"><FileImage size={21} /><strong>No entries submitted yet</strong><span>Submitted work will appear here when contestants enter.</span></div>
        ) : entries.map((entry, index) => {
          const rank = selected.indexOf(entry.id) + 1;
          return (
            <article className={`judging-card ${rank > 0 ? 'selected' : ''}`} key={entry.id}>
              <button className="judging-art" onClick={() => entry.imageUrl && window.open(entry.imageUrl, '_blank', 'noopener,noreferrer')} aria-label={`Open anonymous entry ${index + 1}`}>
                {entry.imageUrl ? <img src={entry.imageUrl} alt={`Anonymous competition entry ${index + 1}`} /> : <FileImage size={30} />}
                {rank > 0 && <span className="judging-rank">Rank {rank}</span>}
              </button>
              <div className="judging-card-meta"><span>Anonymous entry</span><small>Submitted {new Date(entry.submitted_at).toLocaleDateString()}</small></div>
              <Button outline onClick={() => toggle(entry.id)}>
                {rank > 0 ? <><Check size={14} /> Selected · rank {rank}</> : 'Select as winner'}
              </Button>
            </article>
          );
        })}
      </div>
      {selected.length > 0 && (
        <div className="judging-submit">
          <div><strong>{selected.length} {selected.length === 1 ? 'winner' : 'winners'} selected</strong><small>Ranks are assigned in the order selected.</small></div>
          <Button onClick={submitWinners}>{submitting ? <PenLoader label="Submitting competition winners" compact tiny /> : 'Submit winners to admin'} {!submitting && <ArrowRight size={15} />}</Button>
        </div>
      )}
    </main>
  );
}


export type ApiLiveEvent = {
  id: string;
  host_teacher_id: string;
  branch_id: string;
  title: string;
  description: string | null;
  scheduled_at: string;
  status: 'scheduled' | 'live' | 'ended';
  recording_storage_key: string | null;
  recording_status?: 'processing' | 'ready' | null;
  host_name?: string;
  branch_name?: string;
};

export function HostEvent() {
  const [events, setEvents] = useState<ApiLiveEvent[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [studio, setStudio] = useState<{ event: ApiLiveEvent; access: LiveKitRoomAccess } | null>(null);
  const [studioConnected, setStudioConnected] = useState(false);
  const [recordingPlayer, setRecordingPlayer] = useState<{ title: string; url: string } | null>(null);
  const endingEventIds = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    try {
      const data = await apiFetch<ApiLiveEvent[]>('/events');
      setEvents(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadEvents();
    const timer = window.setInterval(() => { void loadEvents(); }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadEvents]);

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !scheduledAt) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch('/events', {
        method: 'POST',
        body: { title, description, scheduledAt: new Date(scheduledAt).toISOString() },
      });
      setTitle('');
      setDescription('');
      setScheduledAt('');
      await loadEvents();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to schedule event');
    } finally {
      setSubmitting(false);
    }
  };

  const enterStudio = async (event: ApiLiveEvent) => {
    setBusyEventId(event.id);
    setError(null);
    try {
      const access = await apiFetch<LiveKitRoomAccess>(`/events/${event.id}/host-token`, { method: 'POST' });
      setStudio({ event, access });
      setStudioConnected(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the live studio.');
    } finally {
      setBusyEventId(null);
    }
  };

  const handleGoLive = async (id: string) => {
    setBusyEventId(id);
    setError(null);
    try {
      await apiFetch(`/events/${id}/go-live`, { method: 'PATCH' });
      await loadEvents();
      setStudio(current => current?.event.id === id
        ? { ...current, event: { ...current.event, status: 'live' } }
        : current);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start the event');
    } finally {
      setBusyEventId(null);
    }
  };

  const handleEndStream = async (id: string) => {
    endingEventIds.current.add(id);
    setBusyEventId(id);
    setError(null);
    try {
      await apiFetch(`/events/${id}/end`, { method: 'PATCH' });
      await loadEvents();
      setStudio(current => current?.event.id === id ? null : current);
      setStudioConnected(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to end the event');
    } finally {
      setBusyEventId(null);
      window.setTimeout(() => endingEventIds.current.delete(id), 2_000);
    }
  };

  const openRecording = async (event: ApiLiveEvent) => {
    if (!event.recording_storage_key) return;
    setError(null);
    try {
      setRecordingPlayer({ title: event.title, url: await getViewUrl(event.recording_storage_key) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open this recording.');
    }
  };

  return (
    <main className="page portal-page">
      <SectionHeading
        eyebrow="Host a session"
        title="Host a Live Event"
        text="Host directly from your browser. Students join in-site, and the event recording is saved to the guild library."
      />

      <p className="muted">Allow camera and microphone access when the studio opens. Starting and ending the broadcast, student access, notifications, and recordings are managed here.</p>

      {error && <p className="error-text">{error}</p>}

      {studio && (
        <section className="card live-now-card livekit-studio-card">
          <div className="livekit-studio-heading">
            <div>
              <p className="eyebrow">{studio.event.status === 'live' ? 'Live event' : 'Private studio'}</p>
              <h2>{studio.event.title}</h2>
              <p>{studioConnected ? 'Your browser is connected to the studio.' : 'Connecting to the studio and requesting camera/microphone access…'}</p>
            </div>
            {studio.event.status === 'scheduled' ? (
              <Button disabled={!studioConnected || busyEventId === studio.event.id} onClick={() => handleGoLive(studio.event.id)}>
                <Radio size={15} /> {busyEventId === studio.event.id ? 'Starting…' : 'Start live event'}
              </Button>
            ) : (
              <Button outline disabled={busyEventId === studio.event.id} onClick={() => handleEndStream(studio.event.id)}>
                <StopCircle size={16} /> {busyEventId === studio.event.id ? 'Ending…' : 'End event'}
              </Button>
            )}
          </div>
          <Suspense fallback={<div className="live-video-waiting">Loading browser studio…</div>}>
            <LiveKitEventRoom
              access={studio.access}
              publishMedia
              onConnected={() => setStudioConnected(true)}
              onDisconnected={() => {
                const liveEventId = studio.event.status === 'live' && !endingEventIds.current.has(studio.event.id)
                  ? studio.event.id
                  : null;
                setStudio(null);
                setStudioConnected(false);
                if (liveEventId) void handleEndStream(liveEventId);
              }}
              onError={err => setError(err.message || 'The live studio connection failed.')}
            />
          </Suspense>
        </section>
      )}

      <div className="admin-dashboard-grid">
        <form onSubmit={handleSchedule} className="chart-card">
          <SectionHeading title="Schedule New Event" text="Create a browser-based live study session for your students." />
          <label className="field-label">
            Title
            <input
              className="field"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Naskh clinic: joining letters"
              required
            />
          </label>
          <label className="field-label" style={{ marginTop: '1rem' }}>
            Date & time
            <input
              type="datetime-local"
              className="field"
              value={scheduledAt}
              onChange={e => setScheduledAt(e.target.value)}
              required
            />
          </label>
          <label className="field-label" style={{ marginTop: '1rem' }}>
            Description
            <textarea
              className="field textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What will you cover?"
            />
          </label>
          <Button disabled={submitting} className="host-schedule-button">
            {submitting ? <PenLoader label="Scheduling…" compact tiny /> : 'Schedule Event'}
          </Button>
        </form>

        <div className="chart-card">
          <SectionHeading title="Upcoming & Recent Events" text="Manage schedules, live sessions, and saved recordings." />
          {loading ? (
            <PenLoader label="Loading events..." compact />
          ) : events.length === 0 ? (
            <p className="muted">No scheduled or recorded events yet.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {events.map(event => (
                <div key={event.id} className="host-event-row">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <strong>{event.title}</strong>
                      <div className="host-event-date">
                        {new Date(event.scheduled_at).toLocaleString()}
                      </div>
                    </div>
                    <StatusChip tone={event.status === 'live' ? 'green' : event.status === 'ended' ? 'blue' : 'amber'}>
                      {event.status}
                    </StatusChip>
                  </div>
                  {event.description && <p style={{ fontSize: '0.9rem', margin: '0.5rem 0' }}>{event.description}</p>}

                  <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
                    {(event.status === 'scheduled' || event.status === 'live') && studio?.event.id !== event.id && (
                      <Button disabled={busyEventId === event.id || Boolean(studio)} onClick={() => enterStudio(event)}>
                        <Radio size={14} /> {busyEventId === event.id ? 'Opening studio…' : event.status === 'live' ? 'Rejoin studio' : 'Open studio'}
                      </Button>
                    )}
                    {event.status === 'ended' && event.recording_status === 'processing' && (
                      <small className="muted">Preparing the recording…</small>
                    )}
                    {event.status === 'ended' && event.recording_storage_key && (
                      <button type="button" className="text-link" onClick={() => void openRecording(event)} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                        Watch Recording <Play size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {recordingPlayer && (
        <Modal onClose={() => setRecordingPlayer(null)}>
          <p className="eyebrow">Event recording</p>
          <h2>{recordingPlayer.title}</h2>
          <div className="live-video-frame">
            <video src={recordingPlayer.url} controls autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        </Modal>
      )}
    </main>
  );
}

type ApiBranchAnalytics = {
  summary: {
    branchId: string; branchName: string;
    studentCount: number | string; teacherCount: number | string; activeStudents30d: number | string;
    totalEntries: number | string; reviewedEntries: number | string; openEntries: number | string;
    avgResponseHours: number | string | null; practiceMinutes: number | string; averageProgress: number | string | null;
    eventCount: number | string; scheduledEvents: number | string; liveEvents: number | string; endedEvents: number | string;
  };
  activityTrend: BranchActivityPoint[];
  entryTrend: BranchEntryPoint[];
  eventTrend: BranchEventPoint[];
  entryStatuses: BranchStatus[];
  teacherThroughput: BranchTeacher[];
  studentProgress: BranchProgress[];
};

function emptyMonthSeries<T extends { month: string }>(months: number, makePoint: (month: string) => T): T[] {
  const current = new Date();
  current.setDate(1);
  current.setHours(12, 0, 0, 0);
  return Array.from({ length: months }, (_, index) => {
    const date = new Date(current.getFullYear(), current.getMonth() - (months - index - 1), 1, 12);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    return makePoint(month);
  });
}

function metricNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function BranchStats() {
  const [range, setRange] = useState<6 | 12 | 24>(12);
  const [refreshKey, setRefreshKey] = useState(0);
  const [analytics, setAnalytics] = useState<ApiBranchAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loadAnalytics = (showLoading: boolean) => {
      if (showLoading) setLoading(true);
      setError(null);
      apiFetch<ApiBranchAnalytics>(`/teachers/me/branch-stats?months=${range}`)
        .then(data => { if (!cancelled) setAnalytics(data); })
        .catch(err => {
          if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load branch analytics. Please try again.');
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    loadAnalytics(true);
    const refreshInterval = window.setInterval(() => loadAnalytics(false), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(refreshInterval);
    };
  }, [range, refreshKey]);

  const summary = analytics?.summary;
  const activityTrend = analytics?.activityTrend ?? emptyMonthSeries(range, month => ({ month, activeStudents: 0, logins: 0 }));
  const entryTrend = analytics?.entryTrend ?? emptyMonthSeries(range, month => ({ month, submitted: 0, reviewed: 0 }));
  const eventTrend = analytics?.eventTrend ?? emptyMonthSeries(range, month => ({ month, events: 0 }));
  const practiceHours = Math.floor(metricNumber(summary?.practiceMinutes) / 60);
  const averageProgress = summary?.averageProgress == null ? null : Math.round(metricNumber(summary.averageProgress));

  return (
    <main className="page portal-page branch-analytics-page">
      <header className="branch-analytics-hero">
        <div>
          <p className="eyebrow"><Activity size={13} /> Branch coordinator · live analytics</p>
          <h1>{loading && !summary ? 'Branch Statistics' : summary?.branchName ?? 'Branch Statistics'}</h1>
          <p>A data-led view of student activity, teaching throughput, learning progress, and events in your appointed branch.</p>
          {summary?.branchName && <span className="coordinator-branch-badge"><MapPin size={14} /> Appointed branch <strong>{summary.branchName}</strong></span>}
        </div>
        <div className="branch-analytics-controls" aria-label="Analytics controls">
          <div className="branch-range-control" role="group" aria-label="Choose chart time range">
            {([6, 12, 24] as const).map(value => <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)} aria-pressed={range === value}>{value} mo</button>)}
          </div>
          <button className="branch-refresh-button" onClick={() => setRefreshKey(key => key + 1)} disabled={loading} aria-label="Refresh branch statistics"><RefreshCw size={15} className={loading ? 'is-spinning' : ''} /> Refresh</button>
        </div>
      </header>

      {error && <div className="branch-analytics-error" role="alert"><span>{error}</span><button onClick={() => setRefreshKey(key => key + 1)}>Retry <RefreshCw size={13} /></button></div>}

      <section className="branch-kpi-grid" aria-label="Branch key statistics">
        <StatCard icon={Users} value={summary ? String(metricNumber(summary.studentCount)) : '—'} label="Students" trend={summary ? `${metricNumber(summary.activeStudents30d)} active in 30 days` : 'Active in last 30 days'} />
        <StatCard icon={ClipboardList} value={summary ? String(metricNumber(summary.teacherCount)) : '—'} label="Teachers" trend="Appointed to this branch" />
        <StatCard icon={Activity} value={summary ? String(metricNumber(summary.totalEntries)) : '—'} label="Student entries" trend={summary ? `${metricNumber(summary.openEntries)} awaiting review` : 'Awaiting review'} />
        <StatCard icon={Check} value={summary ? String(metricNumber(summary.reviewedEntries)) : '—'} label="Entries reviewed" trend={summary?.avgResponseHours == null ? 'Average response —' : `${Math.round(metricNumber(summary.avgResponseHours))}h average response`} />
        <StatCard icon={Clock} value={summary ? `${practiceHours}h` : '—'} label="Practice time" trend={summary ? `${metricNumber(summary.practiceMinutes) % 60}m additional` : 'Across branch students'} />
        <StatCard icon={Trophy} value={averageProgress == null ? '—' : `${averageProgress}%`} label="Average course progress" trend="Across student enrollments" />
        <StatCard icon={CalendarDays} value={summary ? String(metricNumber(summary.eventCount)) : '—'} label="Branch events" trend={summary ? `${metricNumber(summary.scheduledEvents)} scheduled · ${metricNumber(summary.liveEvents)} live` : 'Scheduled and hosted'} />
      </section>

      {loading && <p className="branch-analytics-loading" role="status"><span className="branch-loading-dot" /> Refreshing figures; charts remain available below.</p>}

      <section className="branch-chart-grid" aria-label="Interactive branch charts">
        <ActivityTrendChart points={activityTrend} />
        <EntryTrendChart points={entryTrend} />
        <EntryStatusChart statuses={analytics?.entryStatuses ?? []} />
        <EventTrendChart points={eventTrend} />
        <TeacherThroughputChart teachers={analytics?.teacherThroughput ?? []} />
        <StudentProgressChart progress={analytics?.studentProgress ?? []} />
      </section>
      <p className="branch-analytics-footnote">Statistics are scoped to {summary?.branchName ?? 'your appointed branch'}, refresh automatically every minute, and can be refreshed on demand. Personal student details are not shown here.</p>
    </main>
  );
}

type ApiStaffRow = { id: string; role: string; name: string; branch_id: string; is_coordinator: boolean; entry_load_threshold: number };
type ApiStudentRow = { id: string; name: string; tr_number: string | null; branch_id: string; created_at: string };

export function BranchTeachers() {
  const [rows, setRows] = useState<(ApiStaffRow & { assignedScripts: ApiAssignedScript[]; totalReviewed: number })[]>([]);
  const [branchName, setBranchName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = getSessionUser();

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const [branchList, staff] = await Promise.all([
          apiFetch<ApiBranch[]>('/branches'),
          apiFetch<ApiStaffRow[]>(`/admin/users?role=teacher&branchId=${encodeURIComponent(user.branchId)}`),
        ]);

        const branch = branchList.find(b => b.id === user.branchId);
        if (!branch) throw new Error('Your branch could not be loaded.');

        const branchTeachers = (staff ?? []).filter(teacher => teacher.branch_id === user.branchId && teacher.role === 'teacher');
        const enriched = await Promise.all(branchTeachers.map(async teacher => {
          const profile = await apiFetch<{ assignedScripts: ApiAssignedScript[]; totalReviewed: number }>(`/teachers/${teacher.id}/profile`).catch(() => ({ assignedScripts: [], totalReviewed: 0 }));
          return { ...teacher, ...profile };
        }));

        if (!cancelled) {
          setBranchName(branch.name);
          setRows(enriched);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load your branch teachers.');
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [user?.id, user?.branchId]);

  const openProfile = (teacherId: string) => { viewTeacherProfile(teacherId); navigate('teacher-profile-view'); };

  return (
    <main className="page portal-page branch-directory-page">
      <div className="portal-welcome branch-directory-hero">
        <div>
          <p className="eyebrow">Branch coordinator · {branchName || 'Loading branch…'}</p>
          <h1>Branch Teacher Overview</h1>
          <p>Teachers in your branch, their assigned khat types, and activity. Load management stays with the admin team.</p>
        </div>
      </div>

      {error && <div className="branch-directory-error" role="alert"><span>{error}</span><button onClick={() => window.location.reload()}>Retry</button></div>}

      <div className="branch-directory-card teacher-table">
        <div className="table-head"><span>Teacher</span><span>Assigned scripts</span><span>Entries reviewed</span><span>Threshold</span><span>Profile</span></div>

        {loading ? (
          <div className="branch-directory-loading"><span className="branch-directory-spinner" />Loading branch teachers…</div>
        ) : rows.length === 0 ? (
          <div className="branch-directory-empty">
            <span className="branch-directory-empty-icon"><Users size={22} /></span>
            <strong>No teachers found in your branch.</strong>
            <p>Once teachers are assigned to this branch, their names and assigned scripts will appear here.</p>
          </div>
        ) : rows.map(t => (
          <div className="history-row branch-directory-row" key={t.id}>
            <span className="branch-directory-name"><strong>{t.name}</strong>{t.is_coordinator && <StatusChip tone="blue">Coord</StatusChip>}</span>
            <span>
              {t.assignedScripts.length > 0 ? (
                <div className="script-toggle-group">
                  {t.assignedScripts.map(s => <span key={s.id || s.code} className="script-toggle-chip active">{s.display_name}</span>)}
                </div>
              ) : (
                <span className="branch-directory-muted">No scripts assigned</span>
              )}
            </span>
            <span>{t.totalReviewed}</span>
            <span>{t.entry_load_threshold}</span>
            <Button outline onClick={() => openProfile(t.id)}>View profile</Button>
          </div>
        ))}
      </div>
    </main>
  );
}

export function BranchStudents() {
  const [rows, setRows] = useState<ApiStudentRow[]>([]);
  const [branchName, setBranchName] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = getSessionUser();

  useEffect(() => {
    let cancelled = false;

    if (!user) {
      setLoading(false);
      return () => { cancelled = true; };
    }

    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const [students, branchList] = await Promise.all([
          apiFetch<ApiStudentRow[]>(`/students?branchId=${encodeURIComponent(user.branchId)}`),
          apiFetch<ApiBranch[]>('/branches'),
        ]);

        const branch = branchList.find(b => b.id === user.branchId);
        if (!branch) throw new Error('Your branch could not be loaded.');

        const branchStudents = (students ?? []).filter(student => student.branch_id === user.branchId);

        if (!cancelled) {
          setBranchName(branch.name);
          setRows(branchStudents);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load your branch students.');
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [user?.id, user?.branchId]);

  const openProfile = (studentId: string) => { viewStudentProfile(studentId); navigate('student-profile'); };

  return (
    <main className="page portal-page branch-directory-page">
      <div className="portal-welcome branch-directory-hero">
        <div>
          <p className="eyebrow">Branch coordinator · {branchName || 'Loading branch…'}</p>
          <h1>Branch Student Overview</h1>
          <p>Students in your branch. Open any student's restricted profile for practice detail and progress.</p>
        </div>
      </div>

      {error && <div className="branch-directory-error" role="alert"><span>{error}</span><button onClick={() => window.location.reload()}>Retry</button></div>}

      <div className="branch-directory-card teacher-table">
        <div className="table-head"><span>Student</span><span>TR number</span><span>Joined</span><span>Profile</span></div>

        {loading ? (
          <div className="branch-directory-loading"><span className="branch-directory-spinner" />Loading branch students…</div>
        ) : rows.length === 0 ? (
          <div className="branch-directory-empty">
            <span className="branch-directory-empty-icon"><Users size={22} /></span>
            <strong>No students found in your branch.</strong>
            <p>Once students are assigned to this branch, they’ll appear here with their TR number and join date.</p>
          </div>
        ) : rows.map(s => (
          <div className="history-row branch-directory-row" key={s.id}>
            <span className="branch-directory-name"><strong>{s.name}</strong></span>
            <span>{s.tr_number ?? '—'}</span>
            <span>{new Date(s.created_at).toLocaleDateString()}</span>
            <Button outline onClick={() => openProfile(s.id)}>View profile</Button>
          </div>
        ))}
      </div>
    </main>
  );
}

export function TeacherNotifications() {
  return <AlertsPage />;
}
