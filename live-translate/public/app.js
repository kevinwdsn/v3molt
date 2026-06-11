/* Live Translate — client app
 *
 * Speech flow: browser SpeechRecognition (continuous, interim results)
 *   - interim text → debounced "partial" translation shown in the live panel
 *   - final text   → committed translation appended to the history
 * Typing flow: input box → committed translation
 * Playback: speechSynthesis when a voice for the target language exists.
 */

(() => {
  const $ = (id) => document.getElementById(id);
  const sourceSelect = $('source-lang');
  const targetChips = $('target-chips');
  const micBtn = $('mic-btn');
  const micLabel = $('mic-label');
  const textInput = $('text-input');
  const sendBtn = $('send-btn');
  const statusEl = $('status');
  const livePanel = $('live-panel');
  const liveText = $('live-text');
  const liveTranslations = $('live-translations');
  const historyEl = $('history');
  const autoSpeak = $('auto-speak');
  const backendBadge = $('backend-badge');

  const FEATURED = ['uz', 'ru', 'ht', 'ml', 'es', 'fr', 'ar', 'zh', 'hi', 'pt', 'vi', 'ko'];
  const MAX_TARGETS = 5;
  const PARTIAL_DEBOUNCE_MS = 700;

  let languages = [];
  let langByCode = new Map();
  let selectedTargets = loadJSON('lt.targets', ['uz']);
  let showAllChips = false;
  let listening = false;
  let recognition = null;
  let partialTimer = null;
  let partialSeq = 0;

  function loadJSON(key, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) || typeof v === 'string' ? v : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', isError);
  }

  // ----- setup -----

  async function init() {
    try {
      const [langRes, healthRes] = await Promise.all([
        fetch('/api/languages').then((r) => r.json()),
        fetch('/api/health').then((r) => r.json()),
      ]);
      languages = langRes.languages;
      langByCode = new Map(languages.map((l) => [l.code, l]));
      selectedTargets = selectedTargets.filter((c) => langByCode.has(c));
      if (selectedTargets.length === 0) selectedTargets = ['uz'];

      backendBadge.hidden = false;
      if (healthRes.ok) {
        backendBadge.textContent =
          healthRes.backend === 'anthropic' ? `Powered by Claude (${healthRes.model})` : 'Powered by Workers AI';
      } else {
        backendBadge.textContent = '⚠ No translation backend configured';
        setStatus('Server has no translation backend configured — set ANTHROPIC_API_KEY.', true);
      }

      renderSourceSelect();
      renderChips();
    } catch (err) {
      setStatus(`Failed to load app config: ${err.message}`, true);
    }
  }

  function renderSourceSelect() {
    const saved = loadJSON('lt.source', 'en');
    sourceSelect.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = 'Detect language (typing only)';
    sourceSelect.appendChild(auto);
    for (const lang of languages) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = `${lang.name} — ${lang.native_name}`;
      sourceSelect.appendChild(opt);
    }
    sourceSelect.value = langByCode.has(saved) || saved === 'auto' ? saved : 'en';
    sourceSelect.addEventListener('change', () => {
      save('lt.source', sourceSelect.value);
      if (listening) restartRecognition();
    });
  }

  function renderChips() {
    targetChips.innerHTML = '';
    const featured = FEATURED.map((c) => langByCode.get(c)).filter(Boolean);
    const rest = languages.filter((l) => !FEATURED.includes(l.code));
    const visible = showAllChips ? [...featured, ...rest] : featured;
    // Always show selected languages even when collapsed
    for (const code of selectedTargets) {
      const lang = langByCode.get(code);
      if (lang && !visible.includes(lang)) visible.push(lang);
    }
    for (const lang of visible) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (selectedTargets.includes(lang.code) ? ' selected' : '');
      chip.textContent = lang.name;
      chip.title = lang.native_name;
      chip.addEventListener('click', () => toggleTarget(lang.code));
      targetChips.appendChild(chip);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chip more';
    more.textContent = showAllChips ? 'show fewer' : `+ ${rest.length} more`;
    more.addEventListener('click', () => {
      showAllChips = !showAllChips;
      renderChips();
    });
    targetChips.appendChild(more);
  }

  function toggleTarget(code) {
    if (selectedTargets.includes(code)) {
      if (selectedTargets.length > 1) {
        selectedTargets = selectedTargets.filter((c) => c !== code);
      }
    } else if (selectedTargets.length < MAX_TARGETS) {
      selectedTargets = [...selectedTargets, code];
    } else {
      setStatus(`You can select up to ${MAX_TARGETS} languages.`);
      return;
    }
    save('lt.targets', selectedTargets);
    renderChips();
  }

  $('swap-btn').addEventListener('click', () => {
    const source = sourceSelect.value;
    const firstTarget = selectedTargets[0];
    if (source === 'auto' || !firstTarget) return;
    selectedTargets = [source, ...selectedTargets.slice(1)];
    sourceSelect.value = firstTarget;
    save('lt.source', firstTarget);
    save('lt.targets', selectedTargets);
    renderChips();
    if (listening) restartRecognition();
  });

  // ----- translation API -----

  async function translate(text, { partial = false } = {}) {
    const body = {
      text,
      targets: selectedTargets,
      source: sourceSelect.value,
      partial,
    };
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Translation failed (${res.status})`);
    return data;
  }

  async function commitTranslation(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setStatus('Translating…');
    try {
      const data = await translate(trimmed);
      appendHistory(trimmed, data.translations);
      setStatus('');
      if (autoSpeak.checked) {
        const firstLang = selectedTargets.find((c) => data.translations[c]);
        if (firstLang) speak(data.translations[firstLang], firstLang);
      }
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  function appendHistory(original, translations) {
    const entry = document.createElement('article');
    entry.className = 'entry';
    const orig = document.createElement('p');
    orig.className = 'original';
    orig.textContent = original;
    entry.appendChild(orig);
    for (const code of selectedTargets) {
      const text = translations[code];
      if (!text) continue;
      const lang = langByCode.get(code);
      const row = document.createElement('div');
      row.className = 'translation';
      if (lang && lang.rtl) row.dir = 'rtl';
      const tag = document.createElement('span');
      tag.className = 'lang-tag';
      tag.textContent = lang ? lang.name : code;
      const span = document.createElement('span');
      span.textContent = text;
      const speakBtn = document.createElement('button');
      speakBtn.className = 'speak-btn';
      speakBtn.type = 'button';
      speakBtn.title = 'Speak';
      speakBtn.textContent = '🔊';
      speakBtn.addEventListener('click', () => speak(text, code));
      row.append(tag, span, speakBtn);
      entry.appendChild(row);
    }
    historyEl.prepend(entry);
  }

  // ----- live (interim) translation -----

  function showLive(text) {
    livePanel.hidden = !text;
    liveText.textContent = text;
    if (!text) liveTranslations.innerHTML = '';
  }

  function schedulePartial(text) {
    clearTimeout(partialTimer);
    partialTimer = setTimeout(async () => {
      const seq = ++partialSeq;
      try {
        const data = await translate(text, { partial: true });
        if (seq !== partialSeq || livePanel.hidden) return; // stale or already finalized
        liveTranslations.innerHTML = '';
        for (const code of selectedTargets) {
          if (!data.translations[code]) continue;
          const lang = langByCode.get(code);
          const div = document.createElement('div');
          div.className = 'live-t';
          if (lang && lang.rtl) div.dir = 'rtl';
          const tag = document.createElement('span');
          tag.className = 'lang-tag';
          tag.textContent = lang ? lang.name : code;
          const span = document.createElement('span');
          span.textContent = data.translations[code];
          div.append(tag, span);
          liveTranslations.appendChild(div);
        }
      } catch {
        /* interim translation failures are non-fatal */
      }
    }, PARTIAL_DEBOUNCE_MS);
  }

  // ----- speech recognition -----

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function recognitionLang() {
    const code = sourceSelect.value === 'auto' ? 'en' : sourceSelect.value;
    const lang = langByCode.get(code);
    return lang ? lang.speech : 'en-US';
  }

  function startRecognition() {
    if (!SpeechRecognition) {
      setStatus('Speech recognition is not supported in this browser — use typing instead.', true);
      return;
    }
    recognition = new SpeechRecognition();
    recognition.lang = recognitionLang();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          partialSeq++; // invalidate in-flight partials for this utterance
          clearTimeout(partialTimer);
          showLive('');
          if (text) commitTranslation(text);
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim.trim()) {
        showLive(interim.trim());
        schedulePartial(interim.trim());
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'no-speech') return; // harmless, auto-restarts
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setStatus('Microphone access was denied. Allow it in your browser settings.', true);
        stopListening();
      } else if (event.error === 'language-not-supported') {
        setStatus('This browser cannot recognize speech in that language — use typing instead.', true);
        stopListening();
      } else {
        setStatus(`Speech recognition error: ${event.error}`, true);
      }
    };

    recognition.onend = () => {
      // Browsers stop recognition periodically; restart while listening is on.
      if (listening) {
        try { recognition.start(); } catch { /* already starting */ }
      }
    };

    try {
      recognition.start();
      listening = true;
      micBtn.classList.add('listening');
      micLabel.textContent = 'Stop listening';
      setStatus(`Listening (${recognition.lang})… speak naturally.`);
    } catch (err) {
      setStatus(`Could not start the microphone: ${err.message}`, true);
    }
  }

  function stopListening() {
    listening = false;
    micBtn.classList.remove('listening');
    micLabel.textContent = 'Start listening';
    showLive('');
    clearTimeout(partialTimer);
    if (recognition) {
      try { recognition.stop(); } catch { /* ignore */ }
      recognition = null;
    }
    setStatus('');
  }

  function restartRecognition() {
    stopListening();
    startRecognition();
  }

  micBtn.addEventListener('click', () => {
    if (listening) stopListening();
    else startRecognition();
  });

  // ----- typing -----

  function submitTyped() {
    const text = textInput.value;
    textInput.value = '';
    commitTranslation(text);
  }

  sendBtn.addEventListener('click', submitTyped);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitTyped();
  });

  // ----- text to speech -----

  function speak(text, langCode) {
    if (!('speechSynthesis' in window)) return;
    const lang = langByCode.get(langCode);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang ? lang.speech : langCode;
    const voices = speechSynthesis.getVoices();
    const exact = voices.find((v) => v.lang === utterance.lang);
    const prefix = voices.find((v) => v.lang.startsWith(langCode));
    const voice = exact || prefix;
    if (voice) utterance.voice = voice;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }

  autoSpeak.checked = localStorage.getItem('lt.autoSpeak') === '1';
  autoSpeak.addEventListener('change', () => {
    localStorage.setItem('lt.autoSpeak', autoSpeak.checked ? '1' : '0');
  });

  init();
})();
