(async function () {
  const el = (id) => document.getElementById(id);
  let settings = await MLL.getSettings();

  const parseLines = (text) =>
    text.split('\n').map((l) => l.trim()).filter(Boolean);
  const newId = () =>
    self.crypto && crypto.randomUUID ? crypto.randomUUID() : 'c' + Date.now() + Math.random();

  let savedTimer = null;
  function flashSaved() {
    const s = el('saved');
    s.textContent = MLL.t('saved');
    s.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (s.hidden = true), 1400);
  }

  async function patch(p) {
    settings = { ...settings, ...p };
    await MLL.saveSettings(p);
    flashSaved();
  }

  const debounce = (fn, ms) => {
    let t = null;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  // ---- static labels -------------------------------------------------------

  el('appName').textContent = MLL.t('appName');
  el('tagline').textContent = MLL.t('tagline');
  document.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = MLL.t(n.dataset.i18n)));
  el('careTitle').textContent = MLL.t('careTitle');
  el('careHint').textContent = MLL.t('careHint');
  el('avoidTitle').textContent = MLL.t('avoidTitle');
  el('avoidHint').textContent = MLL.t('avoidHint');
  el('customTitle').textContent = MLL.t('customTitle');
  el('customHint').textContent = MLL.t('customHint');
  el('addTransform').textContent = MLL.t('addTransform');

  // ---- transform picker ----------------------------------------------------

  function populateTransforms() {
    const select = el('activeTransform');
    const current = settings.activeTransform;
    select.textContent = '';
    for (const transform of MLL.allTransforms(settings)) {
      const opt = document.createElement('option');
      opt.value = transform.id;
      opt.textContent = MLL.transformName(transform);
      select.appendChild(opt);
    }
    // If the active transform was deleted, fall back to Off.
    select.value = MLL.findTransform(settings, current) ? current : 'none';
    if (select.value !== current) patch({ activeTransform: select.value });
  }

  // ---- custom transform rows ----------------------------------------------

  function addCustomRow(transform) {
    const t = transform || { id: newId(), name: '', promptEn: '', promptHe: '' };
    const item = document.createElement('div');
    item.className = 'custom-item';
    item.dataset.id = t.id;

    const mkField = (labelKey, value, placeholder, cls, multiline) => {
      const field = document.createElement('div');
      field.className = 'field';
      const label = document.createElement('label');
      label.textContent = MLL.t(labelKey);
      const input = document.createElement(multiline ? 'textarea' : 'input');
      if (!multiline) input.type = 'text';
      input.className = cls;
      input.placeholder = placeholder;
      input.value = value || '';
      input.addEventListener('input', saveCustomsDebounced);
      field.append(label, input);
      return field;
    };

    item.appendChild(mkField('nameLabel', t.name, MLL.t('namePlaceholder'), 'c-name', false));
    item.appendChild(mkField('promptEnLabel', t.promptEn, MLL.t('promptPlaceholder'), 'c-en', true));
    item.appendChild(mkField('promptHeLabel', t.promptHe, MLL.t('promptHePlaceholder'), 'c-he', true));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'remove';
    remove.textContent = MLL.t('remove');
    remove.addEventListener('click', () => {
      item.remove();
      saveCustoms();
    });
    item.appendChild(remove);

    el('customList').appendChild(item);
  }

  function collectCustoms() {
    const out = [];
    document.querySelectorAll('#customList .custom-item').forEach((item) => {
      const name = item.querySelector('.c-name').value.trim();
      const promptEn = item.querySelector('.c-en').value.trim();
      const promptHe = item.querySelector('.c-he').value.trim();
      if (!name || (!promptEn && !promptHe)) return; // drop incomplete rows
      out.push({ id: item.dataset.id, name, promptEn, promptHe });
    });
    return out;
  }

  async function saveCustoms() {
    await patch({ customTransforms: collectCustoms() });
    populateTransforms(); // reflect new/removed customs in the picker
  }
  const saveCustomsDebounced = debounce(saveCustoms, 450);

  // ---- initial render ------------------------------------------------------

  const updateCount = (kind) => {
    const n = parseLines(el(kind + 'Topics').value).length;
    el(kind + 'Count').textContent = n ? `(${n})` : '';
  };

  el('enabled').checked = settings.enabled;
  el('showVerdict').checked = settings.showVerdict;
  el('careTopics').value = (settings.careTopics || []).join('\n');
  el('avoidTopics').value = (settings.avoidTopics || []).join('\n');
  updateCount('care');
  updateCount('avoid');
  (settings.customTransforms || []).forEach(addCustomRow);
  populateTransforms();

  if (typeof LanguageModel === 'undefined') {
    const n = el('unavailable');
    n.textContent = MLL.t('unavailable');
    n.hidden = false;
  }

  // ---- wiring --------------------------------------------------------------

  el('enabled').addEventListener('change', (e) => patch({ enabled: e.target.checked }));
  el('showVerdict').addEventListener('change', (e) => patch({ showVerdict: e.target.checked }));
  el('activeTransform').addEventListener('change', (e) => patch({ activeTransform: e.target.value }));
  el('careTopics').addEventListener('input', (e) => {
    updateCount('care');
    debouncedCare(e.target.value);
  });
  el('avoidTopics').addEventListener('input', (e) => {
    updateCount('avoid');
    debouncedAvoid(e.target.value);
  });
  const debouncedCare = debounce((v) => patch({ careTopics: parseLines(v) }), 450);
  const debouncedAvoid = debounce((v) => patch({ avoidTopics: parseLines(v) }), 450);
  el('addTransform').addEventListener('click', () => addCustomRow());
})();
