import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Language = 'en' | 'ar';
const LANGUAGE_KEY = 'khat_language';
const LanguageContext = createContext<{ language: Language; setLanguage: (language: Language) => void; t: (text: string) => string } | null>(null);

const ARABIC: Record<string, string> = {
  'Dashboard': 'لوحة التحكم', 'Courses': 'الدورات', 'Chats': 'المحادثات', 'Achievements': 'الإنجازات', 'Gallery': 'المعرض',
  'Competitions': 'المسابقات', 'Events': 'الفعاليات', 'Resources': 'الموارد', 'My showcase': 'معرض أعمالي',
  'Notifications': 'الإشعارات', 'Settings': 'الإعدادات', 'My Profile': 'ملفي الشخصي', 'Log Out': 'تسجيل الخروج',
  'Search menus, pages…': 'ابحث في القوائم والصفحات…', 'Search pages': 'ابحث في الصفحات', 'Search available menus': 'ابحث في القوائم المتاحة', 'Search menu items': 'ابحث في عناصر القائمة',
  'Open menu': 'افتح القائمة', 'Close menu': 'أغلق القائمة', 'Current section': 'القسم الحالي', 'Main navigation': 'التنقل الرئيسي',
  'Normal pen': 'قلم عادي', 'Style 1': 'النمط ١', 'Style 2': 'النمط ٢', 'Style One': 'النمط الأول', 'Style Two': 'النمط الثاني',
  'Your learning path': 'مسارك التعليمي', 'Your Path': 'مساري', 'First choose your pen. Then pick the course that matches what you want to learn.': 'اختر قلمك أولاً، ثم اختر الدورة المناسبة لما تريد تعلمه.',
  'Step 1 · Choose your pen': 'الخطوة ١ · اختر قلمك', 'Cut pen courses': 'دورات قلم القصب', 'Normal pen courses': 'دورات القلم العادي',
  'An everyday pen, for better daily handwriting': 'قلم يومي لتحسين الكتابة اليومية', 'Step 2 · Pick a course': 'الخطوة ٢ · اختر دورة',
  'Every card reads the same way:': 'تُعرض جميع البطاقات بالطريقة نفسها:', '1 · Is this for you?': '١ · هل هذه الدورة مناسبة لك؟',
  '2 · Levels': '٢ · المستويات', '3 · Your progress': '٣ · تقدمك', '4 · Assessment': '٤ · التقييم',
  'Certification courses': 'دورات الشهادة', 'Complete every level to earn a certificate.': 'أكمل جميع المستويات للحصول على شهادة.',
  'Crash courses': 'دورات مكثفة', 'Short, focused courses to learn a new script.': 'دورات قصيرة ومركزة لتعلم خط جديد.',
  'Certification': 'شهادة', 'Crash course': 'دورة مكثفة',
  'Course style': 'نمط الدورة', 'Open course': 'افتح الدورة', 'View course': 'عرض الدورة', 'levels': 'مستويات', 'of': 'من',
  'Worksheets': 'أوراق تدريب', 'Worksheets soon': 'أوراق التدريب قريباً', 'Course card guide': 'دليل بطاقات الدورات',
  'Build confident, measured handwriting with this guided certification path.': 'طوّر كتابة واثقة ومتقنة عبر مسار الشهادة الموجّه.',
  'Downloadable practice sheets. Current sets are available in Naskh.': 'أوراق تدريب قابلة للتنزيل. المجموعات الحالية متاحة بخط النسخ.',
  'Your practice rhythm': 'وتيرة تدريبك', 'Your practice over the last 12 weeks, and what to do next.': 'تدريبك خلال الأسابيع الاثني عشر الماضية والخطوة التالية.',
  'Current streak': 'سلسلة الالتزام الحالية', 'Practice this week': 'التدريب هذا الأسبوع', 'Average mark (last 3)': 'متوسط آخر ثلاث درجات',
  'Next assessment': 'التقييم التالي', 'Upcoming events': 'الفعاليات القادمة', 'All events': 'كل الفعاليات',
  'No upcoming events.': 'لا توجد فعاليات قادمة.', 'Master progress': 'التقدم الإجمالي', 'All your courses': 'جميع دوراتك',
  'Enroll in a course to start building your overall progress.': 'سجل في دورة لبدء متابعة تقدمك الإجمالي.',
  'Mashq worksheets': 'أوراق تدريب المشق', 'All khat types': 'جميع أنواع الخط', 'View sheets': 'عرض الأوراق',
  'Loading courses…': 'جارٍ تحميل الدورات…', 'Loading worksheets…': 'جارٍ تحميل أوراق التدريب…',
  'Choose your place in the guild to continue.': 'اختر موقعك في المجموعة للمتابعة.', 'Student': 'طالب', 'Faculty': 'الهيئة التعليمية',
  'Coordinator': 'منسق', 'Admin': 'مسؤول', 'Sign in': 'تسجيل الدخول', 'Email': 'البريد الإلكتروني', 'Password': 'كلمة المرور',
  'Student sign in': 'دخول الطالب', 'Welcome back': 'مرحباً بعودتك', 'Profile': 'الملف الشخصي', 'Overview': 'نظرة عامة',
};
const ENGLISH_BY_ARABIC = new Map(Object.entries(ARABIC).map(([english, arabic]) => [arabic, english]));

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(() => localStorage.getItem(LANGUAGE_KEY) === 'ar' ? 'ar' : 'en');
  const originalText = useMemo(() => new WeakMap<Node, { base: string; displayed: string }>(), []);
  const setLanguage = (next: Language) => {
    localStorage.setItem(LANGUAGE_KEY, next);
    setLanguageState(next);
  };
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    const translateNode = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const raw = node.textContent ?? '';
        const previous = originalText.get(node);
        const base = previous && raw === previous.displayed ? previous.base : ENGLISH_BY_ARABIC.get(raw) ?? raw;
        const translated = language === 'ar' ? ARABIC[base] ?? base : base;
        originalText.set(node, { base, displayed: translated });
        if (raw !== translated) node.textContent = translated;
        return;
      }
      if (!(node instanceof Element) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT'].includes(node.tagName) || node.hasAttribute('contenteditable')) return;
      for (const child of node.childNodes) translateNode(child);
      for (const attribute of ['aria-label', 'placeholder', 'title']) {
        const raw = node.getAttribute(attribute);
        if (!raw) continue;
        const key = `data-language-original-${attribute}`;
        const displayedKey = `data-language-displayed-${attribute}`;
        const previousDisplayed = node.getAttribute(displayedKey);
        const base = previousDisplayed === raw ? node.getAttribute(key) ?? raw : ENGLISH_BY_ARABIC.get(raw) ?? raw;
        node.setAttribute(key, base);
        const translated = language === 'ar' ? ARABIC[base] ?? base : base;
        node.setAttribute(displayedKey, translated);
        if (raw !== translated) node.setAttribute(attribute, translated);
      }
    };
    translateNode(document.body);
    const observer = new MutationObserver(records => {
      records.forEach(record => {
        if (record.type === 'characterData') translateNode(record.target);
        else record.addedNodes.forEach(translateNode);
        if (record.type === 'attributes' && record.target instanceof Element) translateNode(record.target);
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'placeholder', 'title'] });
    return () => observer.disconnect();
  }, [language, originalText]);
  const value = useMemo(() => ({ language, setLanguage, t: (text: string) => language === 'ar' ? ARABIC[text] ?? text : text }), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error('useLanguage must be used within LanguageProvider');
  return context;
}
