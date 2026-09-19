import { describe, it, expect } from 'vitest';

import { renderWebMarkdown, escapeHtml } from './web-markdown.js';

/**
 * The security half of these tests is not about markdown at all.
 *
 * This converter is the only place in the repo that produces HTML for a DOM, and its input
 * is agent output — which carries the raw bytes of every file the agent read and every
 * command it ran. A regression here is script execution in the operator's browser, not a
 * formatting bug, so the escaping assertions are written to fail loudly on any output that
 * contains markup this file did not construct itself.
 */
describe('web-markdown: escaping is unconditional', () => {
  it('never emits an unescaped tag from input', () => {
    const html = renderWebMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inside code spans and fences, where an author might assume raw text is fine', () => {
    expect(renderWebMarkdown('`<img onerror=x>`')).toContain('<code>&lt;img onerror=x&gt;</code>');
    expect(renderWebMarkdown('```\n<img onerror=x>\n```')).toContain('&lt;img onerror=x&gt;');
    expect(renderWebMarkdown('```\n<img onerror=x>\n```')).not.toContain('<img');
  });

  it('escapes quotes so a link label cannot break out of an attribute', () => {
    const html = renderWebMarkdown('[a" onmouseover="alert(1)](https://e.com)');
    expect(html).not.toMatch(/onmouseover="/);
    expect(html).toContain('&quot;');
  });

  it('escapes the language label of a fence', () => {
    expect(renderWebMarkdown('```"><script>\nx\n```')).not.toContain('<script>');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    '/etc/passwd',
  ])('drops the href of an unsafe or relative scheme (%s) but keeps the text', (url) => {
    const html = renderWebMarkdown(`[click](${url})`);
    expect(html).not.toContain('href');
    expect(html).toContain('click');
  });

  it.each(['https://e.com/x', 'http://e.com/x', 'mailto:a@e.com'])('links %s', (url) => {
    expect(renderWebMarkdown(`[t](${url})`)).toContain(`<a href="${url}" target="_blank" rel="noopener noreferrer">t</a>`);
  });

  it('keeps an ampersand in a URL spelled as an entity, which is what an attribute wants', () => {
    expect(renderWebMarkdown('[t](https://e.com/?a=1&b=2)')).toContain('href="https://e.com/?a=1&amp;b=2"');
  });

  it('escapeHtml covers every character HTML gives meaning to', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });
});

/**
 * Stream safety. Every one of these inputs is a real intermediate state: the converter runs
 * on each streaming edit, so it sees a construct's opening delimiter one flush before its
 * closer. An unbalanced tag here does not just mis-render one message — it swallows the
 * formatting of everything after it in the same node.
 */
describe('web-markdown: half-received input stays literal', () => {
  it.each([
    ['**bold', '**bold'],
    ['*em', '*em'],
    ['~~struck', '~~struck'],
    ['`code', '`code'],
  ])('leaves %s as literal text', (src, want) => {
    const html = renderWebMarkdown(src);
    expect(html).toContain(want);
    expect(html).not.toMatch(/<(strong|em|del|code|a)\b/);
  });

  it('leaves a half-typed link as literal brackets, and still links the URL inside it', () => {
    // Deliberate, not an accident of ordering: the `[…](…)` construct is not rewritten until
    // its closing paren arrives, but the href half of it is already a real URL the moment it
    // is on screen. Keeping the brackets literal is the stream-safety half; linking the URL
    // anyway is what stops the last flush of every streamed link from being unclickable.
    const html = renderWebMarkdown('[label](https://e.com');
    expect(html).toContain('[label](');
    expect(html).toContain('href="https://e.com"');
  });

  it('emits balanced tags once the closer arrives', () => {
    expect(renderWebMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderWebMarkdown('*em*')).toContain('<em>em</em>');
    expect(renderWebMarkdown('~~s~~')).toContain('<del>s</del>');
  });

  it('holds a table as a paragraph until its separator row arrives', () => {
    expect(renderWebMarkdown('| a | b |')).not.toContain('<table>');
    expect(renderWebMarkdown('| a | b |\n|---|---|')).toContain('<table>');
  });

  it('renders an unterminated fence as an open code block rather than flickering through a paragraph', () => {
    const html = renderWebMarkdown('```js\nconst x = 1;');
    expect(html).toContain('<pre><code class="language-js">const x = 1;</code></pre>');
  });

  it('never produces an odd number of tags for a truncated stream of a long reply', () => {
    const full = '# H\n\nsome **bold** and `code`\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n';
    for (let n = 1; n <= full.length; n += 1) {
      const html = renderWebMarkdown(full.slice(0, n));
      const opens = (html.match(/<(?!\/)[a-z]/g) ?? []).length;
      const closes = (html.match(/<\//g) ?? []).length;
      // <hr> and <br> are void; everything else this file emits is paired.
      const voids = (html.match(/<(hr|br)>/g) ?? []).length;
      expect(opens - voids).toBe(closes);
    }
  });
});

describe('web-markdown: blocks', () => {
  it('renders headings and strips the closing sequence', () => {
    expect(renderWebMarkdown('## Title ##')).toBe('<h2>Title</h2>');
    expect(renderWebMarkdown('###### six')).toBe('<h6>six</h6>');
  });

  it('does not treat a bare # as a heading', () => {
    expect(renderWebMarkdown('#notaheading')).toBe('<p>#notaheading</p>');
  });

  it('renders horizontal rules', () => {
    expect(renderWebMarkdown('---')).toBe('<hr>');
    expect(renderWebMarkdown('***')).toBe('<hr>');
  });

  it('recurses into blockquotes so a list inside one still works', () => {
    expect(renderWebMarkdown('> - a\n> - b')).toBe('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>');
  });

  it('keeps an agent line break instead of folding it', () => {
    expect(renderWebMarkdown('one\ntwo')).toBe('<p>one<br>two</p>');
  });

  it('renders a table, padding ragged rows', () => {
    const html = renderWebMarkdown('| a | b |\n|---|---|\n| 1 |\n| 2 | 3 | 4 |');
    expect(html).toContain('<th>a</th><th>b</th>');
    expect(html).toContain('<tr><td>1</td><td></td></tr>');
    expect(html).toContain('<tr><td>2</td><td>3</td></tr>');
  });
});

describe('web-markdown: lists', () => {
  it('nests by indentation and closes every level', () => {
    expect(renderWebMarkdown('- a\n  - b\n- c')).toBe('<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
  });

  it('dedents more than one level at once', () => {
    expect(renderWebMarkdown('- a\n  - b\n    - c\n- d')).toBe(
      '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'
    );
  });

  it('treats a numbered run at the same indent as its own list', () => {
    expect(renderWebMarkdown('- a\n1. b')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('folds an indented continuation line into the item above it', () => {
    expect(renderWebMarkdown('- a\n  more')).toBe('<ul><li>a<br>more</li></ul>');
  });
});

describe('web-markdown: inline', () => {
  it('suppresses markup inside a code span', () => {
    expect(renderWebMarkdown('`**not bold**`')).toContain('<code>**not bold**</code>');
    expect(renderWebMarkdown('`**not bold**`')).not.toContain('<strong>');
  });

  it('leaves snake_case alone', () => {
    expect(renderWebMarkdown('foo_bar_baz')).toBe('<p>foo_bar_baz</p>');
  });

  it('does not read a lone asterisk between spaces as emphasis', () => {
    expect(renderWebMarkdown('a * b * c')).toBe('<p>a * b * c</p>');
  });

  it('links a bare URL and leaves the sentence punctuation out of it', () => {
    const html = renderWebMarkdown('see https://e.com/x.');
    expect(html).toContain('href="https://e.com/x"');
    expect(html).toContain('</a>.');
  });

  it('does not autolink a URL that is already the href of a markdown link', () => {
    const html = renderWebMarkdown('[t](https://e.com)');
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });

  it('handles a longer backtick run around a span containing backticks', () => {
    expect(renderWebMarkdown('``a ` b``')).toContain('<code>a ` b</code>');
  });
});
