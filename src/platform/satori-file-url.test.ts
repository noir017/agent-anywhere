import { createServer, type Server } from 'node:http';

import { Context } from '@satorijs/core';
import HTTP from '@cordisjs/plugin-http';
import { afterEach, describe, expect, it } from 'vitest';

import { installRelativeFileUrlFix } from './satori-file-url.js';

/**
 * `http.file()` with a relative path — the shape `adapter-telegram` uses for every inbound file.
 *
 * This is a CONTRACT TEST against two upstream packages, so it is written to fail in both
 * directions. The first case reproduces the upstream bug itself: if `@satorijs/core` ever guards its
 * `http/file` listener, that case stops throwing, this test goes red, and satori-file-url.ts can be
 * deleted. The rest pin that our listener actually repairs it — through a real HTTP request, since
 * the failure was in URL resolution and asserting on a mock would only re-state our own assumption.
 *
 * Reproduced on @satorijs/core 4.6.0 + @cordisjs/plugin-http 0.6.3 + adapter-telegram 4.5.11
 * (2026-09-17), the current releases of all three.
 */

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A stand-in for `https://api.telegram.org/file/bot<token>`, serving one tiny JPEG. */
async function endpoint(): Promise<string> {
  const paths: string[] = [];
  server = createServer((req, res) => {
    paths.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server!.address() as { port: number };
  return `http://127.0.0.1:${port}/file/bot123:ABC`;
}

/** A satori context with HTTP available, optionally carrying our listener. */
async function rig(withFix: boolean): Promise<{ file: { file(url: string): Promise<unknown> } }> {
  const base = await endpoint();
  const ctx = new Context();
  ctx.plugin(HTTP);
  if (withFix) installRelativeFileUrlFix(ctx);
  // The service is installed asynchronously; wait for ctx.http to appear.
  for (let i = 0; i < 50 && !(ctx as { http?: unknown }).http; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const http = (ctx as unknown as { http: { extend(c: object): { file(url: string): Promise<unknown> } } }).http;
  return { file: http.extend({ endpoint: base }) };
}

describe('relative paths passed to http.file()', () => {
  it('throw in satori’s own listener without the fix — the reported bug', async () => {
    // Verbatim the shape adapter-telegram builds (`/` + file_path from getFile), and verbatim the
    // error seen in production: TypeError with the relative path as its `input`.
    const { file } = await rig(false);
    const err = await file.file('/photos/file_13.jpg').catch((e: Error) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error & { input?: string }).input).toBe('/photos/file_13.jpg');
  });

  it('resolve against the endpoint and download with the fix', async () => {
    const { file } = await rig(true);
    const result = (await file.file('/photos/file_13.jpg')) as { type: string; data: ArrayBuffer };
    expect(result.type).toBe('image/jpeg');
    expect(result.data.byteLength).toBe(7);
  });

  it('leave absolute URLs to the listeners that own them', async () => {
    // satori's listener exists to serve `internal:` URLs; ours must not shadow it, and an ordinary
    // absolute URL must still take the normal path.
    const { file } = await rig(true);
    const base = await endpoint();
    const result = (await file.file(`${base}/photos/file_13.jpg`)) as { type: string };
    expect(result.type).toBe('image/jpeg');
  });

  it('do not invent an error when there is no endpoint to resolve against', async () => {
    // Degrades to the behaviour without this file: the original path produces the original error.
    const ctx = new Context();
    ctx.plugin(HTTP);
    installRelativeFileUrlFix(ctx);
    for (let i = 0; i < 50 && !(ctx as { http?: unknown }).http; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const http = (ctx as unknown as { http: { file(url: string): Promise<unknown> } }).http;
    const err = await http.file('/photos/file_13.jpg').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
  });
});
