// Mirror of khat-backend/src/v2/routes/deptChat.routes.ts (owner: chat). Keep in sync.
import type { Attachment } from '../contracts';

export type DeptMessage = {
  id: string;
  studentId: string;
  senderId: string;
  senderName: string;
  senderRole: 'student' | 'teacher' | 'admin' | 'system';
  kind: 'text' | 'files' | 'voice' | 'system';
  body: string | null;
  attachments: Attachment[];
  meta: Record<string, unknown>;
  createdAt: string;
  readByStudent: boolean;
  readByStaff: boolean;
};
export type DeptThreadSummary = {
  studentId: string; name: string; trNumber: string | null; className: string | null; branchId: string; branchName: string | null;
  lastAt: string | null; lastPreview: string | null; lastFromStudent: boolean; unread: number;
};
export type DeptListResponse =
  | { mode: 'student'; studentId: string; title: string; branchName: string | null; unread: number; lastAt: string | null; lastPreview: string | null }
  | { mode: 'staff'; title: string; threads: DeptThreadSummary[]; totalUnread: number };
export type DeptMessagesResponse = {
  title: string;
  student: { id: string; name: string; email: string; trNumber: string | null; className: string | null; branchName: string | null };
  messages: DeptMessage[];
  canWrite: boolean;
};
