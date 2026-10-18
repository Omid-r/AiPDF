/**
 * Read Aloud with pluggable TTS providers.
 *
 * The pure half (tts-core.js) holds provider metadata, voice-list parsers and
 * WAV framing; this module does the network + playback:
 *
 *   local        speechSynthesis (no key, offline)
 *   elevenlabs   POST /v1/text-to-speech/{voice}      xi-api-key      → mp3
 *   fish         POST /v1/tts (+ model header)        Bearer          → mp3
 *   mistral      POST /v1/audio/speech                Bearer          → JSON base64
 *   gemini       POST /models/{tts-model}:generateContent  x-goog-api-key → PCM → WAV
 *   custom       POST {base}/audio/speech             Bearer          → mp3
 *
 * Voice lists are fetched live from each provider with the user's own key
 * (BYO-key: nothing ships with credentials). Pages are split into
 * sentence-boundary chunks, synthesized ahead of playback, and driven through
 * a small play/pause/stop/speed player bar.
 */

import { state, activeDoc, settings, saveSettings } from './store.js';
import { getPageText } from './viewer.js';
import {
  TTS_PROVIDERS, GEMINI_VOICES, GEMINI_TTS_MODELS, OPENAI_TTS_VOICES, TTS_SPEEDS,
  normalizeTtsSettings, parseVoiceList, pcmBytesToWav, geminiTtsAudio, splitSpeechChunks,
} from './tts-core.js';
import { el, toast, clamp } from './util.js';
import { showModal, formRow } from './dialog.js';
import { svgIcon } from './icons.js';
import { geminiBase } from './ai.js';

/* ── Settings ───────────────────────────────────────────────────────────── */

function ttsCfg() {
  if (!settings.tts) settings.tts = normalizeTtsSettings(null);
  return normalizeTtsSettings(settings.tts);
}

function saveTts(cfg) {
  settings.tts = cfg;
  saveSettings();
}

/** One merged view of the active provider's effective config. */
function providerCfg(cfg, provider = cfg.provider) {
  return {
    provider,
    apiKey: cfg.keys[provider] || '',
    baseUrl: cfg.baseUrls[provider] || TTS_PROVIDERS[provider].baseUrl || '',
    voice: cfg.voices[provider] || '',
    model: cfg.models[provider] || '',
  };
}

/** Headers + endpoint for one provider call. `expect` tells the main proxy
 *  whether to hand back JSON or base64 binary. */
function buildRequest(pc, text) {
  const p = pc.provider;
  if (p === 'elevenlabs') {
    const voice = pc.voice || '21m00Tcm4TlvDq8ikWAM'; // Rachel — ElevenLabs' canonical default
    const base = (pc.baseUrl || TTS_PROVIDERS.elevenlabs.baseUrl).replace(/\/+$/, '');
    return {
      url: `${base}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`,
      headers: { 'xi-api-key': pc.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: { text, model_id: pc.model || 'eleven_multilingual_v2' },
      expect: 'binary',
      mime: 'audio/mpeg',
    };
  }
  if (p === 'fish') {
    const base = (pc.baseUrl || TTS_PROVIDERS.fish.baseUrl).replace(/\/+$/, '');
    const body = { text, format: 'mp3', mp3_bitrate: 128, latency: 'balanced' };
    if (pc.voice) body.reference_id = pc.voice;
    return {
      url: `${base}/v1/tts`,
      headers: {
        Authorization: `Bearer ${pc.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        ...(pc.model ? { model: pc.model } : {}),
      },
      body,
      expect: 'binary',
      mime: 'audio/mpeg',
    };
  }
  if (p === 'mistral') {
    const base = (pc.baseUrl || TTS_PROVIDERS.mistral.baseUrl).replace(/\/+$/, '');
    const body = { input: text, response_format: 'mp3' };
    if (pc.voice) body.voice_id = pc.voice;
    if (pc.model) body.model = pc.model;
    return {
      url: `${base}/audio/speech`,
      headers: { Authorization: `Bearer ${pc.apiKey}`, 'Content-Type': 'application/json' },
      body,
      expect: 'json',
      mime: 'audio/mpeg',
      jsonAudio: (j) => j?.audio_data || null,
    };
  }
  if (p === 'gemini') {
    const base = geminiBase({ baseUrl: pc.baseUrl || TTS_PROVIDERS.gemini.baseUrl });
    const model = pc.model || 'gemini-2.5-flash-preview-tts';
    return {
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'x-goog-api-key': pc.apiKey, 'Content-Type': 'application/json' },
      body: {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: pc.voice || 'Kore' } } },
        },
      },
      expect: 'json',
      mime: 'audio/wav',
      jsonAudio: (j) => geminiTtsAudio(j),
      isPcm: true, // 24 kHz 16-bit mono headerless PCM → needs a WAV header
    };
  }
  // custom: OpenAI-compatible /audio/speech
  const base = (pc.baseUrl || '').replace(/\/+$/, '');
  if (!base) return null;
  return {
    url: `${base}/audio/speech`,
    headers: {
      ...(pc.apiKey ? { Authorization: `Bearer ${pc.apiKey}` } : {}),
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: { model: pc.model || 'tts-1', voice: pc.voice || 'alloy', input: text, response_format: 'mp3' },
    expect: 'binary',
    mime: 'audio/mpeg',
  };
}

/** Decode one provider response into { bytes, mime } (Uint8Array audio). */
function decodeAudio(spec, res) {
  if (spec.expect === 'json') {
    const b64 = spec.jsonAudio(res.json);
    if (!b64) throw new Error('The provider replied without audio data.');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes: spec.isPcm ? pcmBytesToWav(bytes, 24000) : bytes, mime: spec.mime };
  }
  if (!res.audioBase64) throw new Error('The provider replied without audio.');
  const bin = atob(res.audioBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime: res.contentType && /^audio\//.test(res.contentType) ? res.contentType : spec.mime };
}

/* ── Voice fetching (per provider, with the user's own key) ─────────────── */

export async function fetchVoiceList(provider, cfgOverride = null) {
  const cfg = cfgOverride || ttsCfg();
  const kind = TTS_PROVIDERS[provider]?.voiceFetch;
  if (kind === 'gemini') {
    return GEMINI_VOICES.map((v) => ({ id: v, name: v, detail: 'prebuilt' }));
  }
  if (kind === 'local') {
    const voices = (window.speechSynthesis?.getVoices?.() || []).map((v) => ({
      id: v.name, name: v.name, detail: [v.lang, v.localService ? 'offline' : 'online'].filter(Boolean).join(' · '),
    }));
    return voices;
  }
  const pc = providerCfg(cfg, provider);
  if (kind === 'manual') {
    return OPENAI_TTS_VOICES.map((v) => ({ id: v, name: v, detail: 'OpenAI classic voice' }));
  }
  if (provider === 'elevenlabs' && !pc.apiKey) throw new Error('Enter your ElevenLabs API key first.');
  if (provider === 'fish' && !pc.apiKey) throw new Error('Enter your Fish Audio API key first.');
  if (provider === 'mistral' && !pc.apiKey) throw new Error('Enter your Mistral API key first.');
  if (!window.api?.ttsRequest) throw new Error('TTS bridge unavailable in this build.');
  const endpoints = {
    elevenlabs: { url: `${(pc.baseUrl || TTS_PROVIDERS.elevenlabs.baseUrl).replace(/\/+$/, '')}/voices`, headers: { 'xi-api-key': pc.apiKey } },
    fish: { url: `${(pc.baseUrl || TTS_PROVIDERS.fish.baseUrl).replace(/\/+$/, '')}/model?page_size=100`, headers: { Authorization: `Bearer ${pc.apiKey}` } },
    mistral: { url: `${(pc.baseUrl || TTS_PROVIDERS.mistral.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '')}/v2/audio/voices?type=preset`, headers: { Authorization: `Bearer ${pc.apiKey}` } },
  };
  const ep = endpoints[provider];
  const res = await window.api.ttsRequest({ method: 'GET', ...ep, expect: 'json' });
  if (!res || !res.ok) throw new Error(res?.error ? res.error.slice(0, 220) : `Voice list failed (${res?.status || '?'})`);
  const rows = parseVoiceList(provider, res.json);
  if (!rows.length) throw new Error('The provider returned no voices for this key.');
  return rows;
}

/** Local platform voices (for the settings dialog when provider = local). */
function localVoicesSync() {
  return (window.speechSynthesis?.getVoices?.() || []).map((v) => ({ id: v.name, name: v.name }));
}

/* ── Synthesis ──────────────────────────────────────────────────────────── */

async function synthesize(pc, text) {
  const spec = buildRequest(pc, text);
  if (!spec) throw new Error('No base URL configured for the custom TTS provider.');
  if (spec.expect === 'binary' && !/fish|custom/.test(pc.provider) && !pc.apiKey) {
    throw new Error(`Enter your ${TTS_PROVIDERS[pc.provider].label} API key first (Read Aloud settings).`);
  }
  if (!window.api?.ttsRequest) throw new Error('TTS bridge unavailable in this build.');
  const res = await window.api.ttsRequest({ url: spec.url, headers: spec.headers, body: spec.body, expect: spec.expect });
  if (!res || !res.ok) {
    const detail = res?.error ? ` — ${res.error.slice(0, 180)}` : '';
    throw new Error(`TTS failed (${res?.status || '?'})${detail}`);
  }
  return decodeAudio(spec, res);
}

/* ── Player ─────────────────────────────────────────────────────────────── */

let player = null;
let runToken = 0;

function isActive() { return !!player; }
function isPaused() { return !!(player && player.paused); }

/** Keep the headless parity flag in sync (main.js --functional-test). */
function syncFlag() {
  window.__aipdfReadAloud = isActive() && !isPaused();
}

async function buildQueue(fromPage) {
  const doc = activeDoc();
  if (!doc) return [];
  const cfg = ttsCfg();
  const pages = [];
  const end = cfg.autoAdvance ? doc.numPages - 1 : fromPage;
  for (let i = clamp(fromPage, 0, doc.numPages - 1); i <= end; i++) {
    const text = (await getPageText(i) || '').replace(/\s+/g, ' ').trim();
    if (text) pages.push({ page: i, chunks: splitSpeechChunks(text) });
  }
  return pages;
}

function speakLocal(text, rate, { onend, onerror }) {
  const u = new SpeechSynthesisUtterance(text);
  u.rate = clamp(rate, 0.5, 2);
  const voiceName = ttsCfg().voices.local;
  if (voiceName) {
    const v = (window.speechSynthesis.getVoices() || []).find((x) => x.name === voiceName);
    if (v) { u.voice = v; u.lang = v.lang; }
  }
  u.onend = onend;
  u.onerror = onerror;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
  return u;
}

async function playCurrent() {
  const me = player;
  if (!me) return;
  const cfg = ttsCfg();
  const pc = providerCfg(cfg);
  const entry = me.queue[me.pos];
  if (!entry) { stopReadAloud(); return; }
  const chunk = entry.chunks[me.chunk];
  setBar('speaking');
  try {
    if (pc.provider === 'local') {
      if (!window.speechSynthesis) throw new Error('This system has no speech voice available.');
      me.utter = speakLocal(chunk, me.rate, {
        onend: () => { if (player === me) advance(); },
        onerror: () => { if (player === me) advance(); },
      });
      syncFlag();
    } else {
      setBar('loading');
      const { bytes, mime } = await synthesize(pc, chunk);
      if (player !== me) return; // stopped/restarted while synthesizing
      const blob = new Blob([bytes], { type: mime });
      const audio = new Audio(URL.createObjectURL(blob));
      audio.playbackRate = clamp(me.rate, 0.5, 2);
      audio.onended = () => { URL.revokeObjectURL(audio.src); if (player === me) advance(); };
      audio.onerror = () => { URL.revokeObjectURL(audio.src); if (player === me) advance(); };
      me.audio = audio;
      setBar('speaking');
      await audio.play();
    }
  } catch (e) {
    if (player !== me) return;
    toast(`Read aloud: ${e.message || e}`, 'err', 6000);
    stopReadAloud();
  }
}

function advance() {
  const me = player;
  if (!me) return;
  me.chunk++;
  const entry = me.queue[me.pos];
  if (entry && me.chunk < entry.chunks.length) return void playCurrent();
  me.pos++;
  me.chunk = 0;
  if (me.pos < me.queue.length) {
    const next = me.queue[me.pos];
    V_SCROLL(next.page);
    playCurrent();
  } else {
    stopReadAloud();
  }
}

/** Scroll without importing viewer wholesale — viewer is already loaded. */
function V_SCROLL(page) {
  import('./viewer.js').then((V) => V.scrollToPage(page)).catch(() => {});
}

export function startReadAloud(fromPage = null) {
  const doc = activeDoc();
  if (!doc) return;
  const cfg = ttsCfg();
  const pc = providerCfg(cfg);
  if (pc.provider !== 'local' && !pc.apiKey) {
    toast(`${TTS_PROVIDERS[pc.provider].label} needs an API key — set it up in Read Aloud settings.`, 'warn', 5000);
    openTtsSettings();
    return;
  }
  stopReadAloud();
  runToken++;
  const token = runToken;
  setBar('loading');
  buildQueue(fromPage ?? doc.currentPage ?? 0).then((queue) => {
    if (token !== runToken) return;
    if (!queue.length) {
      setBar(null);
      toast('No readable text found' + (settings.ocr ? '' : ' — if this is a scan, run OCR first.'), 'warn', 5000);
      return;
    }
    player = { queue, pos: 0, chunk: 0, rate: cfg.speed, paused: false, audio: null, utter: null, docId: doc.id, provider: pc.provider, voice: pc.voice };
    renderBar();
    playCurrent();
  });
}

export function pauseReadAloud() {
  const me = player;
  if (!me || me.paused) return;
  me.paused = true;
  if (me.audio) me.audio.pause();
  try { window.speechSynthesis?.pause(); } catch { /* ignore */ }
  syncFlag();
  setBar('paused');
}

export function resumeReadAloud() {
  const me = player;
  if (!me || !me.paused) return;
  me.paused = false;
  if (me.audio) me.audio.play();
  try { window.speechSynthesis?.resume(); } catch { /* ignore */ }
  syncFlag();
  setBar('speaking');
}

export function togglePauseReadAloud() {
  if (player?.paused) resumeReadAloud();
  else pauseReadAloud();
}

export function stopReadAloud() {
  runToken++;
  const me = player;
  player = null;
  if (me) {
    if (me.audio) { try { me.audio.pause(); URL.revokeObjectURL(me.audio.src); } catch { /* ignore */ } }
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }
  syncFlag();
  setBar(null);
}

export function setReadAloudSpeed(rate) {
  const r = clamp(Number(rate) || 1, 0.5, 2);
  if (!player) { const c = ttsCfg(); c.speed = r; saveTts(c); return; }
  const me = player;
  me.rate = r;
  const c = ttsCfg();
  c.speed = r;
  saveTts(c);
  if (me.audio) me.audio.playbackRate = r;
  else if (me.utter && !me.paused) {
    // speechSynthesis utterances cannot change rate mid-flight — restart the
    // current chunk so the new speed is heard immediately.
    const entry = me.queue[me.pos];
    if (entry) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
      me.utter = speakLocal(entry.chunks[me.chunk], r, {
        onend: () => { if (player === me) advance(); },
        onerror: () => { if (player === me) advance(); },
      });
    }
  }
}

/** Menu entry point — same item starts and stops (Acrobat/Foxit behaviour). */
export function toggleReadAloud() {
  if (isActive()) { stopReadAloud(); toast('Read aloud stopped', 'info'); return; }
  startReadAloud();
}

/* ── Player bar ─────────────────────────────────────────────────────────── */

let barEl = null;
let barStatus = null;
let barPlayBtn = null;
let barInfo = null;
let barPage = null;

function providerLabel() {
  const cfg = ttsCfg();
  const pc = providerCfg(cfg);
  const prov = TTS_PROVIDERS[pc.provider]?.label || pc.provider;
  const voice = pc.provider === 'local'
    ? (pc.voice || 'system voice')
    : (pc.voice || TTS_PROVIDERS[pc.provider]?.modelHint || 'default voice');
  return `${prov} · ${voice}`;
}

function setBar(mode) {
  if (!player && mode) return;           // no bar until playback starts
  if (!player) { barEl?.remove(); barEl = null; return; }
  renderBar();
  const entry = player.queue[player.pos];
  if (barStatus) {
    const entry = player.queue[player.pos];
    barStatus.textContent = mode === 'loading'
      ? 'Synthesizing…'
      : mode === 'paused' ? 'Paused'
        : mode === 'speaking' ? 'Reading…' : '';
    barStatus.classList.toggle('spin', mode === 'loading');
  }
  if (barPage && entry) barPage.textContent = `p.${entry.page + 1}`;
  if (barPlayBtn) {
    barPlayBtn.innerHTML = svgIcon(player.paused ? 'play' : 'pause', 16, 2);
    barPlayBtn.title = player.paused ? 'Resume' : 'Pause';
    barPlayBtn.classList.toggle('playing', !player.paused);
  }
}

function renderBar() {
  if (barEl && barEl.isConnected) return;
  barEl?.remove();
  barEl = el('div', { class: 'tts-bar' }, [
    el('span', { class: 'tts-icon', html: svgIcon('readAloud', 15) }),
    barInfo = el('span', { class: 'tts-info', text: providerLabel(), title: 'Read aloud — active provider and voice' }),
    barPlayBtn = el('button', {
      class: 'tts-btn primary', title: 'Pause', html: svgIcon('pause', 16, 2),
      onclick: () => togglePauseReadAloud(),
    }),
    el('button', {
      class: 'tts-btn', title: 'Stop reading', html: svgIcon('stop', 15, 2),
      onclick: () => stopReadAloud(),
    }),
    (() => {
      const sel = el('select', { class: 'tts-speed', title: 'Reading speed' });
      for (const s of TTS_SPEEDS) sel.appendChild(el('option', { value: String(s), text: `${s}×` }));
      sel.value = String(player?.rate ?? 1);
      if (![...sel.options].some((o) => o.value === sel.value)) sel.value = '1';
      sel.onchange = () => setReadAloudSpeed(Number(sel.value));
      return sel;
    })(),
    barPage = el('span', { class: 'tts-page' }),
    barStatus = el('span', { class: 'tts-status' }),
    el('button', {
      class: 'tts-btn ghost', title: 'Read aloud settings — provider, voice, speed', html: svgIcon('settings', 14, 1.9),
      onclick: () => openTtsSettings(),
    }),
  ]);
  document.body.appendChild(barEl);
}

/* ── Settings dialog ────────────────────────────────────────────────────── */

export async function openTtsSettings() {
  const cfg = ttsCfg();
  const draft = JSON.parse(JSON.stringify(cfg));

  const ok = await showModal({
    title: 'Read aloud — voice & provider',
    body: (b) => {
      b.appendChild(el('div', {
        class: 'hint',
        text: 'Pick a provider and bring your own key — nothing is shipped or shared. Voices are fetched live from the provider. "Local system voice" is free and offline.',
      }));

      const provider = el('select', {});
      for (const [id, meta] of Object.entries(TTS_PROVIDERS)) {
        provider.appendChild(el('option', { value: id, text: meta.label }));
      }
      provider.value = draft.provider;

      const key = el('input', { type: 'password', placeholder: 'API key' });
      const baseUrl = el('input', { type: 'text', placeholder: 'https://your-endpoint/v1  (falls back to the provider default)' });
      const model = el('input', { type: 'text', placeholder: 'model' });
      const modelList = el('datalist', { id: 'ttsModelList' });
      const voice = el('select', {});
      const voiceManual = el('input', { type: 'text', placeholder: 'voice id or name' });
      const speed = el('select', {});
      for (const s of TTS_SPEEDS) speed.appendChild(el('option', { value: String(s), text: `${s}×` }));
      const auto = el('input', { type: 'checkbox' });
      const status = el('div', { class: 'hint', text: '', style: { flex: '1', userSelect: 'text' } });

      const hintEl = el('div', { class: 'hint subtle' });
      const defaultBase = (id) => TTS_PROVIDERS[id]?.baseUrl || '';
      const syncProviderUi = () => {
        const id = provider.value;
        const meta = TTS_PROVIDERS[id];
        key.value = draft.keys[id] || '';
        // Auto-fill the provider's official endpoint when the engine changes;
        // an override is only kept if the user actually edits it away from
        // the default (see collect), so endpoint updates ship with the app.
        baseUrl.value = draft.baseUrls[id] || defaultBase(id);
        baseUrl.placeholder = id === 'local'
          ? 'Not needed — uses your system voices'
          : (defaultBase(id) || 'https://your-endpoint/v1');
        model.value = draft.models[id] || '';
        model.placeholder = meta.modelHint || 'model';
        voiceManual.style.display = meta.voiceFetch === 'manual' ? '' : 'none';
        voice.style.display = meta.voiceFetch === 'manual' ? 'none' : '';
        key.closest('.form-row')?.style.setProperty('display', meta.needsKey ? '' : 'none');
        hintEl.textContent = meta.hint;
        modelList.innerHTML = '';
        if (id === 'gemini') GEMINI_TTS_MODELS.forEach((m) => modelList.appendChild(el('option', { value: m })));
        fillVoices(id, true);
      };

      async function fillVoices(id, useSaved = false) {
        voice.innerHTML = '';
        const manualWrap = () => voiceManual.style.display === 'none';
        let rows = [];
        if (manualWrap() && useSaved) rows = [{ id: draft.voices[id] || '', name: draft.voices[id] || '(type a voice id below)' }];
        if (!manualWrap()) {
          voice.appendChild(el('option', { value: '', text: useSaved ? 'Loading voices…' : 'Choose a voice…' }));
        }
        try {
          rows = await fetchVoiceList(id, { ...draft, provider: id });
        } catch (e) {
          if (!manualWrap()) voice.appendChild(el('option', { value: '', text: 'Could not load voices — check key' }));
          status.textContent = e.message || String(e);
          return;
        }
        voice.innerHTML = '';
        if (!manualWrap()) voice.appendChild(el('option', { value: '', text: `Choose a voice… (${rows.length})` }));
        for (const r of rows) {
          voice.appendChild(el('option', { value: r.id, text: r.detail ? `${r.name} — ${r.detail}` : r.name }));
        }
        const saved = draft.voices[id] || '';
        voice.value = saved;
        if (saved && ![...voice.options].some((o) => o.value === saved)) {
          voice.appendChild(el('option', { value: saved, text: saved }));
          voice.value = saved;
        }
      }

      const fetchBtn = el('button', { class: 'mini-btn', text: 'Fetch voices', title: 'List the voices available to your key' });
      fetchBtn.onclick = async () => {
        collect();
        fetchBtn.disabled = true;
        status.textContent = 'Fetching voices…';
        try {
          await fillVoices(provider.value, false);
          status.textContent = 'Voices loaded.';
        } catch (e) {
          status.textContent = e.message || String(e);
        } finally { fetchBtn.disabled = false; }
      };

      const testBtn = el('button', { class: 'mini-btn primary', text: 'Test voice' });
      testBtn.onclick = async () => {
        collect();
        const pc = providerCfg(draft, provider.value);
        testBtn.disabled = true;
        status.textContent = pc.provider === 'local' ? 'Speaking with the system voice…' : 'Synthesizing…';
        try {
          stopReadAloud();
          const sentence = 'Hello — this is how Read Aloud will sound in your document.';
          if (pc.provider === 'local') {
            speakLocal(sentence, draft.speed, { onend: () => { status.textContent = '✓ OK'; }, onerror: () => { status.textContent = 'The system voice failed.'; } });
          } else {
            const { bytes, mime } = await synthesize(pc, sentence);
            const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
            const a = new Audio(url);
            a.playbackRate = draft.speed;
            a.onended = () => { URL.revokeObjectURL(url); status.textContent = '✓ Voice works'; };
            a.onerror = () => { URL.revokeObjectURL(url); status.textContent = 'Audio playback failed.'; };
            await a.play();
          }
        } catch (e) {
          status.textContent = '✗ ' + (e.message || e);
        } finally { testBtn.disabled = false; }
      };

      provider.onchange = syncProviderUi;
      key.oninput = () => { draft.keys[provider.value] = key.value.trim(); };
      baseUrl.oninput = () => { draft.baseUrls[provider.value] = baseUrl.value.trim(); };
      model.oninput = () => { draft.models[provider.value] = model.value.trim(); };
      voice.onchange = () => { draft.voices[provider.value] = voice.value; };
      voiceManual.oninput = () => { draft.voices[provider.value] = voiceManual.value.trim(); };
      speed.value = String(draft.speed);
      speed.onchange = () => { draft.speed = Number(speed.value); };
      auto.checked = draft.autoAdvance;
      auto.onchange = () => { draft.autoAdvance = auto.checked; };

      function collect() {
        draft.keys[provider.value] = key.value.trim();
        // Base URL: remember only genuine overrides — a field left at the
        // provider default tracks future default changes automatically.
        const url = baseUrl.value.trim();
        if (url && url !== defaultBase(provider.value)) draft.baseUrls[provider.value] = url;
        else delete draft.baseUrls[provider.value];
        draft.models[provider.value] = model.value.trim();
        if (voiceManual.style.display === 'none' && voice.value) draft.voices[provider.value] = voice.value;
        else if (voiceManual.style.display !== 'none') draft.voices[provider.value] = voiceManual.value.trim();
        draft.speed = Number(speed.value);
        draft.autoAdvance = auto.checked;
      }

      b.appendChild(el('div', { class: 'hint', text: 'Provider' }));
      b.appendChild(formRow('Engine', provider).row);
      b.appendChild(hintEl);
      b.appendChild(formRow('API key', key).row);
      b.appendChild(formRow('Base URL', baseUrl).row);
      b.appendChild(formRow('Model', [model, modelList]).row);
      b.appendChild(formRow('Voice', [voice, voiceManual, fetchBtn]).row);
      b.appendChild(el('div', { class: 'hint', text: 'Playback' }));
      b.appendChild(formRow('Speed', speed).row);
      b.appendChild(formRow('Continue to next page', auto, 'Keep reading through the whole document.').row);
      b.appendChild(el('div', { class: 'flex', style: { gap: '8px', alignItems: 'center', marginTop: '4px' } }, [testBtn, status]));
      syncProviderUi();
    },
    buttons: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Save', value: true, kind: 'primary', default: true },
    ],
  });

  if (ok) {
    saveTts(normalizeTtsSettings(draft));
    toast('Read aloud settings saved', 'ok');
    if (isActive()) { stopReadAloud(); } // provider may have changed — restart from the menu
  }
}
