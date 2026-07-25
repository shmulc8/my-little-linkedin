// Shared config, presets, i18n and storage helpers for My Little LinkedIn.
// Loaded both as the first content script and via <script> in the popup.
// The extension UI is English-only; Hebrew is supported only in the transformed
// post output (a Hebrew post gets a Hebrew rewrite/verdict, detected per post).
// Everything hangs off a single global: MLL.

(function () {
  const g = typeof window !== 'undefined' ? window : self;
  if (g.MLL) return;

  // ---- Built-in transforms -------------------------------------------------
  // `prompt` is the system instruction; the output-language nudge is appended
  // at call time by the engine. `null` prompt means "no rewrite".

  // Each transform carries an English instruction and a Hebrew one. The engine
  // picks by the post's detected language, so a Hebrew post is rewritten IN
  // Hebrew (e.g. Hebrew pirate-speak), not translated to English.
  const PRESETS = [
    { id: 'none', builtin: true, name: 'Off' },
    {
      id: 'defluff',
      builtin: true,
      name: 'Defluff (one honest line)',
      promptEn:
        'Rewrite the post as ONE short, honest, deadpan sentence stating the only real point. ' +
        'Strip all inspirational fluff, emoji, hashtags and engagement bait. Max 16 words.',
      promptHe:
        'שכתב את הפוסט כמשפט אחד קצר, כן ויבש שמנסח את הנקודה האמיתית היחידה. ' +
        "הסר כל מליצות, אימוג'ים, האשטגים ופיתיונות למעורבות. עד 16 מילים. כתוב בעברית.",
    },
    {
      id: 'pirate',
      builtin: true,
      name: 'Pirate',
      promptEn:
        'Rewrite the post in over-the-top pirate-speak, keeping the meaning and roughly the same length. ' +
        'Lean into: arr, ahoy, matey, ye, aye, treasure, plunder, scallywag, hoist the colors.',
      promptHe:
        'שכתב את הפוסט בעברית בסגנון שודד-ים מוגזם, תוך שמירה על המשמעות ועל אורך דומה. ' +
        'השתמש בהמון סלנג ימי ופיראטי בעברית (אהוי, ימח, ספן, מטמון, שוד, הרם עוגן, כלב-ים). כתוב בעברית.',
    },
    {
      id: 'fluff',
      builtin: true,
      name: 'Fluff it up',
      promptEn:
        'Inflate the post into maximum LinkedIn thought-leader fluff while keeping the core message: ' +
        'a punchy one-line hook, almost every sentence on its own line, sprinkled emoji, a grandiose ' +
        'life lesson, and an engagement-bait question plus 3-5 hashtags at the end.',
      promptHe:
        "נפח את הפוסט למקסימום סגנון 'מנהיג מחשבה' של לינקדאין, תוך שמירה על המסר: שורת פתיחה קליטה, " +
        "כמעט כל משפט בשורה נפרדת, אימוג'ים, לקח חיים מרשים, ולסיום שאלה שמזמינה תגובות ו-3-5 האשטגים. כתוב בעברית.",
    },
    {
      id: 'plain',
      builtin: true,
      name: 'Plain summary',
      promptEn:
        'Rewrite the post as a plain, neutral 1-2 sentence summary of what it actually says. ' +
        'No emoji, no hype, no hashtags.',
      promptHe:
        'שכתב את הפוסט כתקציר ניטרלי ופשוט באורך 1-2 משפטים של מה שנאמר בו בפועל. ' +
        "ללא אימוג'ים, ללא הייפ, ללא האשטגים. כתוב בעברית.",
    },
    {
      id: 'genz',
      builtin: true,
      name: 'Gen-Z',
      promptEn:
        'Rewrite the post in casual Gen-Z internet slang, keeping the meaning. ' +
        'Lowercase, playful, a little chaotic, emoji allowed.',
      promptHe:
        'שכתב את הפוסט בעברית בסלנג אינטרנטי של דור ה-Z, תוך שמירה על המשמעות. ' +
        "קליל, שובב, קצת כאוטי, מותר אימוג'ים. כתוב בעברית.",
    },
    {
      id: 'shakespeare',
      builtin: true,
      name: 'Shakespeare',
      promptEn:
        'Rewrite the post in the style of Shakespearean early modern English, keeping the meaning. ' +
        'Use thee, thou, hath, doth where natural.',
      promptHe:
        'שכתב את הפוסט בעברית מליצית וארכאית בנוסח תנ"כי/גבוה, תוך שמירה על המשמעות. ' +
        'השתמש בלשון נמלצת (הנה, כי, אשר, למען). כתוב בעברית.',
    },
    {
      id: 'corporate',
      builtin: true,
      name: 'Corporate buzzwords',
      promptEn:
        'Rewrite the post in maximally buzzword-laden corporate speak (synergy, leverage, circle back, ' +
        'bandwidth, low-hanging fruit, move the needle), keeping the meaning. Deadpan.',
      promptHe:
        'שכתב את הפוסט בעברית בשפה תאגידית עמוסת מונחי באזז (סינרגיה, מינוף, ערך מוסף, רוחב-פס, ' +
        'חשיבה מחוץ לקופסה, להזיז את המחט), תוך שמירה על המשמעות. יבש. כתוב בעברית.',
    },
  ];

  // ---- Default settings ----------------------------------------------------

  const DEFAULTS = {
    enabled: true,
    activeTransform: 'none',
    showVerdict: true,
    careTopics: [], // string[]
    avoidTopics: [], // string[]
    customTransforms: [], // { id, name, prompt }
  };

  // ---- UI strings (English only) ------------------------------------------

  const STRINGS = {
    appName: 'My Little LinkedIn',
    tagline: 'Your feed, your rules — on-device.',
    enable: 'Enable',
    transform: 'Transform posts',
    showVerdict: 'Show relevance verdict',
    careTitle: 'Topics I care about',
    careHint: 'One per line. Posts substantially about these are marked Relevant.',
    avoidTitle: 'Topics to avoid',
    avoidHint: 'One per line. Posts mainly about these are Muted — the card is dimmed.',
    customTitle: 'Custom transforms',
    customHint: 'Name it and describe how each post should be rewritten. It joins the picker above.',
    nameLabel: 'Name',
    promptEnLabel: 'Instruction for English posts',
    promptHeLabel: 'Instruction for Hebrew posts (optional)',
    addTransform: '+ Add custom transform',
    remove: 'Remove',
    namePlaceholder: 'e.g. Angry chef',
    promptPlaceholder: 'e.g. Rewrite the post as if shouted by an angry chef.',
    promptHePlaceholder: 'לדוגמה: נסח מחדש כאילו נצעק על ידי שף כועס.',
    saved: 'Saved',
    unavailable: 'On-device AI is not available in this browser.',
    unavailableTitle: 'On-device AI unavailable',
    unavailableHelp:
      "My Little LinkedIn runs on Chrome's built-in AI. Use Chrome 138+, enable " +
      '“Prompt API for Gemini Nano” and the on-device model at chrome://flags, then ' +
      'restart. The model downloads once (~2GB).',
    dismiss: 'Dismiss',
    analyzing: 'analyzing…',
    relevant: 'Relevant',
    neutral: 'Neutral',
    muted: 'Muted',
    showOriginal: 'show original',
    showTransformed: 'show transformed',
  };

  // ---- Helpers -------------------------------------------------------------

  const t = (key) => STRINGS[key] ?? key;

  const transformName = (transform) =>
    transform ? (typeof transform.name === 'string' ? transform.name : transform.name?.en || transform.id) : '';

  // The system instruction for a transform, chosen by the post's language.
  // Both presets and custom transforms carry { promptEn, promptHe }; a Hebrew
  // post uses promptHe when present, otherwise falls back to promptEn. "Off"
  // (and any transform with neither) yields null → no rewrite.
  function promptFor(transform, lang) {
    if (!transform) return null;
    if (lang === 'he' && transform.promptHe) return transform.promptHe;
    return transform.promptEn || transform.promptHe || null;
  }

  function detectLang(text) {
    const hebrew = (text.match(/[֐-׿]/g) || []).length;
    const letters = (text.match(/\p{L}/gu) || []).length || 1;
    return hebrew / letters > 0.15 ? 'he' : 'en';
  }

  const allTransforms = (settings) => PRESETS.concat(settings.customTransforms || []);
  const findTransform = (settings, id) => allTransforms(settings).find((x) => x.id === id) || null;

  const getSettings = () =>
    new Promise((resolve) => chrome.storage.sync.get(DEFAULTS, (stored) => resolve({ ...DEFAULTS, ...stored })));

  const saveSettings = (patch) => new Promise((resolve) => chrome.storage.sync.set(patch, resolve));

  const onSettingsChanged = (cb) =>
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync') cb(changes);
    });

  g.MLL = {
    PRESETS,
    DEFAULTS,
    STRINGS,
    t,
    transformName,
    promptFor,
    detectLang,
    allTransforms,
    findTransform,
    getSettings,
    saveSettings,
    onSettingsChanged,
  };
})();
