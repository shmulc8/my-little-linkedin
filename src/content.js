// My Little LinkedIn — content script.
// A generalization of the Defluffer approach: it applies whichever transform you
// pick (defluff, pirate, fluff, custom…) and tags each post with an on-device
// relevance verdict. Rendering mirrors Defluffer — the rewritten line copies the
// post's own computed typography and cross-fades in, so it reads as native text.
//
// The UI is English-only; each post's OUTPUT follows the post's own language
// (a Hebrew post gets a Hebrew rewrite/verdict). Everything runs on-device.
//
// Speed: all AI work is gated on the viewport (visible posts first), the verdict
// call is skipped when no topics are set, verdict+transform collapse into ONE
// model call when both are wanted, and results are cached by post text.

(function () {
  const PROCESSED = 'data-mll';
  const MIN_CHARS = 140; // don't rewrite posts already this short

  const engine = MLL.createEngine();
  let settings = { ...MLL.DEFAULTS };
  // Signature of a topic edit we made ourselves (via thumbs), so our own
  // storage echo does a cheap local restyle instead of a full model recompute.
  let pendingLocalTopics = null;

  // Results cache: post text -> model output. Cleared when settings change.
  const cache = new Map();
  function cacheGet(key) {
    return cache.has(key) ? cache.get(key) : undefined;
  }
  function cacheSet(key, val) {
    cache.set(key, val);
    if (cache.size > 600) cache.delete(cache.keys().next().value); // simple LRU-ish cap
  }
  const topicSig = () => (settings.careTopics || []).join('') + '' + (settings.avoidTopics || []).join('');

  // --- Ad label (local, never sent anywhere) --------------------------------
  const SPIN_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const AD_VERBS = ['Monetizing', 'Upselling', 'Sponsoring', 'Synergizing', 'Retargeting', 'Converting', 'Influencing', 'Optimizing'];

  function startAdSpinner(line) {
    stopAdSpinner(line);
    let frame = 0;
    let ticks = 0;
    let verb = 0;
    const render = () => {
      if (!line.isConnected) return stopAdSpinner(line);
      line.textContent = `${SPIN_FRAMES[frame]} ad · ${AD_VERBS[verb]}…`;
      frame = (frame + 1) % SPIN_FRAMES.length;
      if (++ticks % 38 === 0) verb = (verb + 1) % AD_VERBS.length;
    };
    render();
    line.__spinId = setInterval(render, 80);
  }
  function stopAdSpinner(line) {
    if (line && line.__spinId) {
      clearInterval(line.__spinId);
      line.__spinId = null;
    }
  }

  // --- Environment guards ---------------------------------------------------

  function contextAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  // --- DOM helpers (anchored on stable attributes, not hashed classes) ------

  function findPosts() {
    return document.querySelectorAll('div[role="listitem"], div.feed-shared-update-v2[role="article"]');
  }

  function findTextEl(post) {
    return (
      post.querySelector('p[componentkey^="feed-commentary"]') ||
      post.querySelector('span[data-testid="expandable-text-box"]') ||
      post.querySelector('.update-components-text') ||
      post.querySelector('.feed-shared-inline-show-more-text')
    );
  }

  // Extract the post's real text WITHOUT LinkedIn's "…see more" / "…ראה עוד" /
  // "טען עוד" control. That control is a <button>, so we drop buttons (any
  // language) rather than pattern-matching the localized word, then tidy any
  // leftover trailing ellipsis.
  function extractText(textEl) {
    const clone = textEl.cloneNode(true);
    clone.querySelectorAll('button, [role="button"]').forEach((el) => el.remove());
    return cleanText(clone.textContent || '');
  }

  const cleanText = (s) =>
    s
      .replace(/\s+(?:see|show|read)?\s*more\s*$/i, '') // english leftover, if any
      .replace(/(?:…|\.{2,3})\s*$/, '') // trailing ellipsis
      .trim();

  function clampTargets(textEl) {
    const t = [textEl];
    textEl.querySelectorAll('span[data-testid="expandable-text-box"]').forEach((s) => t.push(s));
    return t;
  }

  function showFullText(textEl) {
    clampTargets(textEl).forEach((el) => {
      el.style.setProperty('-webkit-line-clamp', 'unset', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('overflow', 'visible', 'important');
    });
    textEl.querySelectorAll('button').forEach((b) => {
      if (/^…?\s*(see\s+)?(more|less)\s*$/i.test((b.innerText || '').trim())) {
        b.dataset.mllHid = '1';
        b.style.display = 'none';
      }
    });
  }

  function restoreClamp(textEl) {
    clampTargets(textEl).forEach((el) => {
      el.style.removeProperty('-webkit-line-clamp');
      el.style.removeProperty('max-height');
      el.style.removeProperty('overflow');
    });
    textEl.querySelectorAll('button[data-mll-hid="1"]').forEach((b) => {
      b.style.display = '';
      delete b.dataset.mllHid;
    });
  }

  function onFeedPage() {
    const p = location.pathname;
    return (
      p === '/feed/' ||
      p === '/feed' ||
      p.startsWith('/feed/update/') ||
      p.startsWith('/posts/') ||
      p.startsWith('/in/')
    );
  }

  function isPromoted(post, textEl) {
    for (const el of post.querySelectorAll('span, div')) {
      const t = el.textContent.trim();
      if (t.length > 60) continue;
      if (!/^(Promoted|Sponsored)( by\b|$)/.test(t)) continue;
      if (!textEl) return true;
      if (el.compareDocumentPosition(textEl) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
    }
    return false;
  }

  // --- Scanning: mark posts, then do the AI work only near the viewport -----

  // Gate the actual work on visibility, and — crucially — CANCEL it the moment a
  // post scrolls fully above the viewport. The zone reaches ~500px below the
  // viewport ("about to see") but stops at the top edge ("already scrolled
  // over"), so we only ever compute what you're seeing or about to see.
  const workObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const post = e.target;
        const textEl = post.__mllTextEl;
        if (!textEl) continue;
        const state = textEl.getAttribute(PROCESSED);
        if (e.isIntersecting) {
          if (state === 'queued') startWork(post, textEl);
        } else if (state === 'pending') {
          // Left the zone before it finished — drop the queued/in-flight work.
          post.__mllAbort?.abort();
          resetQueued(textEl, post);
        }
      }
    },
    { rootMargin: '0px 0px 500px 0px' }
  );

  function resetQueued(textEl, post) {
    textEl.setAttribute(PROCESSED, 'queued'); // retry if it scrolls back into view
    post.__mllAbort = null;
  }

  function startWork(post, textEl) {
    textEl.setAttribute(PROCESSED, 'pending');
    const ac = new AbortController();
    post.__mllAbort = ac;
    doWork(post, textEl, ac.signal).catch(() => {});
  }

  function scanAll() {
    if (!contextAlive() || !settings.enabled || !onFeedPage()) return;
    findPosts().forEach((post) => {
      const textEl = findTextEl(post);
      if (!textEl || textEl.hasAttribute(PROCESSED)) return;
      textEl.setAttribute(PROCESSED, 'queued');
      post.__mllTextEl = textEl;
      workObserver.observe(post);
    });
  }

  function restoreAll() {
    workObserver.disconnect();
    document.querySelectorAll(`[${PROCESSED}]`).forEach((textEl) => {
      const host = textEl.closest('div[role="listitem"], div.feed-shared-update-v2');
      host?.__mllAbort?.abort();
      if (host) {
        host.__mllAbort = null;
        host.__mllModelVerdict = null;
      }
      textEl.style.display = '';
      textEl.style.maxHeight = '';
      textEl.style.opacity = '';
      textEl.style.overflow = '';
      textEl.style.transition = '';
      restoreClamp(textEl);
      stopAdSpinner(textEl.__mllSummaryEl?.querySelector('.mll-line'));
      textEl.__mllSummaryEl?.remove();
      textEl.__mllVerdictRow?.remove();
      textEl.__mllBusy?.remove();
      textEl.__mllBusy = null;
      textEl.closest('div[role="listitem"], div.feed-shared-update-v2')?.classList.remove('mll-muted-card');
      delete textEl.__mllIsAd;
      delete textEl.__mllHeb;
      textEl.removeAttribute(PROCESSED);
    });
  }

  // Live "calculating now" indicator — shown while a post's model call is in
  // flight, cleared the instant the result renders or the work is aborted.
  function showBusy(textEl) {
    clearBusy(textEl);
    const busy = document.createElement('div');
    busy.className = 'mll-busy';
    busy.dir = textEl.__mllHeb ? 'rtl' : 'ltr';
    const spin = document.createElement('span');
    spin.className = 'mll-busy__spin';
    const label = document.createElement('span');
    label.textContent = MLL.t('analyzing');
    busy.append(spin, label);
    textEl.insertAdjacentElement('afterend', busy);
    textEl.__mllBusy = busy;
  }
  function clearBusy(textEl) {
    textEl.__mllBusy?.remove();
    textEl.__mllBusy = null;
  }

  // Abort → keep the post retryable; other misses (unavailable AI) → give up.
  const settle = (textEl, post, signal) => {
    clearBusy(textEl);
    if (signal.aborted) resetQueued(textEl, post);
    else if (textEl.getAttribute(PROCESSED) !== 'done') textEl.setAttribute(PROCESSED, 'skip');
  };

  async function doWork(post, textEl, signal) {
    // Ads: a local rotating label, never summarized or sent anywhere.
    if (isPromoted(post, textEl)) {
      textEl.__mllIsAd = true;
      reveal(textEl, { ad: true });
      return;
    }

    const text = extractText(textEl);
    if (text.length < 40) {
      textEl.setAttribute(PROCESSED, 'skip');
      return;
    }

    const lang = MLL.detectLang(text); // output follows the post's own language
    textEl.__mllHeb = lang === 'he';
    const care = settings.careTopics || [];
    const avoid = settings.avoidTopics || [];

    // Classify whenever the verdict is on, even with no topics set yet — the
    // tags need to be visible so you can 👍/👎 them to build your lists.
    const needVerdict = settings.showVerdict;
    const transform = MLL.findTransform(settings, settings.activeTransform);
    const tPrompt = MLL.promptFor(transform, lang);
    const needTransform = !!tPrompt && text.length >= MIN_CHARS;

    if (!needVerdict && !needTransform) {
      textEl.setAttribute(PROCESSED, 'skip');
      return;
    }

    const tName = MLL.transformName(transform);
    showBusy(textEl); // visible "calculating now" marker until a result lands

    if (needVerdict && needTransform) {
      // Speed path: one call returns verdict + rewrite.
      const key = `a|${settings.activeTransform}|${topicSig()}|${lang}|${text}`;
      let res = cacheGet(key);
      if (res === undefined) {
        res = await engine.analyze(text, tPrompt, lang, care, avoid, signal);
        if (!signal.aborted) cacheSet(key, res);
      }
      if (!contextAlive() || signal.aborted || !res || !textEl.isConnected) return settle(textEl, post, signal);
      renderVerdict(post, textEl, res);
      if (res.rewrite) reveal(textEl, { text: res.rewrite, name: tName });
    } else if (needVerdict) {
      const key = `v|${topicSig()}|${lang}|${text}`;
      let v = cacheGet(key);
      if (v === undefined) {
        v = await engine.classify(text, lang, care, avoid, signal);
        if (!signal.aborted) cacheSet(key, v);
      }
      if (!contextAlive() || signal.aborted || !v || !textEl.isConnected) return settle(textEl, post, signal);
      renderVerdict(post, textEl, v);
    } else {
      const key = `t|${settings.activeTransform}|${lang}|${text}`;
      let out = cacheGet(key);
      if (out === undefined) {
        out = await engine.transform(text, tPrompt, lang, signal);
        if (!signal.aborted) cacheSet(key, out);
      }
      if (!contextAlive() || signal.aborted || !out || !textEl.isConnected) return settle(textEl, post, signal);
      reveal(textEl, { text: out, name: tName });
    }

    settle(textEl, post, signal);
  }

  // --- Verdict pill (native-styled, subtle) ---------------------------------

  // Final verdict = the model's, overridden by your explicit topic thumbs:
  // a liked topic → relevant, a disliked topic → muted, BOTH → neutral (cancel).
  function finalVerdict(model) {
    const care = new Set(settings.careTopics || []);
    const avoid = new Set(settings.avoidTopics || []);
    const liked = model.topics.some((t) => care.has(t));
    const disliked = model.topics.some((t) => avoid.has(t));
    if (liked && disliked) return 'neutral';
    if (disliked) return 'muted';
    if (liked) return 'relevant';
    // "Muted" is reserved for posts that match one of YOUR avoid topics — never
    // let the model mute on its own (Nano sometimes does, with no real reason).
    return model.verdict === 'muted' ? 'neutral' : model.verdict;
  }

  // 👍/👎 a topic → add it to care/avoid (mutually exclusive; clicking the
  // active thumb clears it). Saved persistently; restyles the feed instantly
  // with no model calls.
  function rateTopic(topic, dir) {
    const wasUp = (settings.careTopics || []).includes(topic);
    const wasDown = (settings.avoidTopics || []).includes(topic);
    const care = (settings.careTopics || []).filter((t) => t !== topic);
    const avoid = (settings.avoidTopics || []).filter((t) => t !== topic);
    if (dir === 'up' && !wasUp) care.push(topic);
    if (dir === 'down' && !wasDown) avoid.push(topic);
    settings.careTopics = care;
    settings.avoidTopics = avoid;
    pendingLocalTopics = JSON.stringify({ c: care, a: avoid });
    MLL.saveSettings({ careTopics: care, avoidTopics: avoid });
    restyleAll();
  }

  // Re-evaluate every already-rendered verdict against the current topic lists
  // (cheap: reuses each post's stored model output, no model calls).
  function restyleAll() {
    document.querySelectorAll('div[role="listitem"], div.feed-shared-update-v2').forEach((post) => {
      if (post.__mllModelVerdict && post.__mllTextEl?.isConnected) {
        renderVerdict(post, post.__mllTextEl, post.__mllModelVerdict);
      }
    });
  }

  function renderVerdict(post, textEl, model) {
    clearBusy(textEl);
    textEl.__mllVerdictRow?.remove();
    post.__mllModelVerdict = model; // kept so thumbs can restyle without recompute

    const care = new Set(settings.careTopics || []);
    const avoid = new Set(settings.avoidTopics || []);
    const verdict = finalVerdict(model);

    const row = document.createElement('div');
    row.className = 'mll-row';
    row.dir = textEl.__mllHeb ? 'rtl' : 'ltr';

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'mll-badge mll-badge--' + verdict;
    chip.textContent = MLL.t(verdict);
    row.appendChild(chip);

    for (const topic of model.topics) {
      const state = care.has(topic) ? 'up' : avoid.has(topic) ? 'down' : '';
      const tag = document.createElement('span');
      tag.className = 'mll-topic' + (state ? ' mll-topic--' + state : '');

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'mll-thumb mll-thumb--up';
      up.textContent = '👍';
      up.title = 'I care about this topic';
      up.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rateTopic(topic, 'up');
      });

      const label = document.createElement('span');
      label.className = 'mll-topic__label';
      label.textContent = topic;

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'mll-thumb mll-thumb--down';
      down.textContent = '👎';
      down.title = 'Not interested in this topic';
      down.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        rateTopic(topic, 'down');
      });

      tag.append(up, label, down);
      row.appendChild(tag);
    }

    if (model.reason) {
      const reason = document.createElement('span');
      reason.className = 'mll-reason';
      reason.textContent = model.reason;
      row.appendChild(reason);
    }

    post.classList.toggle('mll-muted-card', verdict === 'muted');
    if (verdict === 'muted') {
      chip.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        post.classList.toggle('mll-muted-card');
      });
    }

    const anchor = textEl.__mllSummaryEl && textEl.__mllSummaryEl.isConnected ? textEl.__mllSummaryEl : textEl;
    anchor.insertAdjacentElement('afterend', row);
    textEl.__mllVerdictRow = row;
  }

  // --- Transform reveal (Defluffer-style cross-fade) ------------------------

  function reveal(textEl, pending) {
    clearBusy(textEl);
    textEl.setAttribute(PROCESSED, 'done');
    const isAd = pending.ad;

    // The line copies the post's own computed typography so it matches LinkedIn.
    const cs = getComputedStyle(textEl);
    const summaryEl = document.createElement('div');
    summaryEl.className = 'mll-summary';
    summaryEl.style.paddingLeft = cs.paddingLeft;
    summaryEl.style.paddingRight = cs.paddingRight;

    const line = document.createElement('div');
    line.className = 'mll-line';
    if (isAd) {
      line.textContent = `${SPIN_FRAMES[0]} ad · ${AD_VERBS[0]}…`;
      line.style.direction = 'ltr';
      line.style.textAlign = 'left';
    } else {
      line.textContent = pending.text;
      line.style.whiteSpace = 'pre-line'; // keep transform line breaks (e.g. fluff)
      line.setAttribute('dir', textEl.__mllHeb ? 'rtl' : 'auto');
      line.style.textAlign = 'start';
    }
    line.style.color = cs.color;
    line.style.fontSize = cs.fontSize;
    line.style.fontWeight = cs.fontWeight;
    line.style.lineHeight = cs.lineHeight;
    line.style.fontFamily = cs.fontFamily;

    const shownLabel = isAd ? 'show the ad' : `${pending.name} · ${MLL.t('showOriginal')}`;
    const hiddenLabel = isAd ? 'hide the ad' : MLL.t('showTransformed');

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'mll-badge';
    badge.setAttribute('dir', 'ltr');
    badge.textContent = shownLabel;

    summaryEl.append(line, badge);
    textEl.__mllSummaryEl = summaryEl;

    const origH = textEl.offsetHeight;
    textEl.insertAdjacentElement('afterend', summaryEl);
    const sumH = summaryEl.offsetHeight;
    if (isAd) startAdSpinner(line);

    textEl.style.overflow = 'hidden';
    textEl.style.maxHeight = origH + 'px';
    textEl.style.opacity = '1';
    summaryEl.style.overflow = 'hidden';
    summaryEl.style.maxHeight = '0px';
    summaryEl.style.opacity = '0';
    void textEl.offsetHeight;

    textEl.style.transition = 'max-height .45s ease, opacity .3s ease';
    summaryEl.style.transition = 'max-height .45s ease, opacity .45s ease .08s';
    requestAnimationFrame(() => {
      textEl.style.maxHeight = '0px';
      textEl.style.opacity = '0';
      summaryEl.style.maxHeight = sumH + 'px';
      summaryEl.style.opacity = '1';
      summaryEl.classList.add('mll-flash');
    });

    setTimeout(() => {
      if (textEl.getAttribute(PROCESSED) !== 'done') return;
      textEl.style.display = 'none';
      summaryEl.style.maxHeight = 'none';
      summaryEl.style.transition = '';
      summaryEl.classList.remove('mll-flash');
    }, 700);

    let showing = false;
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showing = !showing;
      textEl.style.transition = '';
      if (showing) {
        textEl.style.display = '';
        textEl.style.opacity = '1';
        showFullText(textEl);
        line.style.display = 'none';
        if (isAd) stopAdSpinner(line);
      } else {
        textEl.style.display = 'none';
        line.style.display = '';
        if (isAd) startAdSpinner(line);
      }
      badge.textContent = showing ? hiddenLabel : shownLabel;
    });
  }

  // --- Availability toast ----------------------------------------------------

  let availabilityChecked = false;
  async function checkAvailability() {
    if (availabilityChecked) return;
    availabilityChecked = true;
    const ok = await engine.ensureAvailable();
    if (ok || document.querySelector('.mll-toast')) return;

    const toast = document.createElement('div');
    toast.className = 'mll-toast';
    const title = document.createElement('strong');
    title.textContent = MLL.t('unavailableTitle');
    const help = document.createElement('p');
    help.textContent = MLL.t('unavailableHelp');
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = MLL.t('dismiss');
    close.addEventListener('click', () => toast.remove());
    toast.append(title, help, close);
    document.body.appendChild(toast);
  }

  // --- Feed watching (throttle + safety net) --------------------------------

  let scanTimer = null;
  let lastScan = 0;
  function scheduleScan() {
    const since = Date.now() - lastScan;
    clearTimeout(scanTimer);
    if (since >= 500) {
      lastScan = Date.now();
      scanAll();
    } else {
      scanTimer = setTimeout(() => {
        lastScan = Date.now();
        scanAll();
      }, 500 - since);
    }
  }

  function teardown() {
    observer.disconnect();
    clearInterval(safetyNet);
  }

  const observer = new MutationObserver(() => {
    if (!contextAlive()) return teardown();
    if (settings.enabled) scheduleScan();
  });

  const safetyNet = setInterval(() => {
    if (!contextAlive()) return teardown();
    if (settings.enabled) scanAll();
  }, 1500);

  // --- Boot & live settings -------------------------------------------------

  const REPROCESS_KEYS = [
    'enabled', 'activeTransform', 'careTopics', 'avoidTopics',
    'showVerdict', 'customTransforms',
  ];

  MLL.getSettings().then((s) => {
    settings = s;
    observer.observe(document.body, { childList: true, subtree: true });
    if (settings.enabled) {
      scanAll();
      checkAvailability();
    }
  });

  MLL.onSettingsChanged(async (changes) => {
    if (!REPROCESS_KEYS.some((k) => k in changes)) return;
    const next = await MLL.getSettings();
    const topicsOnly = Object.keys(changes).every((k) => k === 'careTopics' || k === 'avoidTopics');
    const sig = JSON.stringify({ c: next.careTopics, a: next.avoidTopics });

    // Our own thumb edit echoing back — just restyle, don't recompute.
    if (topicsOnly && sig === pendingLocalTopics) {
      settings = next;
      pendingLocalTopics = null;
      restyleAll();
      return;
    }

    settings = next;
    cache.clear(); // topic/transform edits invalidate cached outputs
    restoreAll();
    if (settings.enabled) scanAll();
  });
})();
