#!/usr/bin/env node
/**
 * TTS test gate — Read Aloud provider layer (tts-core.js).
 *
 * Cloud TTS needs keys and network, so the gate exercises everything pure:
 * per-provider voice-list parsers against realistic payloads (ElevenLabs,
 * Fish Audio, Mistral), Gemini PCM→WAV framing byte-for-byte, sentence-bound
 * chunking, settings normalization, and the module self-test.
 *
 *   node scripts/tts-test.mjs
 */
import assert from 'node:assert/strict';
import {
  TTS_PROVIDERS, GEMINI_VOICES, GEMINI_TTS_MODELS, OPENAI_TTS_VOICES, TTS_SPEEDS,
  normalizeTtsSettings, parseVoiceList, parseElevenLabsVoices, parseFishVoices, parseMistralVoices,
  pcmBytesToWav, geminiTtsAudio, splitSpeechChunks, ttsSelfTest,
} from '../src/renderer/js/tts-core.js';

let n = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { n++; console.log(`PASS  ${name}`); })
    .catch((e) => { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; });
}

await t('provider catalogue covers every supported engine', () => {
  for (const id of ['local', 'elevenlabs', 'fish', 'mistral', 'gemini', 'custom']) {
    assert.ok(TTS_PROVIDERS[id], `missing provider ${id}`);
    assert.ok(TTS_PROVIDERS[id].label, `${id} needs a label`);
    assert.ok(TTS_PROVIDERS[id].hint, `${id} needs a setup hint`);
  }
  assert.equal(TTS_PROVIDERS.local.needsKey, false);
  for (const id of ['elevenlabs', 'fish', 'mistral', 'gemini', 'custom']) {
    assert.equal(TTS_PROVIDERS[id].needsKey, true, `${id} must be BYO-key`);
  }
  assert.equal(GEMINI_VOICES.length, 30);
  assert.ok(GEMINI_TTS_MODELS.length >= 2);
  assert.ok(OPENAI_TTS_VOICES.includes('alloy'));
  assert.ok(TTS_SPEEDS.includes(1) && TTS_SPEEDS.includes(0.5) && TTS_SPEEDS.includes(2));
});

await t('ElevenLabs voice list: voice_id/name/labels parsed, junk dropped', () => {
  const rows = parseElevenLabsVoices({
    voices: [
      { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', labels: { accent: 'american', gender: 'female' }, preview_url: 'https://x' },
      { voice_id: '', name: 'no id' },
      { name: 'still no id' },
      null,
    ],
  });
  assert.deepEqual(rows, [{ id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', detail: 'american · female' }]);
  assert.deepEqual(parseVoiceList('elevenlabs', null), []);
});

await t('Fish Audio model list: only tts-type models become voices', () => {
  const rows = parseFishVoices({
    total: 3,
    items: [
      { _id: 'abc123', title: 'Narrator clone', type: 'tts', languages: ['en', 'de'] },
      { _id: 'zzz', title: 'Stsvc model', type: 'svc' },
      { _id: 'noname', type: 'tts', title: '' },
    ],
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 'abc123', name: 'Narrator clone', detail: 'en/de' });
  assert.equal(rows[1].name, 'noname');
});

await t('Mistral voices: v2 data[] parsed with type/gender detail', () => {
  const rows = parseMistralVoices({
    data: [
      { id: '019b2bd7', name: 'Atlas', type: 'preset', gender: 'male' },
      { id: '', name: 'no id' },
    ],
    next_page_token: 'page2',
  });
  assert.deepEqual(rows, [{ id: '019b2bd7', name: 'Atlas', detail: 'preset · male' }]);
  assert.deepEqual(parseVoiceList('mistral', {}), []);
});

await t('Gemini PCM → WAV: valid RIFF header, 24 kHz mono 16-bit', () => {
  const pcm = new Uint8Array(9600); // 0.2 s at 24 kHz
  const wav = pcmBytesToWav(pcm, 24000);
  assert.equal(wav.length, 44 + 9600);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o) => String.fromCharCode(wav[o], wav[o + 1], wav[o + 2], wav[o + 3]);
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(dv.getUint16(20, true), 1);        // PCM
  assert.equal(dv.getUint16(22, true), 1);        // mono
  assert.equal(dv.getUint32(24, true), 24000);    // sample rate
  assert.equal(dv.getUint16(34, true), 16);       // bits
  assert.equal(tag(36), 'data');
  assert.equal(dv.getUint32(40, true), 9600);
  assert.equal(dv.getUint32(4, true), 36 + 9600); // RIFF size
});

await t('Gemini TTS audio extraction: inlineData and inline_data shapes', () => {
  assert.equal(geminiTtsAudio({ candidates: [{ content: { parts: [{ text: 'hi' }, { inlineData: { mimeType: 'audio/L16;rate=24000', data: 'QUJD' } }] } }] }), 'QUJD');
  assert.equal(geminiTtsAudio({ candidates: [{ content: { parts: [{ inline_data: { data: 'WFZa' } }] } }] }), 'WFZa');
  assert.equal(geminiTtsAudio({ candidates: [{ content: { parts: [{ text: 'no audio' }] } }] }), null);
  assert.equal(geminiTtsAudio(null), null);
});

await t('splitSpeechChunks: sentence bounds, hard-split long sentences, empty input', () => {
  assert.deepEqual(splitSpeechChunks('  '), []);
  assert.deepEqual(splitSpeechChunks('One short line.'), ['One short line.']);
  const long = 'A'.repeat(5000) + '. ' + 'B'.repeat(30) + '.';
  const chunks = splitSpeechChunks(long, 2200);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 2200));
  assert.equal(chunks[chunks.length - 1], 'B'.repeat(30) + '.');
  // CJK sentence enders split too
  const cjk = splitSpeechChunks('第一句。第二句。'.repeat(600), 2000);
  assert.ok(cjk.length > 1 && cjk.every((c) => c.length <= 2000));
});

await t('normalizeTtsSettings: unknown provider falls back, speed clamped', () => {
  const s = normalizeTtsSettings({ provider: 'bogus', speed: 11, keys: { elevenlabs: 'sk' }, voices: { gemini: 'Kore' } });
  assert.equal(s.provider, 'local');
  assert.equal(s.speed, 2);
  assert.equal(s.keys.elevenlabs, 'sk');
  assert.equal(s.voices.gemini, 'Kore');
  assert.equal(s.autoAdvance, true);
  assert.equal(normalizeTtsSettings(null).provider, 'local');
  assert.equal(normalizeTtsSettings({ autoAdvance: false }).autoAdvance, false);
});

await t('ttsSelfTest: module self-check green', () => {
  const r = ttsSelfTest();
  assert.deepEqual(r.errors, []);
  assert.equal(r.passed, true, JSON.stringify(r.checks));
});

console.log(process.exitCode ? `\n${n} passed, with failures` : `\nAll ${n} tts tests passed.`);
process.exit(process.exitCode || 0);
