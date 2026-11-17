import { V3GalleryPage } from '@/v2/content/GalleryPage';
import { pastCompetitionWinners, type GalleryWork } from '@/data/mock';

// v3 notes 1.9 / E / 4.2: reference work + distinct, branch-specific student and teacher showcases.
export function Gallery() {
  return <V3GalleryPage />;
}

export { pastCompetitionWinners };
export type { GalleryWork };
