import { describe, it, expect } from 'vitest';

import { renderPage } from './page.js';

/**
 * The inline script is the one artifact in this repo the toolchain cannot see: it is not
 * typechecked, not linted and not unit-tested, because to TypeScript it is a string. These
 * assertions are the substitute — they will not catch a logic error, but they catch the two
 * failures that would otherwise reach a browser: a syntax error, and a character the
 * surrounding template literal swallowed.
 */
function scriptOf(html: string): string {
  return html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
}

describe('webui page', () => {
  const html = renderPage('Chat');

  it('emits a client script that actually parses', () => {
    // `new Function` compiles the body without running it, which is exactly the check wanted:
    // a stray brace or a broken string literal throws here instead of producing a page that
    // renders and then does nothing at all.
    expect(() => new Function(scriptOf(html))).not.toThrow();
  });

  it('contains no backtick and no ${, which the template literal would have eaten', () => {
    // Not style: a literal `${` in the client code is read by TypeScript as part of THIS
    // file's template, so it becomes a module-load-time ReferenceError — the daemon fails to
    // start, pointing at a string. The script therefore concatenates rather than interpolates.
    expect(html).not.toContain('`');
    expect(html).not.toContain('${');
  });

  it('loads nothing from anywhere', () => {
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/);
    expect(html).not.toContain('//cdn');
    expect(html).not.toContain('fonts.googleapis');
  });

  it('asks for everything by a relative path, so a reverse proxy sub-path just works', () => {
    expect(html).toContain("EventSource('api/events'");
    expect(html).not.toMatch(/fetch\('\//);
    expect(html).toContain("post('api/send'");
  });

  it('escapes the configured title', () => {
    const evil = renderPage('</title><script>alert(1)</script>');
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(scriptOf(evil)).not.toContain('alert(1)');
  });

  it('has a collapsible topic sidebar with running indicators and unread badges', () => {
    expect(html).toContain('id="topics"');
    expect(html).toContain('id="sidebar"');
    expect(html).toContain('#sidebar.collapsed');
    expect(html).toContain('id="collapse-sidebar"');
    expect(html).toContain('id="expand-sidebar"');
    expect(html).toContain('data-topic=');
    expect(html).toContain('data-new=');
    expect(html).toContain('topic-badge');
    expect(html).toContain('topic-dot');
    expect(html).toContain('.topic-item.idle');
    expect(html).toContain('.topic-item.running');
  });

  it('sends a nonce, without which its own retry would double-post', () => {
    expect(html).toContain('nonce:');
  });

  it('makes the hidden attribute actually hide', () => {
    // #app and #hints both carry `display:` in an id rule, which outranks the browser's own
    // [hidden]{display:none} — without this the chat pane is on screen before login.
    expect(html).toContain('[hidden]{display:none!important}');
  });

  it('ships one dark palette and no way to switch it', () => {
    // "Dark by default" plus "no extra features" has one smallest answer, and a theme toggle
    // is exactly the sort of thing that makes a page memorable.
    expect(html).not.toContain('prefers-color-scheme');
    expect(html).toMatch(/--bg:#1[0-9a-f]{5}/);
  });
});
