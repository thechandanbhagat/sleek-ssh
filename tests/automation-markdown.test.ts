import assert from "node:assert/strict";
import test from "node:test";
import { renderAutomationMarkdown } from "../src/automation-markdown.ts";

const MAX_OUTPUT_CHARACTERS = 200_000;

test("Markdown output handles empty and whitespace-only responses", () => {
  assert.equal(renderAutomationMarkdown(""), "");
  assert.equal(renderAutomationMarkdown(" \n\t\r\n"), "");
});

test("Markdown output rejects null and undefined instead of rendering invalid responses", () => {
  assert.throws(() => renderAutomationMarkdown(null as unknown as string), /Input data should be a String/);
  assert.throws(() => renderAutomationMarkdown(undefined as unknown as string), /Input data should be a String/);
});

test("Markdown output renders headings, nested lists, emphasis, quotes, tables, and inline code", () => {
  const html = renderAutomationMarkdown([
    "# Server report", "", "**Ready** with *notes* and `df -h`.", "",
    "1. Services", "   - nginx", "     - healthy", "", "> No changes needed.", "",
    "| Mount | Free |", "| --- | ---: |", "| / | 20 GB |",
  ].join("\n"));
  assert.match(html, /<h1>Server report<\/h1>/);
  assert.match(html, /<strong>Ready<\/strong> with <em>notes<\/em> and <code>df -h<\/code>/);
  assert.match(html, /<ol>[\s\S]*<ul>[\s\S]*<ul>/);
  assert.match(html, /<blockquote>\s*<p>No changes needed\.<\/p>/);
  assert.match(html, /<table>[\s\S]*<th>Mount<\/th>[\s\S]*<td>\/<\/td>/);
});

test("Markdown output normalizes CRLF and preserves fenced code and line breaks", () => {
  const html = renderAutomationMarkdown("first\r\nsecond\r\n\r\n```bash\r\necho '<script>alert(1)</script>'\r\n```\r\n");
  assert.match(html, /first<br>\nsecond/);
  assert.match(html, /<pre><code class="language-bash">echo '&lt;script&gt;alert\(1\)&lt;\/script&gt;'\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script>/);
});

test("Markdown output allows absolute web and email links with safe attributes", () => {
  const html = renderAutomationMarkdown('[web](https://example.test/path?q=one&x=two "A \\"quote\\" & title") [http](http://example.test) [email](mailto:ops@example.test)');
  assert.equal((html.match(/<a /g) ?? []).length, 3);
  assert.equal((html.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3);
  assert.match(html, /href="https:\/\/example\.test\/path\?q=one&amp;x=two"/);
  assert.doesNotMatch(html, /<a[^>]*\son(?:click|error|load)=/i);
});

test("Markdown output rejects unsafe, relative, local, protocol-relative, and obfuscated links", () => {
  const links = [
    "javascript:alert%281%29", "JaVaScRiPt:alert%281%29", "java&#x73;cript:alert%281%29",
    "javascript&colon;alert%281%29", "%6aavascript:alert%281%29", "java%0ascript:alert%281%29",
    "data:text/html;base64,PHNjcmlwdD4=", "file:///C:/secret.txt", "vbscript:msgbox%281%29",
    "codex://threads/test", "tauri://localhost", "//example.test", "/etc/passwd", "../secret.txt",
    "C:/Users/secret.txt", "http:example.test", "https:///", "#anchor",
  ];
  for (const href of links) {
    assert.doesNotMatch(renderAutomationMarkdown(`[click](${href})`), /<a\b/, href);
  }
});

test("Markdown output escapes hostile HTML, link titles, fence languages, and code content", () => {
  const html = renderAutomationMarkdown([
    '<script>alert(1)</script><img src=x onerror="alert(1)">', "",
    '[click](https://example.test "\\\" onmouseover=\\\"alert(1)")', "",
    '```js" onmouseover="alert(1)', '</code><svg onload=alert(1)>', '```', "",
    '`<img src=x onerror=alert(1)>`',
  ].join("\n"));
  assert.doesNotMatch(html, /<(?:script|img|svg)\b/i);
  assert.doesNotMatch(html, /<[^>]+\son(?:mouseover|load|error)="[^"]*"/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;\/code&gt;&lt;svg onload=alert\(1\)&gt;/);
});

test("Markdown output keeps entity-encoded hostile attributes inside an escaped title", () => {
  const html = renderAutomationMarkdown('[click](https://example.test "&quot; onmouseover=&quot;alert(1)")');
  assert.match(html, /<a href="https:\/\/example\.test" title="&quot; onmouseover=&quot;alert\(1\)" target="_blank" rel="noopener noreferrer">click<\/a>/);
  assert.doesNotMatch(html, /\sonmouseover="/i);
});

test("Markdown output renders image alt text literally without fetching images", () => {
  const html = renderAutomationMarkdown('![<img src=x onerror=alert(1)> & private](https://example.test/tracker.png) ![inline](data:image/png;base64,AAAA)');
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /<a\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; private/);
  assert.doesNotMatch(html, /src="https:\/\/example\.test/);
});

test("Markdown output keeps plain URLs literal and leaves punctuation unchanged", () => {
  const html = renderAutomationMarkdown('https://example.test -- "ready"');
  assert.doesNotMatch(html, /<a\b/);
  assert.match(html, /https:\/\/example\.test -- &quot;ready&quot;/);
});

test("Markdown output accepts the maximum output length without throwing or losing content", () => {
  const source = "a".repeat(MAX_OUTPUT_CHARACTERS);
  assert.equal(renderAutomationMarkdown(source), `<p>${source}</p>\n`);
});
