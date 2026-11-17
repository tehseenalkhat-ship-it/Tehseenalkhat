// v3 content — copy of khat-backend/src/v2/routes/contentTypes.ts (keep identical).

export type GalleryWork = {
  id: string; title: string; calligrapher: string | null; script: string | null; note: string | null;
  imageStorageKey: string; branchId: string | null; branchName: string | null; uploadedByName: string | null;
  createdAt: string; canEdit: boolean;
};

export type ShowcaseItem = {
  id: string; role: 'student' | 'teacher'; authorId: string; authorName: string; branchName: string | null;
  imageStorageKey: string; caption: string | null; question: string | null; timeMinutes: number | null;
  awardLabel: string | null; source: string | null; status: string; likes: number; likedByMe: boolean; createdAt: string;
};

export type ShowcaseFeed = { items: ShowcaseItem[]; total: number; page: number; pageSize: number; branchName: string | null };

export type LibraryBook = {
  id: string; title: string; author: string | null; language: string | null; description: string | null;
  khatTypeId: string | null; scriptName: string | null; fileStorageKey: string; originalFilename: string | null; createdAt: string;
};

export type OlderCourse = {
  id: string; title: string; description: string | null; kind: 'Certification course' | 'Crash course';
  scriptName: string | null; levelCount: number; firstLevelId: string | null; enrolled: boolean;
  percentComplete: number; currentLevelIndex: number | null;
};
