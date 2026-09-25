import { describe, expect, it } from 'vitest';
import {
  buildTranscribeRequest,
  foldVoiceLog,
  isAudioAttachment,
  parseTranscribeResponse,
  parseVoiceButtonId,
  sniffAudio,
  VOICE_BUTTON_PREFIX,
  VOICE_CARD_MAX_CHARS,
  voiceAudioOf,
  voiceButtons,
  voiceCardText,
  type VoiceLogEvent,
} from './voice.js';

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe('what counts as a voice message', () => {
  const tgVoice = { type: 'audio' as const, url: 'data:audio/opus;base64,T2dnUw==' };

  it('is audio and nothing else: no text, every attachment audio', () => {
    expect(voiceAudioOf({ content: '', attachments: [tgVoice] })).toEqual([tgVoice]);
    expect(voiceAudioOf({ content: '  \n', attachments: [tgVoice] })).toEqual([tgVoice]);
  });

  it('is not audio with a caption — the caption says the file is material, not speech', () => {
    expect(voiceAudioOf({ content: 'trim this', attachments: [tgVoice] })).toBeUndefined();
  });

  it('is not audio beside a picture, and not a message with no attachment at all', () => {
    const img = { type: 'image' as const, url: 'https://x/y.png' };
    expect(voiceAudioOf({ content: '', attachments: [tgVoice, img] })).toBeUndefined();
    expect(voiceAudioOf({ content: '', attachments: [] })).toBeUndefined();
    expect(voiceAudioOf({ content: 'hi' })).toBeUndefined();
  });

  it('recognizes audio by element type, mime, data: URL, or extension — but not a bare .webm', () => {
    expect(isAudioAttachment({ type: 'audio', url: 'internal:lark/x' })).toBe(true);
    expect(isAudioAttachment({ type: 'file', url: 'https://x/a', mime: 'audio/mpeg; x=1' })).toBe(true);
    expect(isAudioAttachment({ type: 'file', url: 'data:audio/ogg;base64,AA==' })).toBe(true);
    expect(isAudioAttachment({ type: 'file', url: 'https://x/a', name: 'memo.M4A' })).toBe(true);
    expect(isAudioAttachment({ type: 'file', url: 'https://x/a', name: 'clip.webm' })).toBe(false);
    expect(isAudioAttachment({ type: 'file', url: 'https://x/a', name: 'clip.webm', mime: 'audio/webm' })).toBe(true);
    expect(isAudioAttachment({ type: 'file', url: 'https://x/a.pdf', name: 'a.pdf' })).toBe(false);
  });
});

describe('sniffAudio', () => {
  it('reads the container, not the declared label (Telegram says audio/opus; the bytes are Ogg)', () => {
    expect(sniffAudio(bytes('OggS', [0, 2]))).toEqual({ mime: 'audio/ogg', ext: '.ogg', supported: true });
  });

  it.each([
    ['wav', bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'audio/wav'],
    ['flac', bytes('fLaC'), 'audio/flac'],
    ['aiff', bytes('FORM', [0, 0, 0, 0], 'AIFF'), 'audio/aiff'],
    ['mp3 with ID3', bytes('ID3', [4]), 'audio/mp3'],
    ['mp3 frame', bytes([0xff, 0xfb, 0x90]), 'audio/mp3'],
    ['aac adts', bytes([0xff, 0xf1, 0x50]), 'audio/aac'],
    ['mp4/m4a', bytes([0, 0, 0, 0x20], 'ftypM4A '), 'audio/m4a'], // the documented name, not audio/mp4
    ['webm', bytes([0x1a, 0x45, 0xdf, 0xa3]), 'audio/webm'],
  ])('%s', (_name, b, mime) => {
    expect(sniffAudio(b)).toMatchObject({ mime, supported: true });
  });

  it('needs the RIFF / FORM frame, not just the chunk name at offset 8', () => {
    expect(sniffAudio(bytes('XXXX', [0, 0, 0, 0], 'WAVE'))).toBeUndefined();
  });

  it('names AMR and SILK so the refusal can, and marks them unsupported', () => {
    expect(sniffAudio(bytes('#!AMR\n'))).toMatchObject({ mime: 'audio/amr', supported: false });
    expect(sniffAudio(bytes('#!SILK_V3'))).toMatchObject({ mime: 'audio/silk', supported: false });
    expect(sniffAudio(bytes([0x02], '#!SILK_V3'))).toMatchObject({ mime: 'audio/silk', supported: false });
  });

  it('answers undefined for bytes that are not audio', () => {
    expect(sniffAudio(bytes('%PDF-1.7'))).toBeUndefined();
    expect(sniffAudio(new Uint8Array())).toBeUndefined();
  });
});

describe('buildTranscribeRequest', () => {
  it('sends each part inline with its sniffed mime, at temperature 0', () => {
    const body = buildTranscribeRequest('gemini-3-flash', [{ mime: 'audio/ogg', base64: 'AAAA' }]) as {
      contents: Array<{ parts: unknown[] }>;
      generationConfig: Record<string, unknown>;
      systemInstruction: { parts: Array<{ text: string }> };
    };
    expect(body.contents[0]!.parts).toEqual([{ inline_data: { mime_type: 'audio/ogg', data: 'AAAA' } }]);
    expect(body.generationConfig['temperature']).toBe(0);
    expect(body.systemInstruction.parts[0]!.text).toMatch(/Simplified/);
    // Only asked to separate parts when there are parts to separate: said to a single recording,
    // the model once answered with the sentence twice.
    expect(body.systemInstruction.parts[0]!.text).not.toMatch(/audio parts/);
    const two = buildTranscribeRequest('gemini-3-flash', [
      { mime: 'audio/ogg', base64: 'AA' },
      { mime: 'audio/ogg', base64: 'BB' },
    ]) as { systemInstruction: { parts: Array<{ text: string }> } };
    expect(two.systemInstruction.parts[0]!.text).toMatch(/There are 2 audio parts/);
  });

  it('asks Gemini 3 for LOW thinking — not minimal, which gemini-3.7-flash refuses — and no one else', () => {
    const g3 = buildTranscribeRequest('gemini-3.6-flash', []) as { generationConfig: Record<string, unknown> };
    expect(g3.generationConfig['thinkingConfig']).toEqual({ thinkingLevel: 'low' });
    const off = buildTranscribeRequest('gemini-3-flash', [], { thinking: false }) as { generationConfig: Record<string, unknown> };
    expect(off.generationConfig['thinkingConfig']).toBeUndefined();
    const gemma = buildTranscribeRequest('gemma-4-31b-it', []) as { generationConfig: Record<string, unknown> };
    expect(gemma.generationConfig['thinkingConfig']).toBeUndefined();
  });
});

describe('parseTranscribeResponse', () => {
  const answer = (parts: unknown[], extra: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: {
      promptTokenCount: 262,
      candidatesTokenCount: 19,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 9 }, { modality: 'AUDIO', tokenCount: 253 }],
    },
    ...extra,
  });

  it('reads the transcript and the audio token count', () => {
    expect(parseTranscribeResponse(answer([{ text: '不是这样的提示词。' }]))).toEqual({
      ok: true,
      text: '不是这样的提示词。',
      usage: { promptTokens: 262, audioTokens: 253, outputTokens: 19 },
    });
  });

  it('never includes a thought part — reasoning pasted into someone’s message is the worst failure', () => {
    const r = parseTranscribeResponse(answer([{ text: 'The user seems to say…', thought: true }, { text: '你好' }]));
    expect(r).toMatchObject({ ok: true, text: '你好' });
  });

  it('turns the no-speech sentinel into an empty transcript', () => {
    expect(parseTranscribeResponse(answer([{ text: '[no speech]\n' }]))).toMatchObject({ ok: true, text: '' });
  });

  it('reports a blocked prompt or a non-STOP finish as a failure, not as silence', () => {
    expect(parseTranscribeResponse({ promptFeedback: { blockReason: 'OTHER' } })).toEqual({
      ok: false,
      reason: 'the transcriber refused the audio (OTHER)',
    });
    const r = parseTranscribeResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('SAFETY') });
  });

  it('survives shapes it does not know', () => {
    expect(parseTranscribeResponse(null)).toMatchObject({ ok: false });
    expect(parseTranscribeResponse({})).toMatchObject({ ok: false });
    expect(parseTranscribeResponse({ candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: 'no' })).toEqual({
      ok: true,
      text: 'x',
      usage: {},
    });
  });
});

describe('the card', () => {
  const base = { text: '帮我看下 CI 为什么挂了', model: 'gemini-3-flash', latencyMs: 2712 };

  it('is labelled as a transcript in every state, pending and final alike', () => {
    for (const status of ['pending', 'sent', 'auto', 'auto-no-buttons', 'cancelled', 'expired', 'superseded', 'called-off'] as const) {
      const text = voiceCardText({ ...base, status });
      expect(text.startsWith('🎙️ Voice transcript · gemini-3-flash · 2.7s')).toBe(true);
      expect(text).toContain(base.text);
    }
  });

  it('says on every final state whether anything was sent', () => {
    expect(voiceCardText({ ...base, status: 'sent' })).toMatch(/Sent to the agent/);
    expect(voiceCardText({ ...base, status: 'auto' })).toMatch(/automatically/);
    for (const status of ['cancelled', 'expired', 'called-off'] as const) {
      expect(voiceCardText({ ...base, status })).toMatch(/nothing was sent/);
    }
    expect(voiceCardText({ ...base, status: 'superseded' })).toMatch(/not sent/);
    expect(voiceCardText({ ...base, status: 'called-off', reason: 'context cleared' })).toMatch(/context cleared/);
  });

  it('previews a long transcript and says the full text is what gets sent', () => {
    const long = 'x'.repeat(VOICE_CARD_MAX_CHARS + 500);
    const text = voiceCardText({ ...base, text: long, status: 'pending' });
    expect(text).toContain('500 more characters not shown here');
    expect(text.length).toBeLessThan(VOICE_CARD_MAX_CHARS + 400);
  });

  it('button ids round-trip, and nothing else parses as one', () => {
    const [send, cancel] = voiceButtons('ab12cd34');
    expect(parseVoiceButtonId(send!.id)).toEqual({ reqId: 'ab12cd34', action: 'send' });
    expect(parseVoiceButtonId(cancel!.id)).toEqual({ reqId: 'ab12cd34', action: 'cancel' });
    expect(parseVoiceButtonId(`${VOICE_BUTTON_PREFIX}ab12cd34:2`)).toBeNull();
    expect(parseVoiceButtonId('ask:ab12cd34:0')).toBeNull();
    // Telegram's 64-byte callback_data cap.
    expect(Buffer.byteLength(send!.id)).toBeLessThan(64);
  });
});

describe('foldVoiceLog', () => {
  const ev = (e: Partial<VoiceLogEvent> & Pick<VoiceLogEvent, 'id' | 'event'>): string =>
    JSON.stringify({ at: '2026-09-25T10:00:00.000Z', conversation: 'tg#1#', ...e });
  const transcribed = (id: string, text: string, conversation = 'tg#1#') =>
    ev({
      id,
      event: 'transcribed',
      conversation,
      platform: 'tg',
      messageId: `m-${id}`,
      user: 'u1',
      audio: [{ path: `/a/${id}.ogg`, mime: 'audio/ogg', bytes: 10 }],
      model: 'gemini-3-flash',
      latencyMs: 2000,
      text,
    } as Partial<VoiceLogEvent> & Pick<VoiceLogEvent, 'id' | 'event'>);
  const outcome = (id: string, o: string, reason?: string) =>
    ev({ id, event: 'outcome', outcome: o, ...(reason ? { reason } : {}) } as Partial<VoiceLogEvent> &
      Pick<VoiceLogEvent, 'id' | 'event'>);

  it('folds each transcript with its latest outcome, oldest first', () => {
    const items = foldVoiceLog(
      [transcribed('a', 'first'), outcome('a', 'sent'), transcribed('b', 'second'), outcome('b', 'cancelled')],
      'tg#1#',
      10
    );
    expect(items.map((i) => [i.id, i.status, i.text, i.audio])).toEqual([
      ['a', 'sent', 'first', '/a/a.ogg'],
      ['b', 'cancelled', 'second', '/a/b.ogg'],
    ]);
  });

  it('shows a transcript with no outcome yet as pending, and a failure that never had one', () => {
    const items = foldVoiceLog([transcribed('a', 'hi'), outcome('z', 'failed', 'HTTP 503')], 'tg#1#', 10);
    expect(items.map((i) => [i.id, i.status, i.reason])).toEqual([
      ['a', 'pending', undefined],
      ['z', 'failed', 'HTTP 503'],
    ]);
  });

  it('keeps to one conversation, honours the limit, and skips lines it cannot read', () => {
    const items = foldVoiceLog(
      [transcribed('a', 'mine'), transcribed('b', 'theirs', 'tg#2#'), '{torn', '', transcribed('c', 'mine too')],
      'tg#1#',
      1
    );
    expect(items.map((i) => i.id)).toEqual(['c']);
  });
});
