/**
 * Inbound attachment download + text injection (platform-agnostic pure orchestration).
 *
 * Discord CDN URLs expire, so attachments are downloaded and cached. Readable text
 * documents are inlined into the agent prompt; binaries/images get a local path for
 * the agent to Read itself.
 *
 * Pure orchestration: aside from injected download/save (IO via DI), no side
 * effects, no clock, no globals/env — mocking download/save covers every branch.
 */

export interface AttachmentInput {
  type: 'image' | 'file';
  url: string;
  name?: string;
  mime?: string;
  size?: number;
}

export interface AttachmentIngestConfig {
  /** Inline readable text into the prompt only when ≤ this many bytes. */
  maxInjectBytes: number;
  /** Don't download above this many bytes; emit a metadata line only. */
  maxDownloadBytes: number;
}

export interface AttachmentIngestDeps {
  /**
   * Download; returns the bytes plus whatever the transport learned about them. Throws on failure.
   *
   * `contentType` is the HTTP header where there is one. `name` is a filename discovered during
   * the fetch, which only a platform-specific fetcher can supply — the platforms that need one
   * (Lark) are exactly those whose message elements declare no name and no mime, so for them
   * this is the ONLY chance to learn either. Both are fallbacks: what the element declared wins.
   */
  download(url: string): Promise<{ bytes: Uint8Array; contentType?: string; name?: string }>;
  /** Persist to the cache dir; returns the final absolute path. */
  save(name: string, bytes: Uint8Array): Promise<string>;
}

export interface IngestedAttachments {
  /** Text block appended to the agent prompt (may be ''): inlined text + "saved to <path>" lines. */
  promptText: string;
  /** Files persisted to disk (for logging / future use). */
  files: Array<{ path: string; name: string; mime?: string }>;
}

// ============================================================================
// "readable text" check (pure, by mime or filename extension)
// ============================================================================

/** Extensions (with dot) treated as readable text: common plain-text + code files. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.html', '.htm', '.css', '.scss',
  '.xml', '.toml', '.ini', '.env', '.sql', '.rb', '.php', '.kt', '.swift',
]);

/** Lowercase extension (with dot) of a filename; '' when none. */
function extOf(name: string | undefined): string {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Whether an attachment is "readable text":
 *  - mime matches `text/*`, `application/json`, `application/xml`, or a `+json`/`+xml`
 *    structured suffix (e.g. `application/ld+json`, `image/svg+xml`).
 *  - otherwise the filename extension is in TEXT_EXTENSIONS.
 *
 * Pure: looks only at mime and name.
 */
export function isReadableText(mime: string | undefined, name: string | undefined): boolean {
  if (mime) {
    const m = (mime.toLowerCase().split(';')[0] ?? '').trim(); // strip `; charset=...`
    if (m.startsWith('text/')) return true;
    if (m === 'application/json' || m === 'application/xml') return true;
    if (m.endsWith('+json') || m.endsWith('+xml')) return true;
  }
  return TEXT_EXTENSIONS.has(extOf(name));
}

const decoder = new TextDecoder('utf-8');

/** Fence language tag for inlining: extension (sans dot), else empty. */
function fenceLang(name: string | undefined): string {
  const ext = extOf(name);
  if (ext) return ext.slice(1); // drop the dot
  return '';
}

/** Display filename fallback. */
function displayName(att: AttachmentInput): string {
  return att.name && att.name.length > 0 ? att.name : att.url.split('/').pop() || att.url;
}

/**
 * Process each attachment, build promptText, collect persisted files.
 *
 * Rules:
 *  - Readable text with size (or downloaded length) ≤ maxInjectBytes: inline as a
 *    fenced block with language tag, labeled with the filename. Re-decided after the download
 *    when the transport reported a name/mime the element did not carry (Lark).
 *  - Otherwise (binary/image/oversized text):
 *    - size unknown or ≤ maxDownloadBytes: download and save, append a "saved to <path>" line.
 *    - size > maxDownloadBytes: don't download, append an "too large, not downloaded" line.
 *  - A single download error doesn't stop the rest; degrades to a "download failed" line.
 *  - Empty array → promptText is ''.
 */
export async function ingestAttachments(
  atts: AttachmentInput[],
  cfg: AttachmentIngestConfig,
  deps: AttachmentIngestDeps
): Promise<IngestedAttachments> {
  const lines: string[] = [];
  const files: IngestedAttachments['files'] = [];

  for (const att of atts) {
    const name = displayName(att);
    try {
      const readable = isReadableText(att.mime, att.name);

      // Readable text path: download and inline if ≤ maxInjectBytes. When size is
      // unknown, still try inlining and decide by byte length after download.
      if (readable && (att.size === undefined || att.size <= cfg.maxInjectBytes)) {
        const { bytes } = await deps.download(att.url);
        if (bytes.length <= cfg.maxInjectBytes) {
          const text = decoder.decode(bytes);
          const lang = fenceLang(att.name);
          lines.push(`Attachment ${name}:\n\`\`\`${lang}\n${text}\n\`\`\``);
          continue;
        }
        // Exceeded maxInjectBytes after download: persist and give the path.
        await saveAndRecord(att, name, bytes, deps, files, lines);
        continue;
      }

      // Oversized text (known size > maxInjectBytes), binary, image: by download threshold.
      if (att.size !== undefined && att.size > cfg.maxDownloadBytes) {
        lines.push(`[Attachment ${name} is too large (${att.size} bytes), not downloaded. URL: ${att.url}]`);
        continue;
      }
      // size unknown or ≤ maxDownloadBytes: download and persist.
      const got = await deps.download(att.url);
      // Name and mime may arrive WITH the bytes rather than with the element: a Feishu image
      // declares neither, so before this the agent got a path ending in a bare resource key.
      // Knowing them changes two decisions — what the saved file is called, and whether this was
      // readable text after all — so both are re-taken here rather than only logged.
      const resolvedName = att.name ?? got.name;
      const resolvedMime = att.mime ?? got.contentType;
      const display = resolvedName ?? name;
      if (
        !readable &&
        isReadableText(resolvedMime, resolvedName) &&
        got.bytes.length <= cfg.maxInjectBytes
      ) {
        const text = decoder.decode(got.bytes);
        lines.push(`Attachment ${display}:\n\`\`\`${fenceLang(resolvedName)}\n${text}\n\`\`\``);
        continue;
      }
      await saveAndRecord(
        { ...att, ...(resolvedName ? { name: resolvedName } : {}), ...(resolvedMime ? { mime: resolvedMime } : {}) },
        display,
        got.bytes,
        deps,
        files,
        lines
      );
    } catch {
      // Single failure degrades to a line, doesn't affect the rest.
      lines.push(`[Attachment ${name} failed to download. URL: ${att.url}]`);
    }
  }

  return { promptText: lines.join('\n'), files };
}

/** Persist, append a "saved to <path>" line, record the file. download is done by the caller. */
async function saveAndRecord(
  att: AttachmentInput,
  name: string,
  bytes: Uint8Array,
  deps: AttachmentIngestDeps,
  files: IngestedAttachments['files'],
  lines: string[]
): Promise<void> {
  const path = await deps.save(name, bytes);
  files.push({ path, name, mime: att.mime });
  const mimeNote = att.mime ? `(${att.mime})` : '';
  lines.push(`[Attachment ${name} saved to ${path}${mimeNote} — use the Read tool to view it when needed]`);
}
