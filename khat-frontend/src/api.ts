import type { Role } from './data/types';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  branchId: string;
  mustChangePassword?: boolean;
  isCoordinator?: boolean;
  avatarUrl?: string;
  avatar?: string;
  photoURL?: string;
};

export type UserNotification = {
  id: string;
  type: string;
  payload: Record<string, unknown> | string | null;
  read: boolean;
  created_at: string;
};

const TOKEN_KEY = 'khat_token';
const USER_KEY = 'khat_user';
export const PROFILE_PHOTO_UPDATED_EVENT = 'khat:profile-photo-updated';
export const NOTIFICATIONS_CHANGED_EVENT = 'khat:notifications-changed';
export const NOTIFICATION_RECEIVED_EVENT = 'khat:notification-received';

export function broadcastNotificationsChanged(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

export function broadcastNotificationReceived(notification: UserNotification): void {
  window.dispatchEvent(new CustomEvent<UserNotification>(NOTIFICATION_RECEIVED_EVENT, { detail: notification }));
}

export function broadcastProfilePhotoUpdated(photoUrl: string): void {
  window.dispatchEvent(new CustomEvent(PROFILE_PHOTO_UPDATED_EVENT, { detail: { photoUrl } }));
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getSessionUser(): SessionUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: SessionUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let activeApiRequestCount = 0;
const apiRequestListeners = new Set<(activeCount: number) => void>();

function notifyApiRequestListeners(): void {
  apiRequestListeners.forEach(listener => listener(activeApiRequestCount));
}

export function subscribeToApiRequests(listener: (activeCount: number) => void): () => void {
  apiRequestListeners.add(listener);
  listener(activeApiRequestCount);
  return () => apiRequestListeners.delete(listener);
}

export function getActiveApiRequestCount(): number {
  return activeApiRequestCount;
}

export async function trackApiRequest<T>(request: () => Promise<T>): Promise<T> {
  activeApiRequestCount += 1;
  notifyApiRequestListeners();
  try {
    return await request();
  } finally {
    activeApiRequestCount = Math.max(0, activeApiRequestCount - 1);
    notifyApiRequestListeners();
  }
}

/**
 * Every API call in the app should go through this. Attaches the JWT
 * automatically when present; throws ApiError with the backend's message on
 * any non-2xx response, so callers can just try/catch and show err.message.
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean; silent?: boolean } = {}
): Promise<T> {
  const { method = 'GET', body, auth = true, silent = false } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const request = async () => {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new ApiError(504, 'The server took too long to respond. Please check the backend and database connection, then try again.');
      }
      if (error instanceof TypeError) {
        throw new ApiError(0, `Could not reach the backend at ${API_BASE_URL}. Make sure it is running and try again.`);
      }
      throw error;
    }

    if (response.status === 204) return undefined as T;

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(response.status, (data as { error?: string }).error ?? 'Something went wrong');
    }
    return data as T;
  };

  return silent ? request() : trackApiRequest(request);
}

// ---- Presigned upload helper — used by every file-upload surface ----
export async function uploadFile(
  prefix: string,
  file: File
): Promise<{ storageKey: string; originalFilename: string }> {
  const contentType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
  const { storageKey, uploadUrl } = await apiFetch<{ storageKey: string; uploadUrl: string }>('/uploads/presign', {
    method: 'POST',
    body: { prefix, filename: file.name, contentType },
  });

  const putResponse = await trackApiRequest(() => fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file }));
  if (!putResponse.ok) throw new Error('Upload to storage failed');

  return { storageKey, originalFilename: file.name };
}

export async function getViewUrl(storageKey: string): Promise<string> {
  const { url } = await apiFetch<{ url: string }>(`/uploads/view?key=${encodeURIComponent(storageKey)}`);
  return url;
}

export async function getDownloadUrl(storageKey: string, filename: string): Promise<string> {
  const query = new URLSearchParams({ key: storageKey, download: 'true', filename });
  const { url } = await apiFetch<{ url: string }>(`/uploads/view?${query.toString()}`);
  return url;
}

export async function getFileObjectUrl(storageKey: string): Promise<string> {
  return trackApiRequest(async () => {
    const token = getToken();
    const response = await fetch(`${API_BASE_URL}/uploads/file?key=${encodeURIComponent(storageKey)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(response.status, (data as { error?: string }).error ?? 'Could not load the image file.');
    }
    return URL.createObjectURL(await response.blob());
  });
}
