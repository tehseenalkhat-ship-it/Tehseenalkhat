import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import type { AuthUser } from '../plugins/auth.js';

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type ChatBody = { messages: ChatMessage[] };

type CourseSummary = {
  title: string;
  category: string;
  script: string;
  description: string | null;
  levelCount: number;
};

function safeMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ChatMessage>;
  return (message.role === 'user' || message.role === 'assistant')
    && typeof message.content === 'string'
    && message.content.trim().length > 0
    && message.content.length <= 2000;
}

function contains(text: string, terms: string[]): boolean {
  return terms.some(term => text.includes(term));
}

function isAcknowledgment(text: string): boolean {
  return /^(thanks?|thank you|thankyou|thx|ty|got it|great thanks|okay thanks|ok thanks|many thanks|appreciate it|that helps|perfect)[!.\s🙏🙂😊]*$/i.test(text.trim());
}

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening|salaam|salam|assalamu alaikum|as salaam alaikum)(?:[,\s]+(?:there|guild guide|how are you|how are you doing))?[!.,?\s👋🙂😊]*$/i.test(text.trim());
}

function localFallbackReply(messages: ChatMessage[], courses: CourseSummary[], learner: Record<string, unknown> | null, name = 'there'): string {
  const lastUserRaw = [...messages].reverse().find(message => message.role === 'user')?.content.trim() ?? '';
  const lastUserMessage = lastUserRaw.toLowerCase();
  const normalized = lastUserMessage.replace(/[’']/g, '').replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const assessmentPromptIndex = messages.findIndex(message => message.role === 'assistant' && message.content.includes('quick placement check'));
  const userAnswers = assessmentPromptIndex < 0
    ? 0
    : messages.slice(assessmentPromptIndex + 1).filter(message => message.role === 'user').length;
  const placementComplete = assessmentPromptIndex >= 0 && messages.slice(assessmentPromptIndex + 1)
    .some(message => message.role === 'assistant' && (message.content.includes('recommend starting with') || message.content.includes('continue with **')));

  if (isAcknowledgment(lastUserMessage)) {
    return 'You’re welcome! I’m here if you’d like to explore a calligraphy concept, ask about a lesson, or get help with another part of the site.';
  }

  if (isGreeting(lastUserRaw)) {
    return `Hello${name && name !== 'there' ? `, ${name.split(' ')[0]}` : ''}! I’m Guild Guide. I can help you navigate the Studio, understand your course and checkpoints, or explore Arabic calligraphy. What would you like to know?`;
  }

  if (/^(who are you|what are you|what is your name|whats your name|what can you do|how can you help|help|help me|what do you know)$/.test(normalized)) {
    return 'I’m Guild Guide, the built-in helper for the Calligraphy Guild Learning Platform. I can explain how to use Courses, practice uploads, checkpoints, reviews, certificates, events, and other site features; help you think through a course choice; and share general Arabic-calligraphy concepts and practice ideas. I can’t see your artwork unless it is uploaded into a feature that gives it to me, and I can’t change account records or replace your teacher’s guidance.';
  }

  if (/^(how are you|how are you doing|how is it going|hows it going)$/.test(normalized)) {
    return `I’m doing well and ready to help${name ? `, ${name.split(' ')[0]}` : ''}! Would you like help with your course, the site, or an Arabic-calligraphy question?`;
  }

  if (/^(bye|goodbye|see you|see you later|take care|good night)$/.test(normalized)) {
    return 'Goodbye! Keep enjoying the practice, and come back whenever you have a question about a lesson, the Studio, or calligraphy.';
  }

  if (/^(sorry|i am sorry|im sorry|my apologies)$/.test(normalized)) {
    return 'No worries at all. Ask in whatever way is comfortable; if I misunderstand, you can rephrase and I’ll try again.';
  }

  if (contains(normalized, ['what is this site', 'what is this website', 'about this site', 'about this website', 'what is the studio', 'what is calligraphy guild'])) {
    return 'This is the Calligraphy Guild Learning Platform, a learning space for Arabic calligraphy. Students can study separate certification paths, work through practice levels, submit teacher-reviewed checkpoints, explore optional secondary courses, find shared resources, join events, and keep track of progress and achievements. Teachers review checkpoint work and support students; administrators manage the curriculum and platform. The course catalog is the source of truth for which paths and lessons are currently available.';
  }

  if (contains(normalized, ['motivate me', 'motivation', 'encourage me', 'i feel discouraged', 'i feel stuck', 'i want to quit', 'i am frustrated', 'im frustrated', 'i am bad at', 'im bad at'])) {
    return 'Every careful line is practice, even the one you would not frame. Calligraphy grows through attention and repetition, not through perfect pages on the first try. Make today’s goal small: choose one letter or stroke, write it slowly a few times, notice one thing that improved, and stop before frustration turns practice into a race. Your progress is the work you return to. Would a short practice plan or help with a particular letter be useful?';
  }

  if (contains(normalized, ['how much should i practice', 'how long should i practice', 'practice everyday', 'practice every day', 'daily practice', 'practice per day', 'how many hours should i practice'])) {
    return 'A manageable starting point is 15–30 focused minutes on most days, adjusted to your schedule and comfort. For example: 3 minutes of warm-up strokes, 8–15 minutes on one letter or connection, then 3–5 minutes comparing your work with the lesson reference and noting one next step. Stop if your hand becomes strained; consistency and attention matter more than long sessions. Follow any course-specific practice guidance from your teacher.';
  }

  if (contains(normalized, ['i missed a day', 'missed practice', 'practice streak', 'lost my streak', 'behind in course', 'falling behind'])) {
    return 'Missing a day does not erase what you have learned. Pick up with a short, comfortable session rather than trying to “make up” every missed minute. Open **Dashboard** to see your course progress, then continue with the next available level when you are ready.';
  }

  if (contains(normalized, ['signup', 'sign up', 'create account', 'register', 'tr number', 'registration number', 'edu email'])) {
    return 'Student signup requires an available TR number that has been added by an administrator and a Jamea Saifiyah email ending in **@jameasaifiyah.edu**. Enter the TR number, your details, and your branch on the signup page. If your TR number is not recognized, has already been used, or is assigned to another branch, contact your administrator; Guild Guide cannot add or activate TR numbers.';
  }

  if (contains(normalized, ['certificate', 'certificates', 'achievement', 'achievements', 'badge', 'badges', 'award'])) {
    return 'Open **Achievements** from the student navigation to see your approved certificates, earned script badges, and published competition awards. Your **Profile** also shows your certificates and links to the full archive. A certificate only appears after it has been issued and approved; if you have just completed a milestone, allow time for the approval workflow.';
  }

  if (contains(normalized, ['normal pen', 'ordinary pen', 'ballpoint', 'biro', 'cut pen', 'qalam pen', 'reed pen course', 'which pen'])) {
    return 'The platform has a separate **Naskh (Normal Pen)** certification path for an ordinary pen, distinct from **Naskh** practised with a cut qalam. The other certification paths are **Sulus (Thuluth)** and **Nastaaleeq**, taught with the cut-pen approach. Choose the tool you actually want to practise with; nib angle, stroke contrast, and course materials differ, so do not assume cut-qalam instructions transfer unchanged to an ordinary pen.';
  }

  if (contains(normalized, ['what is arabic calligraphy', 'what is khat', 'meaning of khat', 'what is calligraphy'])) {
    return 'Arabic calligraphy is the art and disciplined practice of shaping Arabic writing through letter form, proportion, connection, rhythm, spacing, and composition. “Khaṭṭ” (خط) is commonly used for writing or calligraphic script. It is both a way to make writing legible and a visual art with many scripts, teachers, and regional traditions.';
  }

  if (contains(normalized, ['right to left', 'which direction', 'writing direction', 'arabic direction'])) {
    return 'Arabic is written from right to left. In calligraphy, the direction of the text is only one part of the design: each letter’s entry and exit strokes, connections, spacing, and position on the writing line all contribute to a balanced word. Follow the direction and joins shown in your lesson reference.';
  }

  if (contains(normalized, ['non joining', 'non-joining', 'do not join', 'dont join', 'letters dont connect', 'letters do not connect'])) {
    return 'Some Arabic letters do not connect to the following letter in the normal written sequence. A common group is ا د ذ ر ز و (alif, dal, dhal, ra, zay, waw). They can still connect from a preceding letter where applicable. Check the particular letter pair and its context in your course reference, since the visible word shape depends on position.';
  }

  if (contains(normalized, ['harakat', 'diacritic', 'vowel mark', 'vowels in arabic', 'tashkil', 'tashkeel'])) {
    return 'Harakāt are short-vowel and pronunciation marks placed around Arabic letters; examples include fatḥa, kasra, and ḍamma. They are distinct from the letter bodies and should be placed clearly without disrupting the word’s visual balance. Your current lesson may specify how marks are shaped and positioned in its script style.';
  }

  if (contains(normalized, ['ink', 'paper', 'which paper', 'paper type', 'ink flow', 'ink blob', 'ink smudge'])) {
    return 'Use a smooth, stable writing surface and ink that flows consistently with your tool. Test the pen on scrap paper first, keep the nib clean, and avoid changing ink, paper, angle, and pressure all at once while troubleshooting. Drying time and paper absorbency matter; follow your teacher’s material recommendations for the course.';
  }

  if (contains(normalized, ['composition', 'layout', 'balance a page', 'design a page', 'spacing', 'negative space'])) {
    return 'A balanced composition considers the text’s proportions, line length, spacing, margins, visual weight, and the empty space around the writing. Start by planning a light layout and keeping the text readable; adjust one element at a time rather than squeezing letters to fill every gap. Script-specific rules and your teacher’s examples should guide the final arrangement.';
  }

  if (contains(normalized, ['history of', 'where did calligraphy begin', 'origin of calligraphy', 'who invented arabic calligraphy'])) {
    return 'Arabic calligraphy developed over many centuries across different regions, communities, materials, and teaching traditions; it does not have one single inventor or one simple point of origin. Scripts changed as writing needs and artistic practices changed. If you are studying a particular script, I can give a brief overview while keeping historical claims appropriately qualified.';
  }

  if (contains(normalized, ['what is naskh', 'tell me about naskh'])) {
    return 'Naskh is a widely used Arabic script known for a clear, balanced rhythm and forms suited to readable text. Its proportions and stroke treatment vary by school and tool. On this platform, **Naskh** is the cut-qalam path; **Naskh (Normal Pen)** is a separate path for ordinary-pen practice.';
  }
  if (contains(normalized, ['what is sulus', 'what is thuluth', 'tell me about sulus', 'tell me about thuluth'])) {
    return 'Sulus, also called Thuluth, is recognized for its expressive, sweeping forms, strong verticals, and use in prominent titles and architectural or decorative settings. It requires its own proportions and rhythm; do not copy Naskh measurements into it. The platform lists it as **Sulus (Thuluth)**.';
  }
  if (contains(normalized, ['what is nastaaleeq', 'what is nastaliq', 'tell me about nastaaleeq', 'tell me about nastaliq'])) {
    return 'Nastaaleeq is known for a flowing, often sloping rhythm and is especially associated with Persian and Urdu calligraphic traditions. Its balance and letter relationships are distinctive, so use the Nastaaleeq lesson references rather than applying proportions from Naskh or Sulus.';
  }

  if (contains(normalized, ['normal pen course', 'naskh normal pen'])) {
    const course = courses.find(item => item.category === 'certification' && /normal pen/i.test(`${item.title} ${item.script}`));
    return course
      ? `The catalog includes **${course.title}**, a separate Naskh certification path for ordinary-pen practice. Open **Courses**, choose **Naskh · Normal pen**, and start at the first available level. The course catalog shows the current lessons and checkpoints.`
      : 'The platform is designed to offer Naskh with an ordinary pen as a path separate from cut-qalam Naskh. Open **Courses** to check the live catalog; if the path is not available there yet, ask your administrator about its setup.';
  }

  if (contains(normalized, ['how do checkpoints work', 'what is a checkpoint', 'checkpoint test', 'test level', 'why checkpoint'])) {
    return 'A checkpoint is a teacher-reviewed test level in a certification course. Regular practice levels unlock immediately when practice is submitted; checkpoint levels are reviewed by a teacher, who records a pass or asks for a redo with feedback. Later course levels stay locked until the checkpoint is passed. Open **Courses** and select the marked test level when it becomes available.';
  }

  if (contains(normalized, ['where is my lesson', 'next lesson', 'continue my course', 'course progress', 'my progress'])) {
    return learner?.currentCourse
      ? `Your current certification course is **${String(learner.currentCourse)}**. Open **Dashboard** to see its progress and next level, or **Courses** to view its full level list. A locked checkpoint needs a passing teacher review before later levels unlock.`
      : 'Open **Dashboard** to see enrolled course progress, or **Courses** to browse certification paths and secondary lessons. If you are not enrolled yet, choose a course and use its enrollment option; the catalog shows which levels are available.';
  }

  if (contains(normalized, ['where can i find resources', 'resource library', 'books', 'practice sheets', 'download sheets'])) {
    return 'Open **Resources** for shared books and reference material. Inside a course level, look for its reference files and practice-sheet controls; administrators add those materials in Course Builder. If a resource or sheet is missing, ask your teacher or administrator.';
  }

  if (contains(normalized, ['notification', 'notifications', 'email me', 'email notification'])) {
    return 'In-site alerts are available from **Notifications**. The account email is collected for specialized communications, but Guild Guide cannot change notification preferences or promise that a particular email will be sent. Check your notification settings and the information provided by the platform administrators.';
  }

  if (contains(normalized, ['profile', 'my profile'])) {
    return 'Open **My Profile** from your account menu to review your student details, course progress, practice uploads, and practice rhythm. Use **Achievements** for approved certificates, badges, and published competition awards.';
  }

  if (contains(normalized, ['showcase', 'share my work', 'gallery'])) {
    return 'Use **My showcase** to share a finished exercise or a moment from your practice desk. Add a clear image and optional caption. Your submitted post follows the moderation status shown in the Showcase area; it is separate from private checkpoint submissions.';
  }

  if (contains(normalized, ['competition', 'competitions', 'contest'])) {
    return 'Open **Competitions** to see current challenges, deadlines, and how to submit an entry. Results and winning pieces appear after administrators publish them. Published placements are also collected in **Achievements**.';
  }

  if (contains(normalized, ['how do i host an event', 'host a live event', 'join an event', 'live event', 'recording'])) {
    return 'Students can open **Events** to see upcoming sessions, join a live event, and watch recordings when available. Teachers can open **Host events** to schedule and run a session; camera and microphone access may be needed for hosting. If an event is missing or its recording is still processing, contact its host or an administrator.';
  }

  if (contains(normalized, ['thumb pain', 'wrist pain', 'hand pain', 'hand tired', 'cramp', 'ergonomic'])) {
    return 'Pause if your hand, wrist, or shoulder becomes painful or numb. Keep the page and grip comfortable, relax unnecessary tension, and take short breaks. Do not force through pain; if discomfort persists, stop practising and seek appropriate health advice.';
  }

  if (contains(normalized, ['letter proportions', 'how to improve letters', 'my letters look', 'uneven letters', 'inconsistent letters'])) {
    return 'Choose one letter and compare the same features each time: height, width, angle, joins, and relation to the writing line. Make a few slow repetitions at one consistent size, then circle one difference to work on next. Use your script’s own model—proportions are not interchangeable between Naskh, Sulus, and Nastaaleeq.';
  }

  if (contains(normalized, ['what should i practice', 'practice exercise', 'give me an exercise', 'warm up'])) {
    return 'Try this short warm-up: make a row of slow vertical strokes, a row of horizontal strokes, then a row of gentle curves. Keep their size and spacing as consistent as you can. Next, practise one letter from your current lesson and compare it with the reference. If you tell me your script and level, I can suggest a more focused exercise.';
  }

  if (contains(normalized, ['hold the pen', 'hold a qalam', 'grip the pen', 'pen grip', 'pen angle', 'how to hold'])) {
    return 'Aim for a relaxed, repeatable grip that lets the nib meet the page at the angle shown in your course reference. Avoid squeezing; support the movement with a comfortable hand and arm position. With a cut qalam, the nib’s cut and orientation affect stroke contrast, so follow your teacher’s demonstration. With an ordinary pen, use the course’s normal-pen guidance rather than trying to imitate a reed nib exactly.';
  }

  if (contains(normalized, ['critique my work', 'check my work', 'is my work good', 'look at my writing', 'rate my calligraphy'])) {
    return 'I can’t see an image unless you provide it through a feature that makes it available, and this chat does not currently attach artwork for critique. You can compare your page against the lesson reference for proportion, spacing, joins, baseline, and consistency, then submit checkpoint work for teacher review. A teacher can give course-specific feedback on your actual sheet.';
  }

  if (contains(normalized, ['what is a dot', 'rhombic dot', 'dot unit', 'measure letters'])) {
    return 'In many cut-qalam teaching systems, a rhombic dot made with the nib is used as a measuring unit for letter proportions and spacing. The dot’s shape depends on the nib angle, so make it consistently before using it to compare forms. Exact measurements vary by script and teaching method; use the units shown in your own course rather than mixing systems.';
  }

  if (contains(normalized, ['what is ligature', 'ligature', 'letter form', 'initial medial final', 'beginning middle end'])) {
    return 'Arabic letters can take different contextual forms depending on where they appear in a word and whether they connect to neighboring letters. Calligraphers shape these joins so the word remains both readable and balanced. Study the specific letter pair and position in your lesson model; forms and stylistic choices can differ by script.';
  }

  if (contains(normalized, ['which script should i choose', 'which course should i choose', 'help choose a course', 'help me choose'])) {
    return 'I can help you choose without grading your ability. First, have you practised Arabic calligraphy before? If so, which script and for how long? I’ll ask about your comfort with proportions and joining next, then whether you prefer an ordinary pen or cut qalam and what you hope to learn.';
  }

  if (contains(normalized, ['forgot password', 'reset password', 'change password', 'cant log in', 'cannot log in', 'login issue', 'sign in issue'])) {
    return 'Use **Forgot your password?** on the sign-in page to request a reset link for your account email. If you are already signed in, use your account settings to change your password. For account or TR-number access problems, contact an administrator; Guild Guide cannot reset credentials or unlock accounts directly.';
  }

  if (contains(normalized, ['what scripts are there', 'which scripts', 'scripts available', 'courses available', 'what courses'])) {
    const certs = courses.filter(course => course.category === 'certification');
    const names = certs.length ? certs.map(course => `**${course.script}**`).join(', ') : 'the published scripts shown in Courses';
    return `The live certification catalog currently includes ${names}. The platform distinguishes Naskh with a normal pen from cut-qalam Naskh when both are set up. Open **Courses** for the current paths, levels, and any optional secondary courses; availability and lesson content come from the live catalog.`;
  }

  if (contains(normalized, ['i am beginner', 'im beginner', 'beginner advice', 'new to calligraphy', 'start learning calligraphy'])) {
    return 'Welcome to the practice. Start with one script and one tool, learn the basic strokes and letter proportions from its course references, and work through lessons in order. Avoid trying to master every script at once. If you tell me whether you prefer an ordinary pen or a cut reed qalam and which forms interest you, I can help you find a starting path.';
  }

  if (contains(normalized, ['thank you', 'thanks', 'welcome'])) {
    return 'You’re welcome. What else would you like to explore—your course, a calligraphy term, or a practice idea?';
  }

  if (assessmentPromptIndex >= 0 && learner?.assessmentStarted === true && !placementComplete) {
    if (userAnswers === 1) return 'Thanks. **Placement check 2/3:** how confident are you with letter proportions and joining letters into words? You can say “new to it,” “some practice,” or “comfortable.”';
    if (userAnswers === 2) return 'Thanks. **Placement check 3/3:** which writing tool do you want to learn with—an ordinary/normal pen, or the traditional cut reed pen (qalam)? And what would you most like to work on first: individual letters, joining, or complete lines?';
    const allAnswers = messages.map(message => message.content.toLowerCase()).join(' ');
    const prefersNormalPen = contains(allAnswers, ['normal pen', 'ordinary pen', 'regular pen', 'ballpoint', 'biro', 'uncut pen']);
    const selectedScript = prefersNormalPen ? 'Naskh (Normal Pen)' : contains(allAnswers, ['sulus', 'thuluth']) ? 'Sulus'
      : contains(messages.map(message => message.content.toLowerCase()).join(' '), ['nasta', 'nastaliq', 'nastaleeq']) ? 'Nastaaleeq'
        : 'Naskh';
    const certification = courses.find(course => course.category === 'certification' && course.script.toLowerCase() === selectedScript.toLowerCase())
      ?? courses.find(course => course.category === 'certification');
    if (!certification) return 'Thanks for completing the placement check. I could not find a published certification course in the course catalog right now. Open **Courses** to see what is available, or ask your teacher which path is currently offered.';
    const currentCourse = learner.currentCourse as string | undefined;
    return currentCourse && !prefersNormalPen
      ? `Based on your answers, continue with **${currentCourse}** rather than restarting. Your next step is the next unlocked lesson on your dashboard. If you want, tell me the lesson name and I can explain how to approach it.`
      : `Based on your answers, I recommend starting with **${certification.title}** (${certification.script}), the guild's structured certification path. It has ${certification.levelCount} ordered lessons/checkpoints. Open **Courses**, choose ${certification.script}, and begin at the first unlocked lesson—it's designed to build from fundamentals. Try the lessons in order and ask your teacher for feedback at checkpoints.`;
  }

  if (contains(normalized, ['event', 'live session', 'live event', 'meeting'])) {
    return 'To host a live event, open **Host events**, schedule a title and date/time, then open its studio and allow camera and microphone access. Start the event there; students join from **Events**. Finished recordings appear in past recordings once processing completes.';
  }
  if (contains(normalized, ['submit', 'checkpoint', 'test', 'review', 'feedback'])) {
    return 'For course practice, open **Courses**, choose your script and current level, and submit work only when you reach a checkpoint. Your teacher reviews checkpoint submissions; the result and feedback appear in your learning progress. You can see recent work and decisions from your dashboard/profile.';
  }
  if (contains(normalized, ['teacher', 'queue', 'review student', 'assigned script'])) {
    return 'Teachers can open **Review queue** to see assigned student submissions, **My reviews** for completed decisions, and **Host events** to schedule a live session. Your profile shows assigned scripts and review activity.';
  }
  if (contains(normalized, ['qalam', 'reed pen', 'pen cut', 'pen angle'])) {
    return 'The qalam is the reed pen used to make calligraphic strokes. Its cut width and the angle at which you hold it determine the characteristic thick and thin strokes. For a beginner, use a consistent cut and hold the nib steadily; practise slow vertical, horizontal, and curved strokes before combining them into letters. Your course’s materials may specify a particular nib width and angle, so follow those when provided.';
  }
  if (contains(normalized, ['dot', 'proportion', 'measure', 'scale'])) {
    return 'In many Arabic calligraphy teaching traditions, the rhombic dot made by the qalam is used as a repeatable unit for measuring letters and spacing. The exact proportions depend on the script and the course method. Practise making dots with a consistent nib angle, then compare letter height, width, and spacing against the proportions taught in your current lesson rather than mixing rules from different scripts.';
  }
  if (contains(normalized, ['baseline', 'line', 'satr', 'under the line', 'above the line'])) {
    return 'The baseline (often discussed as the writing line) organizes where letters sit, rise, and descend. The relationship changes by letter, connection, and script; it is not simply a rule that every letter rests on one flat line. In practice, mark a light guide line, compare where each letter joins and descends, and follow the examples in your current script lesson.';
  }
  if (contains(normalized, ['join', 'joining', 'connect letters', 'connection'])) {
    return 'Arabic letters connect according to their joining forms: many have contextual shapes at the beginning, middle, and end of a word, while a smaller group does not connect to the following letter. Study the specific pair in your course, watch the entry and exit strokes, and keep the connection smooth without losing each letter’s proportions. The exact forms vary across scripts.';
  }
  if (contains(normalized, ['naskh', 'sulus', 'thuluth', 'nastaaleeq', 'nastaliq', 'script difference', 'scripts differ'])) {
    return 'These are distinct Arabic calligraphy scripts with different proportions and visual rhythms. Naskh is commonly taught as a clear, balanced foundation; Sulus (Thuluth) is more monumental, with pronounced verticals and broad, expressive forms; Nastaʿlīq has a distinctive sloping rhythm and is associated especially with Persian calligraphy. Your site offers separate paths for the scripts—begin with the one assigned or selected in your course, and avoid applying one script’s letter proportions to another.';
  }
  if (contains(normalized, ['practice', 'improve', 'hand stead', 'letter look'])) {
    return 'A useful practice loop is: warm up with slow, repeated strokes; study one letter’s proportions; write it at a consistent size; then compare your result with the lesson reference. Change one variable at a time—nib angle, pressure, spacing, or rhythm—and ask your teacher to review checkpoint work. Short, regular sessions are usually more useful than rushing through many letters.';
  }
  if (!placementComplete && contains(normalized, ['course', 'start', 'begin', 'beginner', 'new student', 'which script', 'which one', 'placement'])) {
    return 'I can help you choose a starting point. Let’s do a quick placement check—no grading, just a way to tailor the path. **1/3:** have you studied calligraphy before? If yes, which script(s) and for how long?';
  }

  return 'I can help with the site, course choices, checkpoints, certificates, events, and general Arabic-calligraphy questions. I may not have enough information to answer that exact question yet—could you rephrase it or tell me whether you mean a site feature, a script, a tool, or a practice technique?';
}

async function loadContext(user: AuthUser): Promise<{ name: string; courses: CourseSummary[]; learner: Record<string, unknown> | null; teacher: Record<string, unknown> | null }> {
  const [{ rows: userRows }, { rows: courseRows }] = await Promise.all([
    pool.query('SELECT name FROM users WHERE id = $1 AND deleted_at IS NULL', [user.id]),
    pool.query(
      `SELECT c.title, c.category, kt.display_name AS script, c.description, COUNT(l.id)::int AS level_count
       FROM courses c JOIN khat_types kt ON kt.id = c.khat_type_id
       LEFT JOIN levels l ON l.course_id = c.id
       GROUP BY c.id, kt.display_name
       ORDER BY c.category, kt.display_name, c.title`
    ),
  ]);
  const courses: CourseSummary[] = courseRows.map((row: { title: string; category: string; script: string; description: string | null; level_count: number }) => ({
    title: row.title,
    category: row.category,
    script: row.script,
    description: row.description,
    levelCount: Number(row.level_count),
  }));

  let learner: Record<string, unknown> | null = null;
  let teacher: Record<string, unknown> | null = null;

  if (user.role === 'student') {
    const [enrollments, recentEntries] = await Promise.all([
      pool.query(
        `SELECT c.title, c.category, kt.display_name AS script, e.percent_complete,
                e.current_level_index, l.title AS next_level
         FROM enrollments e JOIN courses c ON c.id = e.course_id
         JOIN khat_types kt ON kt.id = c.khat_type_id
         LEFT JOIN levels l ON l.course_id = c.id AND l.order_index = e.current_level_index
         WHERE e.student_id = $1 ORDER BY c.category, c.title`,
        [user.id]
      ),
      pool.query(
        `SELECT e.status, e.source_type, e.created_at, l.title AS level_title
         FROM entries e LEFT JOIN levels l ON l.id = e.level_id
         WHERE e.student_id = $1 ORDER BY e.created_at DESC LIMIT 5`,
        [user.id]
      ),
    ]);
    const currentEnrollment = enrollments.rows.find((row: { category: string }) => row.category === 'certification');
    learner = {
      enrollments: enrollments.rows,
      recentEntries: recentEntries.rows,
      currentCourse: currentEnrollment?.title ?? null,
      assessmentStarted: false,
    };
  }

  if (user.role === 'teacher') {
    const [assignments, queue, reviewed, branchEvents] = await Promise.all([
      pool.query(
        `SELECT kt.display_name FROM teacher_khat_assignments tka
         JOIN khat_types kt ON kt.id = tka.khat_type_id WHERE tka.teacher_id = $1`,
        [user.id]
      ),
      pool.query(`SELECT COUNT(*)::int AS count FROM entries WHERE assigned_teacher_id = $1 AND status IN ('assigned', 'in_review')`, [user.id]),
      pool.query(`SELECT COUNT(*)::int AS count FROM entries WHERE reviewed_by = $1 AND status IN ('reviewed', 'redo_needed')`, [user.id]),
      pool.query(`SELECT status, COUNT(*)::int AS count FROM live_events WHERE host_teacher_id = $1 GROUP BY status`, [user.id]),
    ]);
    teacher = {
      assignedScripts: assignments.rows.map((row: { display_name: string }) => row.display_name),
      openReviewCount: Number(queue.rows[0]?.count ?? 0),
      reviewedEntryCount: Number(reviewed.rows[0]?.count ?? 0),
      eventsByStatus: branchEvents.rows,
    };
  }

  return { name: userRows[0]?.name ?? 'there', courses, learner, teacher };
}

async function askConfiguredModel(messages: ChatMessage[], context: Awaited<ReturnType<typeof loadContext>>): Promise<string | null> {
  if (!config.assistant.baseUrl || !config.assistant.model) return null;
  const siteGuidance = [
    'You are Guild Guide, a warm, capable AI assistant for the Calligraphy Guild Learning Platform. Help with site navigation and workflows AND answer general Arabic-calligraphy questions: scripts and their visual characteristics, qalam/reed preparation, proportions, letter construction, joining, practice habits, composition, terminology, and critique principles. Explain concepts clearly with examples and adapt depth to the learner. Do not claim to see a submitted artwork unless an image is explicitly supplied.',
    'Use your general calligraphy knowledge for broad educational questions. Be nuanced: practices and proportions differ by script, teacher, and tradition; avoid presenting one school\'s rules as universal. Give practical exercises when useful, and invite a follow-up rather than turning every reply into a course-placement interview.',
    'Be conversational and responsive to the exact message. Reply warmly to greetings, “how are you?”, thanks, requests for motivation, and questions about who you are; do not force every message into a site FAQ. For motivation, be kind and practical without judging talent. For practice-time questions, suggest a modest, adjustable routine (for example, 15–30 focused minutes) and advise breaks if there is discomfort.',
    'You may explain general Arabic-calligraphy topics such as writing direction, letter shapes and connections, non-joining letters, dots and proportions, baseline, harakat, qalam structure and angle, ordinary-pen versus cut-qalam practice, ink and paper, spacing, rhythm, composition, terminology, and broad script histories. Keep historical statements qualified and do not invent exact course prescriptions or religious quotations.',
    'Separate general calligraphy knowledge from platform-specific facts. Use general knowledge for calligraphy questions, but never invent course names, lesson content, student progress, policies, review status, schedules, or site capabilities. For site-specific facts not in live context, say what you cannot verify and direct the user to the relevant site page or teacher/admin.',
    'For student course placement, ask one concise assessment question per turn: (1) prior practice/scripts and duration, (2) confidence with proportions and joining, (3) ordinary/normal pen versus cut reed qalam preference plus near-term goal. Use all answers, the student\'s current enrollment, and only real courses in the live catalog. Recommend one clear starting/continuation path with a brief reason and site navigation. Naskh with a normal pen is a separate course from cut-qalam Naskh; respect the stated tool preference. Do not assess artistic skill as pass/fail. Once a recommendation has been given, do not repeat or restart the assessment after acknowledgments or unrelated follow-up; answer the new message normally. Start a new assessment only when the student explicitly requests a reassessment.',
    'Respond naturally to greetings and thanks. When a user says thank you, acknowledge them briefly and invite a different follow-up; do not repeat a prior answer, course recommendation, or placement assessment.',
    'Students may discuss only their own supplied progress. Teachers may discuss only their supplied assignment/review/event summary. Never reveal another person\'s private information or claim you can change records.',
    'Site map: Courses contains certification learning paths and secondary study courses; each path has ordered lessons, practice and checkpoints. Students submit checkpoint work from the course and receive teacher feedback in their profile/dashboard. Live Events lists upcoming/live sessions and completed recordings. Teachers use Review queue, My reviews, Host events, Asset library, Showcase, and Judging. Notifications are under Notifications. Describe actions as instructions; do not claim to execute them.',
    `Current user role: ${context.learner ? 'student' : context.teacher ? 'teacher' : 'other authenticated role'}.`,
    `Available course catalog (live): ${JSON.stringify(context.courses)}.`,
    context.learner ? `This student's own progress context: ${JSON.stringify(context.learner)}.` : '',
    context.teacher ? `This teacher's own work context: ${JSON.stringify(context.teacher)}.` : '',
  ].filter(Boolean).join('\n');
  const endpoint = `${config.assistant.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.assistant.apiKey ? { Authorization: `Bearer ${config.assistant.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.assistant.model,
        temperature: 0.3,
        max_tokens: 500,
        messages: [{ role: 'system', content: siteGuidance }, ...messages],
      }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) throw new Error(`Assistant model returned ${response.status}`);
    const result = await response.json() as { choices?: { message?: { content?: unknown } }[] };
    const answer = result.choices?.[0]?.message?.content;
    return typeof answer === 'string' && answer.trim() ? answer.trim() : null;
  } catch (error) {
    console.warn('[Assistant] Configured model unavailable; using guided fallback.', error);
    return null;
  }
}

export async function assistantRoutes(app: FastifyInstance) {
  app.post<{ Body: ChatBody }>(
    '/chat',
    { preHandler: [app.authenticate, app.requireRole('student', 'teacher', 'admin')] },
    async (request, reply) => {
      const messages = request.body?.messages;
      if (!Array.isArray(messages) || messages.length === 0 || messages.length > 12 || !messages.every(safeMessage)) {
        return reply.code(400).send({ error: 'Send between 1 and 12 valid chat messages. Each message must be 1–2000 characters.' });
      }
      if (messages[messages.length - 1].role !== 'user') {
        return reply.code(400).send({ error: 'The last chat message must be from the user.' });
      }

      try {
        const user = request.user as AuthUser;
        const latestUserMessage = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
        if (isAcknowledgment(latestUserMessage)) {
          return {
            answer: 'You’re welcome! I’m here if you’d like to explore a calligraphy concept, ask about a lesson, or get help with another part of the site.',
            mode: 'guided',
          };
        }
        const context = await loadContext(user);
        const learnerContext = context.learner ? {
          ...context.learner,
          assessmentStarted: messages.some(message => message.role === 'assistant' && message.content.includes('placement check')),
        } : null;
        const contextWithAssessment = { ...context, learner: learnerContext };
        const answer = await askConfiguredModel(messages, contextWithAssessment)
          ?? localFallbackReply(messages, context.courses, learnerContext, context.name);
        return { answer, mode: config.assistant.baseUrl && config.assistant.model ? 'model-or-guided-fallback' : 'guided' };
      } catch (error) {
        request.log.error(error, 'Assistant context lookup failed');
        return reply.code(500).send({ error: 'The assistant could not load your current site context. Please try again.' });
      }
    }
  );
}