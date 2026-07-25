// On-device AI engine for My Little LinkedIn.
// Uses Chrome's built-in Prompt API (Gemini Nano). Two jobs:
//   classify(text) -> { topics, verdict, reason }  (structured)
//   transform(text, prompt) -> rewritten string    (creative)
// One model handles one request at a time, so everything runs through a serial
// queue. Nothing leaves the browser.

(function () {
  const g = typeof window !== 'undefined' ? window : self;

  const CLASSIFY_SYSTEM =
    'You are a social-feed triage assistant. For each post you identify its main ' +
    'topics and judge how relevant it is to the reader, based on interests they provide. ' +
    'Be terse and honest.';

  const CLASSIFY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['topics', 'verdict', 'reason'],
    properties: {
      topics: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      verdict: { type: 'string', enum: ['relevant', 'neutral', 'muted'] },
      reason: { type: 'string' },
    },
  };

  // Combined triage + rewrite in a single model call (speed path).
  const ANALYZE_SYSTEM =
    'You are a social-feed assistant. In one step you triage a post (its main ' +
    'topics and how relevant it is to the reader) AND rewrite it following an ' +
    'instruction. Be terse and honest.';

  const ANALYZE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['topics', 'verdict', 'reason', 'rewrite'],
    properties: {
      topics: { type: 'array', items: { type: 'string' }, maxItems: 4 },
      verdict: { type: 'string', enum: ['relevant', 'neutral', 'muted'] },
      reason: { type: 'string' },
      rewrite: { type: 'string' },
    },
  };

  const langName = (lang) => (lang === 'he' ? 'Hebrew' : 'English');

  // Language the rewritten post should come out in. Hebrew gets a hard Hebrew
  // override; anything else is written in the post's own language rather than
  // forced into English.
  const outputLang = (lang) => (lang === 'he' ? 'Hebrew' : 'the same language as the original post');
  const langNudge = (lang) =>
    lang === 'he'
      ? '\n\nהשב בעברית בלבד.'
      : '\n\nWrite your response in the same language as the post above.';

  // Appended to every rewrite so no transform turns tone-deaf or mangles a name.
  const GUARDRAIL =
    'Stay kind: never be sarcastic, mocking, or dismissive about layoffs, job loss, ' +
    'grief, illness, death, family, or religion, and never toward students, new ' +
    "graduates, or job-seekers. Keep every real person's name exactly as written — " +
    "never invent, translate, or swap a name — and do not assume anyone's gender.";

  function buildClassifyPrompt(text, author, lang, care, avoid) {
    const careStr = care && care.length ? care.join(', ') : '(none given)';
    const avoidStr = avoid && avoid.length ? avoid.join(', ') : '(none given)';
    return [
      author ? `Post author: ${author}` : null,
      'Post:',
      '"""',
      text.slice(0, 3000),
      '"""',
      '',
      `Interests I care about: ${careStr}`,
      `Topics I want to avoid: ${avoidStr}`,
      '',
      'Identify the 1-4 main topics of the post as short tags.',
      "Decide the verdict: 'relevant' if it substantially relates to my interests, " +
        "'muted' if it is mainly about a topic I want to avoid, otherwise 'neutral'.",
      "If I gave no interests, never use 'relevant' — use 'neutral' unless it matches an avoid topic.",
      'Give a very short reason (max 12 words).',
      `Write the topics and the reason in ${langName(lang)}.`,
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  function normalizeVerdict(o) {
    if (!o || typeof o !== 'object') return null;
    const verdict = ['relevant', 'neutral', 'muted'].includes(o.verdict) ? o.verdict : 'neutral';
    const topics = Array.isArray(o.topics) ? o.topics.slice(0, 4).map((x) => String(x).trim()).filter(Boolean) : [];
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    const result = { topics, verdict, reason };
    if (typeof o.rewrite === 'string') result.rewrite = o.rewrite.trim();
    return result;
  }

  // Pull one "key":"value" string field out of possibly-broken JSON.
  function salvageString(raw, key) {
    const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"'));
    if (!m) return null;
    try {
      return JSON.parse('"' + m[1] + '"');
    } catch (_) {
      return m[1];
    }
  }

  function salvageTopics(raw) {
    const m = raw.match(/"topics"\s*:\s*\[([\s\S]*?)\]/);
    if (!m) return [];
    return (m[1].match(/"((?:\\.|[^"\\])*)"/g) || []).map((s) => {
      try {
        return JSON.parse(s);
      } catch (_) {
        return s.replace(/^"|"$/g, '');
      }
    });
  }

  // Last resort when the model returns truncated or invalid JSON: rescue each
  // field on its own so one malformed byte doesn't drop the whole post.
  function salvageVerdict(raw) {
    const verdict = salvageString(raw, 'verdict');
    const reason = salvageString(raw, 'reason');
    const rewrite = salvageString(raw, 'rewrite');
    const topics = salvageTopics(raw);
    if (verdict == null && reason == null && rewrite == null && !topics.length) return null;
    const o = { topics, verdict, reason };
    if (rewrite != null) o.rewrite = rewrite;
    return normalizeVerdict(o);
  }

  function parseVerdict(raw) {
    if (!raw) return null;
    try {
      return normalizeVerdict(JSON.parse(raw));
    } catch (_) {
      /* fall through to extraction */
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return normalizeVerdict(JSON.parse(match[0]));
      } catch (_) {
        /* fall through to field salvage */
      }
    }
    return salvageVerdict(raw);
  }

  function createEngine() {
    let available = null;
    let params = null;
    let classifyBase = null;
    let analyzeBase = null;
    const transformBases = new Map(); // system prompt -> Promise<session>

    const queue = [];
    let draining = false;

    const monitor = (m) =>
      m.addEventListener('downloadprogress', (e) =>
        console.log(`[MLL] downloading model ${Math.round(e.loaded * 100)}%`)
      );

    async function ensureAvailable() {
      if (available !== null) return available;
      if (typeof LanguageModel === 'undefined') {
        console.warn('[MLL] Prompt API (built-in AI) unavailable in this browser.');
        available = false;
        return false;
      }
      available = (await LanguageModel.availability()) !== 'unavailable';
      if (available && !params) {
        try {
          params = await LanguageModel.params();
        } catch (_) {
          params = {};
        }
      }
      return available;
    }

    async function createSession(opts) {
      try {
        return await LanguageModel.create(opts);
      } catch (_) {
        // Some builds reject the language-hint fields; retry without them.
        const { expectedInputs, expectedOutputs, ...rest } = opts;
        return await LanguageModel.create(rest);
      }
    }

    function getClassifyBase() {
      if (!classifyBase) {
        classifyBase = createSession({
          initialPrompts: [{ role: 'system', content: CLASSIFY_SYSTEM }],
          expectedInputs: [{ type: 'text', languages: ['en', 'he'] }],
          expectedOutputs: [{ type: 'text', languages: ['en', 'he'] }],
          monitor,
        });
      }
      return classifyBase;
    }

    function getAnalyzeBase() {
      if (!analyzeBase) {
        analyzeBase = createSession({
          initialPrompts: [{ role: 'system', content: ANALYZE_SYSTEM }],
          expectedInputs: [{ type: 'text', languages: ['en', 'he'] }],
          expectedOutputs: [{ type: 'text', languages: ['en', 'he'] }],
          monitor,
        });
      }
      return analyzeBase;
    }

    function getTransformBase(systemPrompt) {
      if (!transformBases.has(systemPrompt)) {
        transformBases.set(
          systemPrompt,
          createSession({
            initialPrompts: [{ role: 'system', content: systemPrompt + '\n\n' + GUARDRAIL }],
            temperature: Math.min(1.0, params?.maxTemperature ?? 1.0),
            topK: Math.min(8, params?.maxTopK ?? 8),
            expectedInputs: [{ type: 'text', languages: ['en', 'he'] }],
            expectedOutputs: [{ type: 'text', languages: ['en', 'he'] }],
            monitor,
          })
        );
      }
      return transformBases.get(systemPrompt);
    }

    // Serial task runner — the model can only serve one prompt at a time.
    function run(task) {
      return new Promise((resolve) => {
        queue.push({ task, resolve });
        drain();
      });
    }

    async function drain() {
      if (draining) return;
      draining = true;
      while (queue.length) {
        const { task, resolve } = queue.shift();
        try {
          resolve(await task());
        } catch (err) {
          console.warn('[MLL] engine task failed:', err);
          resolve(null);
        }
      }
      draining = false;
    }

    async function classify(text, author, lang, care, avoid, signal) {
      return run(async () => {
        if (signal?.aborted || !(await ensureAvailable())) return null;
        const session = await (await getClassifyBase()).clone();
        try {
          const prompt = buildClassifyPrompt(text, author, lang, care, avoid);
          let raw;
          try {
            raw = await session.prompt(prompt, { responseConstraint: CLASSIFY_SCHEMA, signal });
          } catch (e) {
            if (signal?.aborted) return null;
            // Structured-output not supported here — ask for JSON in prose.
            raw = await session.prompt(prompt + '\n\nRespond with a single JSON object only.', { signal });
          }
          return parseVerdict(raw);
        } finally {
          session.destroy();
        }
      });
    }

    // One call that returns { topics, verdict, reason, rewrite }. Used when the
    // reader wants BOTH a verdict and a rewrite — halves the per-post latency.
    async function analyze(text, author, transformPrompt, lang, care, avoid, signal) {
      return run(async () => {
        if (signal?.aborted || !(await ensureAvailable())) return null;
        const session = await (await getAnalyzeBase()).clone();
        try {
          const prompt =
            buildClassifyPrompt(text, author, lang, care, avoid) +
            '\n\nAlso rewrite the post following this instruction: ' +
            transformPrompt +
            '\n' + GUARDRAIL +
            `\nPut the rewrite in the "rewrite" field, written in ${outputLang(lang)}.`;
          let raw;
          try {
            raw = await session.prompt(prompt, { responseConstraint: ANALYZE_SCHEMA, signal });
          } catch (e) {
            if (signal?.aborted) return null;
            raw = await session.prompt(prompt + '\n\nRespond with a single JSON object only.', { signal });
          }
          return parseVerdict(raw);
        } finally {
          session.destroy();
        }
      });
    }

    async function transform(text, author, systemPrompt, lang, signal) {
      return run(async () => {
        if (signal?.aborted || !(await ensureAvailable())) return null;
        const session = await (await getTransformBase(systemPrompt)).clone();
        try {
          const preamble = author ? `This post was written by ${author}.\n\n` : '';
          const out = await session.prompt(preamble + text.slice(0, 2000) + langNudge(lang), { signal });
          return out.trim();
        } finally {
          session.destroy();
        }
      });
    }

    return { classify, transform, analyze, ensureAvailable };
  }

  g.MLL = g.MLL || {};
  g.MLL.createEngine = createEngine;
})();
