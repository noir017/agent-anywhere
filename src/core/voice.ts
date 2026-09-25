/**
 * Voice messages as data: which inbound messages are voice messages, what their bytes really are,
 * what the transcriber is asked and how its answer is read, what the confirmation card says, and
 * how the transcript log folds back into a history.
 *
 * ── The feature, in one paragraph ─────────────────────────────────────────────
 * A message that is nothing but audio (a Telegram voice note, a Feishu voice message, a web UI
 * recording, an audio file sent without a caption) is transcribed by the daemon, the transcript is
 * SHOWN to the user — clearly labelled as a transcript — and, once they confirm it (or at once, with
 * `voice.confirm: false`), it re-enters the gateway exactly as if they had typed it. The agent never
 * learns that the words were spoken: no marker in the prompt, no attachment line, no hint. What it
 * can do, when a transcript reads oddly, is look it up (`agent-anywhere voice-log`), because every
 * transcription is logged with its audio file, model and outcome.
 *
 * ── Why a transcript is typed text, not an annotated attachment ───────────────
 * Because the user has read and approved it. An ASR guess the agent is told to be suspicious of is
 * a different (worse) product: the confirmation step exists so that what reaches the agent is what
 * the person meant, and past that step there is nothing left for the agent to second-guess.
 *
 * ── Why audio WITH a caption is left alone ────────────────────────────────────
 * "Trim this recording" plus an mp3 is an instruction about a file, and transcribing the file would
 * replace the instruction with song lyrics. So only a message that is audio and nothing else is a
 * voice message; everything else keeps its old meaning (the file is saved and its path handed to
 * the agent). A caption is the user's way of saying which one they meant.
 *
 * Pure: no clock, no IO. The daemon (daemon/voice.ts) downloads, calls the transcriber, posts the
 * card and writes the log; everything it decides with is here.
 */

import type { InboundMessage } from '../types.js';
import { formatButtonId, parseButtonId } from './button-id.js';

/** One inbound attachment, as the adapters normalize it. */
export type InboundAttachment = NonNullable<InboundMessage['attachments']>[number];

// ─────────────────────────────── limits ───────────────────────────────

/**
 * Largest audio file transcribed, in bytes.
 *
 * Set by the transport, not by taste: Gemini's inline-data route allows "20 MB total (including
 * prompts and all files)" per request (ai.google.dev/gemini-api/docs/audio, checked 2026-09-25),
 * and base64 inflates the bytes by 4/3 — 14 MiB is the largest file that still leaves room for the
 * prompt. At a voice note's Opus bitrate that is roughly an hour of speech, so the cap only ever
 * meets music files and long recordings, which are told so rather than truncated.
 */
export const VOICE_MAX_BYTES = 14 * 1024 * 1024;

/**
 * How long a transcript waits for its Send/Cancel tap.
 *
 * Long enough to be read after a distraction, short enough that a card found the next morning is
 * not sent into a conversation that has moved on. On expiry the card says so; nothing is sent.
 */
export const VOICE_PENDING_TTL_MS = 30 * 60_000;

/**
 * Most transcript characters the card itself shows.
 *
 * The card has to fit one message on every platform (Telegram: 4096), with a header and a status
 * line around it. A longer transcript is previewed and the card says how much is not shown — the
 * FULL text is what gets sent, so the cap limits the display, never the content.
 */
export const VOICE_CARD_MAX_CHARS = 3000;

// ─────────────────────────────── is this a voice message ───────────────────────────────

/** Extensions (with dot) that name an audio file when neither the element nor a mime says so. */
const AUDIO_EXTENSIONS = new Set([
  '.ogg', '.oga', '.opus', '.mp3', '.m4a', '.wav', '.flac', '.aac', '.aif', '.aiff', '.amr', '.silk', '.spx',
]);

/** Lowercase extension (with dot) of a filename; '' when none. */
function extOf(name: string | undefined): string {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * Whether an attachment is audio, by the strongest evidence available.
 *
 * The element type is the best of it (Telegram and Feishu say `audio` for a voice note), then a
 * declared mime, then the mime a `data:` URL carries (how every Telegram voice note arrives — as
 * `data:audio/opus;base64,…`), then the filename. `.webm` is deliberately not in the extension list:
 * it is as often video as audio, so it counts only when a mime says audio (the web UI's recorder
 * always sends one).
 */
export function isAudioAttachment(att: InboundAttachment): boolean {
  if (att.type === 'audio') return true;
  const mime = (att.mime?.toLowerCase().split(';')[0] ?? '').trim();
  if (mime.startsWith('audio/')) return true;
  if (att.url.startsWith('data:audio/')) return true;
  return AUDIO_EXTENSIONS.has(extOf(att.name));
}

/**
 * The audio to transcribe, or undefined when this is not a voice message.
 *
 * A voice message is one with no text of its own and at least one attachment, every one of which is
 * audio. A caption, or a picture beside the recording, makes it something else — see the file
 * header for why that line is where it is.
 */
export function voiceAudioOf(
  msg: Pick<InboundMessage, 'content' | 'attachments'>
): InboundAttachment[] | undefined {
  const atts = msg.attachments ?? [];
  if (atts.length === 0 || msg.content.trim().length > 0) return undefined;
  return atts.every(isAudioAttachment) ? atts : undefined;
}

// ─────────────────────────────── what the bytes are ───────────────────────────────

/** A recognized audio container, in the vocabulary the transcriber is sent. */
export interface AudioFormat {
  /** The mime the transcriber is told, in Gemini's documented spelling (`audio/mp3`, `audio/m4a`). */
  mime: string;
  /** Extension (with dot) for the saved file. */
  ext: string;
  /** Whether the transcriber decodes it. False means: say so, and send nothing. */
  supported: boolean;
}

/**
 * Container signatures, tested in order: `[offset, bytes, format]`. A table because the list is
 * the knowledge — each row is one format's magic number — and a chain of ifs hid that.
 */
const SIGNATURES: ReadonlyArray<readonly [number, string | readonly number[], AudioFormat]> = [
  [0, 'OggS', { mime: 'audio/ogg', ext: '.ogg', supported: true }],
  [8, 'WAVE', { mime: 'audio/wav', ext: '.wav', supported: true }], // after `RIFF` at 0 (checked below)
  [0, 'fLaC', { mime: 'audio/flac', ext: '.flac', supported: true }],
  [8, 'AIFF', { mime: 'audio/aiff', ext: '.aiff', supported: true }], // after `FORM` at 0
  [8, 'AIFC', { mime: 'audio/aiff', ext: '.aiff', supported: true }], // after `FORM` at 0
  [0, 'ID3', { mime: 'audio/mp3', ext: '.mp3', supported: true }],
  [4, 'ftyp', { mime: 'audio/m4a', ext: '.m4a', supported: true }],
  [0, [0x1a, 0x45, 0xdf, 0xa3], { mime: 'audio/webm', ext: '.webm', supported: true }],
  [0, '#!AMR', { mime: 'audio/amr', ext: '.amr', supported: false }],
  [0, '#!SILK', { mime: 'audio/silk', ext: '.silk', supported: false }],
  [1, '#!SILK', { mime: 'audio/silk', ext: '.silk', supported: false }], // WeChat's variant: a 0x02 byte first
];

/** The chunk a RIFF/FORM-framed signature at offset 8 must be preceded by. */
const FRAMED: Record<string, string> = { WAVE: 'RIFF', AIFF: 'FORM', AIFC: 'FORM' };

/**
 * Identify an audio file from its first bytes.
 *
 * Sniffed rather than trusted, because the declared types cannot be relied on to exist: Feishu
 * declares nothing at all for a voice message, a file sent from a phone is often
 * `application/octet-stream`, and Telegram labels every voice note with its codec (`audio/opus`)
 * rather than its container. The bytes are the one answer that is always there.
 *
 * `supported` follows Gemini's documented list (ai.google.dev/gemini-api/docs/audio, checked
 * 2026-09-25: WAV, MP3, AIFF, AAC, OGG, FLAC, MPEG, M4A, L16, Opus, ALAW, MULAW, WebM), and the
 * formats this gateway actually meets were verified by hand the same day, with real speech, through
 * newapi's google-ai-studio channels: Opus in Ogg (a Telegram voice note), and the WebM and MP4 that
 * Chromium's MediaRecorder produces from it (Opus inside both) — which is what the web UI records.
 * An MP4 goes over as `audio/m4a`, the documented name; `audio/mp4` is not on the list, even though
 * it happened to work. Safari records AAC in MP4 instead; AAC is documented, but that exact file was
 * not tried. AMR and SILK — the codecs QQ and WeCom use for voice — are recognized only so the
 * refusal can name them: Gemini does not list them, and the daemon image carries no ffmpeg to
 * convert them.
 */
export function sniffAudio(bytes: Uint8Array): AudioFormat | undefined {
  const matches = (offset: number, sig: string | readonly number[]): boolean => {
    const want = typeof sig === 'string' ? [...sig].map((c) => c.charCodeAt(0)) : sig;
    return want.every((b, i) => bytes[offset + i] === b);
  };
  for (const [offset, sig, format] of SIGNATURES) {
    const frame = typeof sig === 'string' ? FRAMED[sig] : undefined;
    if (matches(offset, sig) && (frame === undefined || matches(0, frame))) return format;
  }
  // Raw frame streams: an ADTS (AAC) header is a 0xFFF sync with layer bits 00; any other MPEG
  // sync word is an MP3 frame. ADTS first, because it is the narrower match.
  const b1 = bytes[1] ?? 0;
  if (bytes[0] === 0xff && (b1 & 0xf6) === 0xf0) return { mime: 'audio/aac', ext: '.aac', supported: true };
  if (bytes[0] === 0xff && (b1 & 0xe0) === 0xe0) return { mime: 'audio/mp3', ext: '.mp3', supported: true };
  return undefined;
}

// ─────────────────────────────── the transcriber ───────────────────────────────

/**
 * What the transcriber is told. Exported so the prompt is testable as data.
 *
 * Every rule here answers something a real transcript got wrong on 2026-09-25:
 *  - "only the transcript" — a chat model's instinct is to preface ("Here is the transcription:").
 *  - Simplified characters — the same Mandarin voice note came back in Traditional on one call and
 *    Simplified on the next. This deployment's users write Simplified; a transcript in the other
 *    script reads as someone else's words.
 *  - the glossary — without it "Agent Anywhere" came back as "Agent 或者 Anyway" and "agent or
 *    anyway"; with it, six runs out of six got it right. The names are the ones people using this
 *    gateway actually say out loud.
 *  - `[no speech]` — a sentinel instead of an empty answer, so silence is distinguishable from a
 *    response that went missing.
 *
 * The several-parts rule is added only when there ARE several (see transcribeInstructions): sent
 * with a single recording, one run in six answered with the sentence twice, as if obliging it.
 */
export const TRANSCRIBE_INSTRUCTIONS = [
  'You are a speech-to-text engine. Transcribe the speech in the audio verbatim, in the language it is spoken in.',
  'Output only the transcript: no preface, no quotes, no timestamps, no speaker labels, no translation, no summary.',
  'Add natural punctuation. Write Chinese in Simplified characters (简体中文), never Traditional.',
  'Keep technical terms, product names, file names, commands and code identifiers exactly as spoken; do not translate them.',
  'Names that often come up: Agent Anywhere, Claude Code, Codex, OpenCode, Antigravity, agy, Telegram, 飞书, GitHub, PR, CI.',
  'If the audio contains no intelligible speech, output exactly: [no speech]',
].join('\n');

/** The system instruction for this many audio parts. */
export function transcribeInstructions(parts: number): string {
  return parts > 1
    ? `${TRANSCRIBE_INSTRUCTIONS}\nThere are ${parts} audio parts: transcribe each in order, separated by a blank line.`
    : TRANSCRIBE_INSTRUCTIONS;
}

/** The no-speech sentinel TRANSCRIBE_INSTRUCTIONS asks for. */
const NO_SPEECH = '[no speech]';

/** One audio part as sent: sniffed mime + base64 bytes. */
export interface TranscribeAudio {
  mime: string;
  base64: string;
}

/**
 * The `generateContent` request body for one voice message.
 *
 * `temperature: 0` because a transcript has one right answer. The thinking level is set to `low`
 * for the Gemini 3 family, which has nothing to reason about here and otherwise spends 160-410
 * thought tokens per voice note (measured 2026-09-25). `low` specifically, not `minimal`: behind
 * newapi, `gemini-3-flash` is an alias mapped per channel to gemini-3.6-flash on some and
 * gemini-3.7-flash on others, and 3.7 answers `minimal` with HTTP 400 "Thinking level MINIMAL is
 * not supported for this model" — the same request succeeded or failed depending on which channel
 * it landed on. `low` was accepted by both. Other families spell the knob differently (2.5 takes
 * `thinkingBudget`) or reject it (Gemma), so they get none; and `thinking: false` drops it for the
 * retry daemon/voice.ts makes when a model refuses whatever this sends.
 */
export function buildTranscribeRequest(
  model: string,
  audio: TranscribeAudio[],
  opts: { thinking?: boolean } = {}
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { temperature: 0 };
  if ((opts.thinking ?? true) && /^gemini-3/i.test(model)) {
    generationConfig['thinkingConfig'] = { thinkingLevel: 'low' };
  }
  return {
    systemInstruction: { parts: [{ text: transcribeInstructions(audio.length) }] },
    contents: [
      {
        role: 'user',
        parts: audio.map((a) => ({ inline_data: { mime_type: a.mime, data: a.base64 } })),
      },
    ],
    generationConfig,
  };
}

/** Token accounting the transcriber reported, for the log. */
export interface TranscribeUsage {
  promptTokens?: number;
  audioTokens?: number;
  outputTokens?: number;
}

/** What a transcriber response amounted to. `text: ''` means it heard no speech. */
export type TranscribeParse =
  | { ok: true; text: string; usage: TranscribeUsage }
  | { ok: false; reason: string };

/** A non-negative finite number, else undefined — usage fields are best-effort decoration. */
function count(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** The usage block, tolerating any shape: none of it decides anything. */
function usageOf(body: Record<string, unknown>): TranscribeUsage {
  const meta = (body['usageMetadata'] ?? {}) as Record<string, unknown>;
  const details = Array.isArray(meta['promptTokensDetails']) ? meta['promptTokensDetails'] : [];
  const audio = details.find(
    (d): d is Record<string, unknown> =>
      typeof d === 'object' && d !== null && (d as Record<string, unknown>)['modality'] === 'AUDIO'
  );
  const usage: TranscribeUsage = {};
  const prompt = count(meta['promptTokenCount']);
  const audioTokens = count(audio?.['tokenCount']);
  const output = count(meta['candidatesTokenCount']);
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (audioTokens !== undefined) usage.audioTokens = audioTokens;
  if (output !== undefined) usage.outputTokens = output;
  return usage;
}

/**
 * Read a `generateContent` response.
 *
 * Thought parts are skipped (`thought: true`): a thinking model returns its reasoning as parts of
 * the same candidate, and pasting that into someone's message would be the worst possible failure.
 * A blocked prompt or a candidate that stopped for safety is a failure with its reason, not an empty
 * transcript — "no speech" would tell the user their microphone did not work.
 */
export function parseTranscribeResponse(body: unknown): TranscribeParse {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: 'the transcriber returned no JSON body' };
  const b = body as Record<string, unknown>;
  const feedback = b['promptFeedback'] as { blockReason?: unknown } | undefined;
  if (typeof feedback?.blockReason === 'string') {
    return { ok: false, reason: `the transcriber refused the audio (${feedback.blockReason})` };
  }
  const candidates = Array.isArray(b['candidates']) ? b['candidates'] : [];
  const first = candidates[0] as { content?: { parts?: unknown }; finishReason?: unknown } | undefined;
  if (!first) return { ok: false, reason: 'the transcriber returned no candidates' };
  const parts = Array.isArray(first.content?.parts) ? first.content.parts : [];
  const text = parts
    .filter((p): p is { text: string } => {
      const part = p as { text?: unknown; thought?: unknown };
      return typeof part.text === 'string' && part.thought !== true;
    })
    .map((p) => p.text)
    .join('')
    .trim();
  const finish = typeof first.finishReason === 'string' ? first.finishReason : undefined;
  if (!text && finish && finish !== 'STOP') {
    return { ok: false, reason: `the transcriber stopped without a transcript (${finish})` };
  }
  return { ok: true, text: text === NO_SPEECH ? '' : text, usage: usageOf(b) };
}

// ─────────────────────────────── the card ───────────────────────────────

/**
 * Where a transcript stands. Every one but `pending` is final, and each final one says on the card
 * whether anything was sent — the question a user scrolling back actually has.
 */
export type VoiceStatus =
  | 'pending'
  | 'sent'
  | 'auto'
  | 'auto-no-buttons'
  | 'cancelled'
  | 'expired'
  | 'superseded'
  | 'called-off';

/** The line under the transcript, per status. */
function statusLine(status: VoiceStatus, reason?: string): string {
  switch (status) {
    case 'pending':
      return 'Send this to the agent? Tap ✅ Send — or type a corrected version instead, and this one is dropped.';
    case 'sent':
      return '→ Sent to the agent.';
    case 'auto':
      return '→ Sent to the agent automatically.';
    case 'auto-no-buttons':
      return '→ Sent to the agent automatically (this platform cannot show confirm buttons).';
    case 'cancelled':
      return '✖ Cancelled — nothing was sent.';
    case 'expired':
      return `⌛ Expired after ${Math.round(VOICE_PENDING_TTL_MS / 60_000)} min — nothing was sent. Send the voice message again if you still want it.`;
    case 'superseded':
      return '✎ Replaced by the message you typed — this transcript was not sent.';
    case 'called-off':
      return `⏹ Called off (${reason ?? 'stopped'}) — nothing was sent.`;
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive);
    }
  }
}

/** What the card needs to know. */
export interface VoiceCardInput {
  text: string;
  model: string;
  latencyMs: number;
  status: VoiceStatus;
  /** Why it was called off, for `called-off` (`stopped`, `context cleared`). */
  reason?: string;
}

/**
 * The card: a label that cannot be mistaken for anything but a transcript, the transcript, and
 * where it stands.
 *
 * The label is on every state, final ones included, because the card outlives its buttons — it is
 * what a user scrolling back reads to learn why the agent is answering words they never typed.
 */
export function voiceCardText(input: VoiceCardInput): string {
  const seconds = (input.latencyMs / 1000).toFixed(1);
  const header = `🎙️ Voice transcript · ${input.model} · ${seconds}s`;
  const shown =
    input.text.length > VOICE_CARD_MAX_CHARS
      ? `${input.text.slice(0, VOICE_CARD_MAX_CHARS)}…\n(${input.text.length - VOICE_CARD_MAX_CHARS} more characters not shown here — the full text is what gets sent)`
      : input.text;
  return `${header}\n\n${shown}\n\n${statusLine(input.status, input.reason)}`;
}

/** Said instead of a card when there is nothing to confirm. */
export function voiceFailureText(reason: string): string {
  return `🎙️ Couldn't transcribe that voice message: ${reason}. Nothing was sent to the agent — type it instead, or send it again.`;
}

/** Said when the transcriber heard nothing. */
export const VOICE_NO_SPEECH_TEXT =
  '🎙️ No speech was recognized in that voice message. Nothing was sent to the agent.';

/** Said for a tap on a card the daemon no longer holds. */
export const VOICE_STALE_CLICK_TEXT =
  'That transcript is no longer waiting (already handled, expired, or the gateway restarted). Send the voice message again if it still needs sending.';

// ─────────────────────────────── buttons ───────────────────────────────

/** Button id prefix. Must not prefix, or be prefixed by, any other menu's (see daemon onButton). */
export const VOICE_BUTTON_PREFIX = 'vtx:';

/** Index 0 sends, 1 cancels. The index rather than a word keeps ids short (Telegram: 64 bytes). */
const SEND = 0;
const CANCEL = 1;

/** The two buttons of a pending card. Structurally a platform ButtonSpec (core cannot import it). */
export function voiceButtons(
  reqId: string
): Array<{ id: string; label: string; style: 'success' | 'danger' }> {
  return [
    { id: formatButtonId(VOICE_BUTTON_PREFIX, reqId, SEND), label: '✅ Send', style: 'success' },
    { id: formatButtonId(VOICE_BUTTON_PREFIX, reqId, CANCEL), label: '✖ Cancel', style: 'danger' },
  ];
}

/** Parse a voice-card button id, or null when it is not one (or names no action this card has). */
export function parseVoiceButtonId(buttonId: string): { reqId: string; action: 'send' | 'cancel' } | null {
  const parsed = parseButtonId(buttonId, VOICE_BUTTON_PREFIX);
  if (!parsed) return null;
  if (parsed.n === SEND) return { reqId: parsed.reqId, action: 'send' };
  if (parsed.n === CANCEL) return { reqId: parsed.reqId, action: 'cancel' };
  return null;
}

// ─────────────────────────────── the log ───────────────────────────────

/** Final outcomes, as recorded. `failed` and `no-speech` never had a card to confirm. */
export type VoiceOutcome = Exclude<VoiceStatus, 'pending'> | 'failed' | 'no-speech';

/** One audio file behind a transcript. */
export interface VoiceLogAudio {
  path: string;
  mime: string;
  bytes: number;
}

/**
 * One line of `voice-log.jsonl`.
 *
 * Append-only events keyed by `id` rather than one rewritten record per transcript: a line is
 * written the moment something is known (the transcript, then its outcome half an hour later), so
 * a crash between the two loses nothing already learned, and the file is never rewritten in place.
 */
export type VoiceLogEvent =
  | {
      id: string;
      at: string;
      event: 'transcribed';
      conversation: string;
      platform: string;
      messageId: string;
      user: string;
      audio: VoiceLogAudio[];
      model: string;
      latencyMs: number;
      usage?: TranscribeUsage;
      text: string;
    }
  | {
      id: string;
      at: string;
      event: 'outcome';
      conversation: string;
      outcome: VoiceOutcome;
      /** Why it failed, or why it was called off. */
      reason?: string;
      /** For a failure before any transcript: which audio it was about. */
      audio?: VoiceLogAudio[];
      messageId?: string;
    };

/** One transcript as `voice-log` reports it: the events of one id, folded. */
export interface VoiceHistoryItem {
  id: string;
  at: string;
  /** The final outcome, or `pending` while its card is still up. */
  status: VoiceOutcome | 'pending';
  text: string;
  model: string;
  latencyMs?: number;
  messageId: string;
  audio: string;
  reason?: string;
}

/** Parse one log line, or undefined for anything malformed (a torn last line, a hand edit). */
function parseEvent(line: string): VoiceLogEvent | undefined {
  if (!line.trim()) return undefined;
  try {
    const e = JSON.parse(line) as Partial<VoiceLogEvent>;
    if (typeof e.id !== 'string' || typeof e.conversation !== 'string') return undefined;
    if (e.event !== 'transcribed' && e.event !== 'outcome') return undefined;
    return e as VoiceLogEvent;
  } catch {
    return undefined;
  }
}

/**
 * This conversation's most recent transcripts, newest last, from raw log lines (oldest first).
 *
 * Scoped to one conversation because the caller is an agent working in it: another conversation's
 * voice notes are nobody's business here, however easy the file is to read.
 */
export function foldVoiceLog(lines: string[], conversation: string, limit: number): VoiceHistoryItem[] {
  const byId = new Map<string, VoiceHistoryItem>();
  for (const line of lines) {
    const e = parseEvent(line);
    if (!e || e.conversation !== conversation) continue;
    if (e.event === 'transcribed') {
      byId.set(e.id, {
        id: e.id,
        at: e.at,
        status: 'pending',
        text: e.text,
        model: e.model,
        latencyMs: e.latencyMs,
        messageId: e.messageId,
        audio: e.audio.map((a) => a.path).join(', '),
      });
      continue;
    }
    const item = byId.get(e.id) ?? {
      id: e.id,
      at: e.at,
      status: e.outcome,
      text: '',
      model: '',
      messageId: e.messageId ?? '',
      audio: (e.audio ?? []).map((a) => a.path).join(', '),
    };
    item.status = e.outcome;
    if (e.reason !== undefined) item.reason = e.reason;
    byId.set(e.id, item);
  }
  const all = [...byId.values()];
  return all.slice(Math.max(0, all.length - limit));
}
