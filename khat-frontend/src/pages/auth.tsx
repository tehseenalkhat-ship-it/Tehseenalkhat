import { useEffect, useState } from 'react';
import { ArrowRight, Camera, Check, ChevronDown, ChevronRight, Lock, LogIn, Palette, Settings, UserRound } from 'lucide-react';
import { navigate, Button, Logo } from '@/components/ui';
import { ProfilePhotoCropper } from '@/components/ProfilePhotoCropper';
import { THEME_OPTIONS, type ThemeName } from '@/theme';
import type { Role } from '@/data/types';
import jameaPhoto from '../public/jamea-photo2.jpeg';
import { apiFetch, saveSession, clearSession, getSessionUser, ApiError, getViewUrl, uploadFile, broadcastProfilePhotoUpdated } from '@/api';

const roleCards: { role: Role; label: string; desc: string; icon: string }[] = [
  { role: 'student', label: 'Student', desc: 'Learn calligraphy across three scripts, submit practice, and receive feedback.', icon: '✦' },
  { role: 'teacher', label: 'Faculty', desc: 'Review student entries, manage your showcase, and host live events.', icon: '✧' },
  { role: 'coordinator', label: 'Coordinator', desc: 'Monitor branch statistics and teacher activity for your branch.', icon: '◈' },
  { role: 'admin', label: 'Admin', desc: 'Full system control — courses, users, competitions, and governance.', icon: '◆' },
];

// The backend only knows student/teacher/admin — 'coordinator' is a teacher
// with isCoordinator=true. This maps a real login response to the frontend's
// four-way role, which drives which dashboard/nav shows up.
function resolveFrontendRole(user: { role: string; isCoordinator?: boolean }): Role {
  if (user.role === 'teacher' && user.isCoordinator) return 'coordinator';
  return user.role as Role;
}

function roleHomePage(role: Role): string {
  if (role === 'admin') return 'admin';
  if (role === 'teacher') return 'teacher-dashboard';
  if (role === 'coordinator') return 'coordinator-dashboard';
  return 'dashboard';
}

export function LandingRoleSelect() {
  return (
    <main className="landing-page reference-landing">
      <div 
        className="landing-photo" 
        style={{ backgroundImage: `url('${jameaPhoto}')` }}
        role="img" 
        aria-label="Al-Jamea-tus-Saifiyah campus architecture" 
      />
      <section className="landing-panel">
        <div className="landing-panel-brand">
          <span className="landing-seal" aria-hidden="true">
            <svg className="landing-seal-mark" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M43.6 12.9C41.4 11.8 38.9 13.2 36.8 16.9L24.1 39.4L29.5 42.5L44.1 21.3C46.7 17.6 46.2 14.2 43.6 12.9Z" fill="currentColor" />
              <path d="M24.1 39.4L20.7 46.1L29.5 42.5" fill="currentColor" />
              <path d="M18.2 47.3C25.6 48.3 33.7 45.9 40.5 41.6C44.1 39.3 47.3 36.7 50.8 34.9C46.5 35.3 42.2 37.8 38.6 40.1C32 44.2 25.1 46.8 18.2 47.3Z" fill="currentColor" />
              <path d="M46.3 20.7L49.2 17.8L52.1 20.7L49.2 23.6L46.3 20.7Z" fill="currentColor" />
            </svg>
          </span>
          <Logo />
        </div>
        <p className="landing-panel-kicker">Tehseen al-khat Studio</p>
        <h1>Welcome to your learning path.</h1>
        <p className="landing-panel-copy">Choose your place in the guild to continue.</p>
        <div className="role-card-grid">
          {roleCards.map(card => (
            <button key={card.role} className="reference-role-card" onClick={() => navigate(`login-${card.role}`)}>
              <span className="reference-role-icon">{card.icon}</span>
              <span className="reference-role-label">{card.label}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>
        <p className="landing-panel-note"><LogIn size={14} /> Every role begins with sign in. Students can create an account from the login page.</p>
      </section>
    </main>
  );
}

export function Auth({ signup = false, initialRole = 'student' }: { signup?: boolean; initialRole?: Role }) {
  const [role, setRole] = useState<Role>(initialRole);
  const [roleMenuOpen, setRoleMenuOpen] = useState(false);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);

  // Login fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // Signup-only fields
  const [trNumber, setTrNumber] = useState('');
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [photoName, setPhotoName] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (signup) {
      apiFetch<{ id: string; name: string }[]>('/branches', { auth: false })
        .then(setBranches)
        .catch(() => setError('Could not load branches — check your connection and try again.'));
    }
  }, [signup]);

  const handleLogin = async () => {
    setError(null);
    if (!email || !password) { setError('Enter your email and password.'); return; }
    setBusy(true);
    try {
      const result = await apiFetch<{ token: string; user: { id: string; name: string; email: string; role: string; mustChangePassword: boolean; isCoordinator?: boolean } }>(
        '/auth/login',
        { method: 'POST', body: { email, password }, auth: false }
      );
      const frontendRole = resolveFrontendRole(result.user);
      saveSession(result.token, { ...result.user, role: frontendRole } as never);
      navigate(result.user.mustChangePassword ? 'forced-password' : roleHomePage(frontendRole));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSignup = async () => {
    setError(null);
    if (!trNumber || !name || !email || !password || !branchId) { setError('Please fill in every field.'); return; }
    if (!/^[^\s@]+@jameasaifiyah\.edu$/i.test(email.trim())) { setError('Enter your Jamea Saifiyah .edu email address.'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      // Photo upload is intentionally not wired yet — presigned uploads require
      // an authenticated session, which doesn't exist until signup completes.
      // Once a dedicated "update my photo" endpoint exists, this becomes a
      // second step right after the account is created below.
      const result = await apiFetch<{ token: string; user: { id: string; name: string; email: string; role: string } }>(
        '/auth/signup',
        { method: 'POST', body: { trNumber: trNumber.toUpperCase(), name, email, password, branchId }, auth: false }
      );
      saveSession(result.token, { ...result.user, role: 'student' } as never);
      navigate('student-landing');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Signup failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-art">
        <Logo />
        <div>
          <p className="eyebrow">{signup ? 'Student signup' : 'Welcome back'}</p>
          <h1>{signup ? 'Begin your path.' : 'Sign in to the Studio.'}</h1>
          <p>{signup ? 'Your TR number connects you to your learning record. Only students create accounts here.' : 'Faculty, coordinators, and admins use pre-created credentials. Students, sign in here too.'}</p>
        </div>
        <div className="auth-quote">"The secret of beautiful writing is beautiful intention."</div>
      </div>
      <div className="auth-form">
        <div className="auth-form-inner">
          <p className="eyebrow"><UserRound size={13} /> {signup ? 'Create student account' : `${roleCards.find(card => card.role === role)?.label ?? 'Account'} sign in`}</p>
          {!signup && (
            <label className="field-label">I am a...
              <span className={`auth-role-picker${roleMenuOpen ? ' open' : ''}`}>
                <button type="button" className="auth-role-trigger" aria-haspopup="listbox" aria-expanded={roleMenuOpen} onClick={() => setRoleMenuOpen(value => !value)}>
                  <span>{roleCards.find(card => card.role === role)?.label ?? 'Student'}</span><ChevronDown size={15} />
                </button>
                {roleMenuOpen && <span className="auth-role-menu" role="listbox" aria-label="Choose account type">
                  {roleCards.map(card => <button type="button" role="option" aria-selected={role === card.role} className={role === card.role ? 'selected' : ''} key={card.role} onClick={() => { setRole(card.role); setRoleMenuOpen(false); }}>{card.label}</button>)}
                </span>}
              </span>
            </label>
          )}
          {signup && (
            <>
              <label className="field-label">TR number
                <input className="field" value={trNumber} onChange={e => setTrNumber(e.target.value)} placeholder="e.g. 20481" />
              </label>
              <label className="field-label">Full name<input className="field" value={name} onChange={e => setName(e.target.value)} placeholder="Your name" /></label>
              <label className="field-label">Photo
                <div className="photo-upload-row">
                  <label className="upload-box compact">
                    <span className="upload-mini-label">{photoName ? <><Check size={18} /><strong>{photoName}</strong></> : <span>Upload photo</span>}</span>
                    <input type="file" accept="image/*" onChange={e => { const f = e.target.files?.[0] ?? null; setPhotoName(f?.name ?? null); }} />
                  </label>
                </div>
              </label>
              <label className="field-label">Jamea branch
                <select className="field" value={branchId} onChange={e => setBranchId(e.target.value)}>
                  <option value="">Select your branch</option>
                  {branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                </select>
              </label>
            </>
          )}
          <label className="field-label">{signup ? 'Email' : 'Email'}<input className="field" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder={signup ? '@jameasaifiyah.edu' : '@jameasaifiyah.edu'} />{signup && <small className="auth-email-note">Enter your Jamea Saifiyah .edu email.</small>}</label>
          <label className="field-label">Password<input className="field" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" /></label>
          {signup && <label className="field-label">Confirm password<input className="field" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter password" /></label>}
          {error && <small className="error-text">{error}</small>}
          <Button onClick={signup ? handleSignup : handleLogin}>
            {busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'} <ArrowRight size={16} />
          </Button>
          <p className="auth-switch">
            {signup ? 'Already have an account?' : 'New student?'}{' '}
            <button onClick={() => navigate(signup ? 'login-student' : 'signup')}>
              {signup ? 'Sign in' : 'Create student account'}
            </button>
          </p>
          <p className="auth-switch"><button onClick={() => navigate('forgot-password')}>Forgot your password?</button></p>
          {!signup && <p className="auth-note"><Lock size={13} /> New students are required to create an account before signing in.</p>}
        </div>
      </div>
    </main>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await apiFetch('/auth/forgot-password', { method: 'POST', body: { email }, auth: false });
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-art">
        <Logo />
        <div><p className="eyebrow">Forgot password</p><h1>Reset your password.</h1><p>Enter the email on your account — we'll send a reset link if it's registered.</p></div>
      </div>
      <div className="auth-form">
        <div className="auth-form-inner">
          {sent ? (
            <p>If that email is registered, a reset link is on its way. Check your inbox (and the server console, if email sending isn't configured yet).</p>
          ) : (
            <>
              <label className="field-label">Email<input className="field" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
              <Button onClick={submit}>{busy ? 'Sending…' : 'Send reset link'} <ArrowRight size={16} /></Button>
            </>
          )}
          <p className="auth-switch"><button onClick={() => navigate('login-student')}>Back to sign in</button></p>
        </div>
      </div>
    </main>
  );
}

export function ResetPassword() {
  const [newPassword, setNewPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('token') ?? '';

  const submit = async () => {
    setError(null);
    try {
      await apiFetch('/auth/reset-password', { method: 'POST', body: { token, newPassword }, auth: false });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-art"><Logo /><div><p className="eyebrow">Reset password</p><h1>Set a new password.</h1></div></div>
      <div className="auth-form">
        <div className="auth-form-inner">
          {done ? (
            <p className="auth-switch">Password updated. <button onClick={() => navigate('login-student')}>Sign in →</button></p>
          ) : (
            <>
              <label className="field-label">New password<input className="field" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" /></label>
              {error && <small className="error-text">{error}</small>}
              <Button onClick={submit}>Set new password</Button>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

export function ForcedPasswordChange() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (newPassword !== confirmPassword) { setError('New passwords do not match.'); return; }
    setBusy(true);
    try {
      await apiFetch('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      const user = getSessionUser();
      setDone(true);
      if (user) setTimeout(() => navigate(roleHomePage(user.role)), 800);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-art">
        <Logo />
        <div>
          <p className="eyebrow">First login</p>
          <h1>Set a new password.</h1>
          <p>For security, your temporary password must be changed before you can continue.</p>
        </div>
        <div className="auth-quote">"The first stroke is always the hardest — and the most important."</div>
      </div>
      <div className="auth-form">
        <div className="auth-form-inner">
          <p className="eyebrow"><Lock size={13} /> Security requirement</p>
          <h1>Change your password</h1>
          <p>This is your first login. Please set a permanent password to continue.</p>
          <label className="field-label">Temporary password<input className="field" type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} placeholder="Provided by admin" /></label>
          <label className="field-label">New password<input className="field" type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder="At least 8 characters" /></label>
          <label className="field-label">Confirm new password<input className="field" type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Re-enter new password" /></label>
          {error && <small className="error-text">{error}</small>}
          <Button onClick={submit}>{busy ? 'Please wait…' : done ? 'Password changed' : 'Set new password'} {done && <Check size={16} />}</Button>
          {done && <p className="auth-switch">Password updated. Redirecting…</p>}
        </div>
      </div>
    </main>
  );
}

export function SettingsPage({ role, theme, onThemeChange }: { role: Role; theme: ThemeName; onThemeChange: (theme: ThemeName) => void }) {
  const label = role === 'teacher' ? 'Faculty' : role[0].toUpperCase() + role.slice(1);
  const user = getSessionUser();
  const userId = user?.id;
  const userEmail = user?.email ?? '';
  const userBranchId = user?.branchId ?? '';
  const supportsProfilePhoto = role === 'student' || role === 'teacher' || role === 'coordinator' || role === 'admin';
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<{ email: string; trNumber?: string | null; branchName?: string } | null>(null);

  useEffect(() => {
    if (!userId) return;

    const profilePath = role === 'student'
      ? `/students/${userId}/profile`
      : role === 'teacher' || role === 'coordinator'
        ? `/teachers/${userId}/profile`
        : role === 'admin' ? '/admin/users/me/profile' : null;

    if (profilePath) {
      apiFetch<{
        email?: string;
        trNumber?: string | null;
        branchId?: string;
        photoStorageKey?: string | null;
        photo_storage_key?: string | null;
      }>(profilePath).then(async profile => {
        const branches = await apiFetch<{ id: string; name: string }[]>('/branches');
        const branchId = profile.branchId ?? userBranchId;
        setInfo({
          email: profile.email ?? userEmail,
          trNumber: role === 'student' ? profile.trNumber : undefined,
          branchName: branches.find(branch => branch.id === branchId)?.name,
        });
        const photoKey = profile.photoStorageKey ?? profile.photo_storage_key;
        if (photoKey) setPhotoUrl(await getViewUrl(photoKey));
      }).catch(() => {
        if (role !== 'student') setInfo({ email: userEmail });
      });
    }
  }, [userId, userEmail, userBranchId, role]);

  const uploadPhoto = async (croppedFile: File) => {
    if (!user) return;
    setUploading(true);
    setError(null);
    try {
      const { storageKey } = await uploadFile('profile-photos', croppedFile);
      const photoPath = role === 'student'
        ? `/students/${user.id}/photo`
        : role === 'admin' ? '/admin/users/me/photo' : `/teachers/${user.id}/photo`;
      await apiFetch(photoPath, { method: 'PATCH', body: { photoStorageKey: storageKey } });
      const nextPhotoUrl = await getViewUrl(storageKey);
      setPhotoUrl(nextPhotoUrl);
      broadcastProfilePhotoUpdated(nextPhotoUrl);
      setPhotoFile(null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to update photo.');
    } finally {
      setUploading(false);
    }
  };

  const logout = () => { clearSession(); navigate('landing'); };
  const dashboardPage = role === 'admin' ? 'admin' : role === 'teacher' ? 'teacher-dashboard' : role === 'coordinator' ? 'coordinator-dashboard' : 'dashboard';

  return (
    <main className="page settings-page">
      <div className="settings-card">
        <p className="eyebrow"><Settings size={13} /> Account settings</p>
        <h1>{label} settings</h1>
        <p>Manage your account preferences and access controls from one place.</p>

        {supportsProfilePhoto && (
          <section className="settings-photo-panel" aria-label="Profile photo settings">
            <div className="settings-photo-preview">
              {photoUrl ? <img src={photoUrl} alt="Your current profile" /> : <UserRound size={28} strokeWidth={1.5} />}
            </div>
            <div className="settings-photo-copy">
              <span className="settings-photo-kicker">Your profile</span>
              <strong>Profile photo</strong>
              <p>Make it yours. Your photo appears beside your name across the site.</p>
              <label className="settings-photo-choose">
                <Camera size={15} /> Choose a photo
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={event => {
                    const selected = event.currentTarget.files?.[0];
                    if (selected) {
                      setError(null);
                      setPhotoFile(selected);
                    }
                    event.currentTarget.value = '';
                  }}
                />
              </label>
              <small className="settings-photo-format">JPG, PNG or WebP · drag and zoom to crop</small>
            </div>
          </section>
        )}
        <section className="settings-theme-section" aria-labelledby="settings-theme-title">
          <div className="settings-theme-heading">
            <span><Palette size={14} /> Appearance</span>
            <h2 id="settings-theme-title">Choose your theme</h2>
            <p>Give your workspace a color palette that feels like yours.</p>
          </div>
          <div className="settings-theme-grid" role="group" aria-label="Choose a site theme">
            {THEME_OPTIONS.map(option => {
              const selected = theme === option.id;
              return (
                <button
                  type="button"
                  key={option.id}
                  className={`settings-theme-option theme-option-${option.id}${selected ? ' selected' : ''}`}
                  onClick={() => onThemeChange(option.id)}
                  aria-pressed={selected}
                  aria-label={`${option.label} theme${selected ? ', selected' : ''}`}
                >
                  <span className="settings-theme-swatch" aria-hidden="true">
                    {option.colors.map((color, index) => <i key={index} style={{ backgroundColor: color }} />)}
                    {selected && <span className="settings-theme-check"><Check size={12} /></span>}
                  </span>
                </button>
              );
            })}
          </div>
          <small className="settings-theme-note">Theme preference is saved separately for each account on this device.</small>
        </section>
        {error && <p className="error-text">{error}</p>}

        <div className="settings-row"><div><strong>Account role</strong><small>{label} workspace</small></div><span className="chip chip-blue">Active</span></div>
        {info && (
          <>
            <div className="settings-row"><div><strong>Email</strong><small>{info.email}</small></div></div>
            {info.trNumber && <div className="settings-row"><div><strong>TR number</strong><small>{info.trNumber}</small></div></div>}
            {info.branchName && <div className="settings-row"><div><strong>Branch</strong><small>{info.branchName}</small></div></div>}
          </>
        )}
        <div className="settings-row"><div><strong>Password</strong><small>Update your sign-in password</small></div><button className="text-link" onClick={() => navigate('forced-password')}>Change password <ArrowRight size={14} /></button></div>
        <div className="settings-row"><div><strong>Notifications</strong><small>Manage which alerts you receive by email</small></div><span className="muted">Coming soon</span></div>

        <div className="settings-actions"><Button outline onClick={logout}>Log out</Button><Button onClick={() => navigate(dashboardPage)}>Back to dashboard <ArrowRight size={15} /></Button></div>
      </div>
      {photoFile && (
        <ProfilePhotoCropper
          file={photoFile}
          saving={uploading}
          error={error}
          onCancel={() => { if (!uploading) { setPhotoFile(null); setError(null); } }}
          onSave={uploadPhoto}
        />
      )}
    </main>
  );
}
