import { useState } from 'react';
import { BookOpenCheck, ChevronDown } from 'lucide-react';

const KEY = 'khat.v3.builderGuideOpen';

const STEPS: { title: string; text: string }[] = [
  { title: 'Make the course', text: 'Import your Master Course List (every row becomes a Draft course), or press “New course”. Choose the kind: Certification course, Crash course or Mashq worksheets.' },
  { title: 'Check the details', text: 'Open the course → Details: course name in English letters, Arabic name, pen, mistar sizes and branches.' },
  { title: 'Add the files', text: 'Drop files, a folder or a ZIP named like FNK-C101_MT_LV01_S01_P01_07_v1.jpg — levels and steps build themselves. Or add a level and a step by hand.' },
  { title: 'Fill each step', text: 'Open a step (the arrow on the right): task name, a YouTube video link, the reference image, the worksheet for each mistar size and, for assessments, the assessment sheet.' },
  { title: 'Choose the badges', text: 'For each level pick a badge design from the drop-down. Upload the artwork once under “Badge designs”.' },
  { title: 'Check the course map', text: 'The Course map shows every level, step and what is inside it. Red marks mean something is missing — the Health tab says exactly what.' },
  { title: 'See it as a student', text: 'Press “View as student”. When you are done, press “Back to admin view” at the bottom of the screen.' },
  { title: 'Publish', text: 'Set the course to Published. If something important is missing, the builder tells you what to fix first. When every level is ready, switch on “Course complete — certificate can be given”.' },
];

/** "How to build a course" — a short guide inside the builder (owner note 6.7). */
export function BuilderGuide() {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) !== '0');
  const toggle = () => { setOpen(o => { localStorage.setItem(KEY, o ? '0' : '1'); return !o; }); };
  return (
    <section className={`v3-guide${open ? ' is-open' : ''}`}>
      <button type="button" className="v3-guide-head" aria-expanded={open} onClick={toggle}>
        <BookOpenCheck size={18} aria-hidden="true" />
        <span><strong>How to build a course</strong><small>Eight simple steps, from the master list to the certificate</small></span>
        <ChevronDown size={18} className="v3-guide-chev" aria-hidden="true" />
      </button>
      {open && (
        <ol className="v3-guide-steps">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <span className="v3-guide-no" aria-hidden="true">{i + 1}</span>
              <div><strong>{s.title}</strong><p>{s.text}</p></div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
