import { useEffect } from 'react';
import { PenLoader } from '@/components/ui';

/**
 * v3 audit: the old Mashq worksheet page (it showed "collection is not set up yet") is retired.
 * Mashq worksheets are now ordinary courses of the kind "Mashq worksheets" on the Courses page,
 * so any old link to #mashq simply lands there.
 */
export function MashqWorksheets() {
  useEffect(() => { window.location.replace('#catalog'); }, []);
  return <PenLoader label="Opening Mashq worksheets…" />;
}
