/**
 * TTS provider layer for Read Aloud — the pure half.
 *
 * Read Aloud speaks the current page through any of: the local platform voice
 * (speechSynthesis, no key), ElevenLabs, Fish Audio, Mistral (Voxtral), Google
 * Gemini TTS, or any OpenAI-compatible /audio/speech endpoint. This module
 * holds everything testable without a browser or network: provider metadata,
 * voice-list response parsers, Gemini PCM→WAV framing, sentence chunking and
 * settings normalization. The network + playback half lives in tts.js.
 */

export const TTS_PROVIDERS = {
  local: {
    label: 'Local system voice (no key)',
    needsKey: false,
    voiceFetch: 'local',
    hint: 'Uses the voices installed with your operating system.',
  },
  elevenlabs: {
    label: 'ElevenLabs',
    needsKey: true,
    baseUrl: 'https://api.elevenlabs.io/v1',
    voiceFetch: 'elevenlabs',
    modelHint: 'eleven_multilingual_v2',
    hint: 'Key from elevenlabs.io → Profile → API Keys. Voices + models are fetched live.',
  },
  fish: {
    label: 'Fish Audio',
    needsKey: true,
    baseUrl: 'https://api.fish.audio',
    voiceFetch: 'fish',
    modelHint: 's2.1-pro',
    hint: 'Key from fish.audio → API. Voice models are fetched live; model header selects s2.1-pro / s2-pro.',
  },
  mistral: {
    label: 'Mistral (Voxtral TTS)',
    needsKey: true,
    baseUrl: 'https://api.mistral.ai/v1',
    voiceFetch: 'mistral',
    modelHint: 'voxtral-tts',
    hint: 'Key from console.mistral.ai → API Keys. Preset and custom voices are fetched live.',
  },
  gemini: {
    label: 'Google Gemini TTS',
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    voiceFetch: 'gemini',
    modelHint: 'gemini-2.5-flash-preview-tts',
    hint: 'Key from aistudio.google.com → Get API key. Uses the 30 prebuilt Gemini voices.',
  },
  custom: {
    label: 'Custom OpenAI-compatible',
    needsKey: true,
    baseUrl: '',
    voiceFetch: 'manual',
    modelHint: 'tts-1',
    hint: 'POSTs {baseUrl}/audio/speech with Bearer auth — OpenAI, local gateways (OpenedAI, Kokoro-FastAPI), etc.',
  },
};

/** The 30 prebuilt Gemini TTS voices (no list endpoint — the catalogue is fixed). */
export const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

/** Gemini TTS-capable models offered in the picker (free to type others). */
export const GEMINI_TTS_MODELS = [
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
];

/** Familiar OpenAI voice ids, shown as a hint for the custom provider. */
export const OPENAI_TTS_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

/** Playback speeds offered in the player. */
export const TTS_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** Defaults merged under whatever the user saved. */
export const TTS_DEFAULTS = {
  provider: 'local',
  speed: 1,
  autoAdvance: true,
  keys: {},      // per-provider api keys, so switching providers keeps each key
  voices: {},    // per-provider last-used voice
  models: {},    // per-provider last-used model
  baseUrls: {},  // per-provider override (mainly 'custom')
};

/** Shape arbitrary saved settings into a complete TTS settings object. */
export function normalizeTtsSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const provider = TTS_PROVIDERS[r.provider] ? r.provider : 'local';
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    ...TTS_DEFAULTS,
    ...r,
    provider,
    speed: num(r.speed, 1, 0.5, 2),
    autoAdvance: r.autoAdvance !== false,
    keys: { ...(r.keys || {}) },
    voices: { ...(r.voices || {}) },
    models: { ...(r.models || {}) },
    baseUrls: { ...(r.baseUrls || {}) },
  };
}

/* ── Voice-list parsers (one per provider shape) ────────────────────────── */

const clean = (v, max = 120) => String(v == null ? '' : v).trim().slice(0, max);

/** GET /v1/voices → { voices: [{ voice_id, name, labels, preview_url }] } */
export function parseElevenLabsVoices(json) {
  const list = Array.isArray(json?.voices) ? json.voices : [];
  return list.filter((v) => v && typeof v === 'object').map((v) => ({
    id: clean(v.voice_id ?? v.id),
    name: clean(v.name) || clean(v.voice_id),
    detail: [v.labels?.accent, v.labels?.gender, v.labels?.age].map((x) => clean(x)).filter(Boolean).join(' · '),
  })).filter((v) => v.id);
}

/** GET /model?page_size=100 → { items: [{ _id, title, type }] } (type 'tts' only) */
export function parseFishVoices(json) {
  const list = Array.isArray(json?.items) ? json.items : [];
  return list.filter((m) => !m.type || m.type === 'tts').map((m) => ({
    id: clean(m._id ?? m.id),
    name: clean(m.title) || clean(m._id),
    detail: clean(m.languages?.join('/'), 40),
  })).filter((v) => v.id);
}

/** GET /v2/audio/voices → { data: [{ id, name, type }], next_page_token } */
export function parseMistralVoices(json) {
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.filter((v) => v && typeof v === 'object').map((v) => ({
    id: clean(v.id ?? v.name),
    name: clean(v.name) || clean(v.id),
    detail: [v.type, v.gender].map((x) => clean(x)).filter(Boolean).join(' · '),
  })).filter((v) => v.id);
}

const asArray = (v) => (Array.isArray(v) ? v : v != null ? [v] : []);

/** Map a provider's raw voice payload to {id, name, detail} rows. */
export function parseVoiceList(provider, json) {
  if (provider === 'elevenlabs') return parseElevenLabsVoices(json);
  if (provider === 'fish') return parseFishVoices(json);
  if (provider === 'mistral') return parseMistralVoices(json);
  return [];
}

/* ── Gemini PCM → WAV ───────────────────────────────────────────────────── */

/** Wrap headerless 16-bit little-endian mono PCM in a RIFF/WAVE container so
 *  an <audio> element can play it. Gemini TTS returns 24 kHz samples. */
export function pcmBytesToWav(pcm, sampleRate = 24000, channels = 1) {
  const data = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
  const buf = new ArrayBuffer(44 + data.length);
  const view = new DataView(buf);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  const blockAlign = channels * 2;
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);          // PCM chunk size
  view.setUint16(20, 1, true);           // format = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, 'data');
  view.setUint32(40, data.length, true);
  new Uint8Array(buf, 44).set(data);
  return new Uint8Array(buf);
}

/** Pull the base64 audio out of a Gemini generateContent TTS response. */
export function geminiTtsAudio(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const withAudio = parts.find((p) => p?.inlineData?.data || p?.inline_data?.data);
  const b64 = withAudio ? (withAudio.inlineData?.data || withAudio.inline_data?.data) : null;
  return b64 ? String(b64) : null;
}

/* ── Speech chunking ────────────────────────────────────────────────────── */

/** Split page text into speakable chunks at sentence boundaries, staying under
 *  `max` characters per request (cloud providers charge per request and cap
 *  input; local voices also sound better with shorter utterances). */
export function splitSpeechChunks(text, max = 2200) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  if (src.length <= max) return [src];
  const out = [];
  // Break after sentence enders (keep the punctuation), then pack sentences
  // into chunks without splitting mid-sentence unless a single sentence alone
  // exceeds the budget.
  const sentences = src.match(/[^.!?。！？…]+[.!?。！？…]+["')\]]*\s*|[^.!?。！？…]+$/g) || [src];
  let cur = '';
  for (const s of sentences) {
    const piece = s.trim();
    if (!piece) continue;
    if (piece.length > max) {
      if (cur) { out.push(cur.trim()); cur = ''; }
      for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max).trim());
      continue;
    }
    if (cur && cur.length + piece.length + 1 > max) { out.push(cur.trim()); cur = piece; }
    else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/* ── Headless self-test ─────────────────────────────────────────────────── */

export function ttsSelfTest() {
  const out = { checks: {}, errors: [] };
  try {
    const el = parseElevenLabsVoices({ voices: [{ voice_id: 'v1', name: 'Rachel', labels: { accent: 'american', gender: 'female' } }, { name: '' }] });
    out.checks.eleven = el.length === 1 && el[0].id === 'v1' && el[0].name === 'Rachel' && /american/.test(el[0].detail);

    const fish = parseFishVoices({ items: [{ _id: 'm1', title: 'My clone', type: 'tts' }, { _id: 'm2', title: 'svc thing', type: 'svc' }] });
    out.checks.fish = fish.length === 1 && fish[0].id === 'm1' && fish[0].name === 'My clone';

    const mis = parseMistralVoices({ data: [{ id: 'u1', name: 'Atlas', type: 'preset', gender: 'male' }], next_page_token: null });
    out.checks.mistral = mis.length === 1 && mis[0].id === 'u1' && mis[0].name === 'Atlas';

    const wav = pcmBytesToWav(new Uint8Array([1, 2, 3, 4]), 24000);
    const dv = new DataView(wav.buffer);
    out.checks.wav = wav.length === 48
      && String.fromCharCode(wav[0], wav[1], wav[2], wav[3]) === 'RIFF'
      && dv.getUint32(24, true) === 24000
      && dv.getUint32(40, true) === 4;

    out.checks.geminiAudio = geminiTtsAudio({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: 'QUJD' } }] } }] }) === 'QUJD';

    const chunks = splitSpeechChunks('One. Two. Three. '.repeat(400), 2200);
    out.checks.chunks = chunks.length > 1 && chunks.every((c) => c.length <= 2200)
      && splitSpeechChunks('')[0] === undefined
      && splitSpeechChunks('Short.')[0] === 'Short.';

    const s = normalizeTtsSettings({ provider: 'nope', speed: 9 });
    out.checks.settings = s.provider === 'local' && s.speed === 2 && Array.isArray(GEMINI_VOICES) && GEMINI_VOICES.length === 30;

    out.passed = Object.values(out.checks).every(Boolean);
  } catch (e) {
    out.errors.push(String(e && e.stack ? e.stack : e));
    out.passed = false;
  }
  return out;
}
