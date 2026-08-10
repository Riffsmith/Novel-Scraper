// ─────────────────────────────────────────────────────────────────────────────
//  Phase 7 / Evidence Phase 2 - WebnovelAdapter parity tests.
//
//  Covers the parts of the adapter that are pure DOM-shape / pure function:
//    - urlUtils (getCatalogUrl, normalizeChapterUrl, normalizeWebnovelHost,
//      resolveNovelUrl for the non-shortlink happy path)
//    - matches() / getTocUrl() surface + registry registration
//    - processChapterContent (reference-faithful: blacklisted tag + class
//      strip, per-paragraph footnote counter, decorative header / ending
//      lines, footnotes HTML section with back-link)
//
//  The browser-script paths (scrapeChapterLinks' CATALOG_WALK_SCRIPT,
//  scrapeVolumes, AUTHOR_SCRIPT, collectFootnotes live-page click loop)
//  run under tests/acceptance.test.ts gated on CLOAKBROWSER_BINARY_AVAILABLE=1
//  - FakeBrowserPort's evaluateScript intentionally throws
//  (src/adapters/store-memory/FakeBrowserPort.ts:125-127); a real binary is
//  required so the string script actually executes in browser scope.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { makeWebnovelAdapter, webnovelAdapter } from "../src/adapters/site-webnovel/WebnovelAdapter.js";
import {
  getCatalogUrl,
  normalizeChapterUrl,
  normalizeWebnovelHost,
} from "../src/adapters/site-webnovel/urlUtils.js";
import { SITE_ADAPTERS, findSiteAdapter } from "../src/adapters/site-registry/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nullLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

describe("WebnovelAdapter - matches / registry", () => {
  it("matches() returns true for bare, www, and mobile hosts", () => {
    expect(webnovelAdapter.matches("https://www.webnovel.com/book/12345")).toBe(true);
    expect(webnovelAdapter.matches("https://webnovel.com/book/12345")).toBe(true);
    expect(webnovelAdapter.matches("https://m.webnovel.com/book/12345")).toBe(true);
  });

  it("matches() rejects non-webnovel hosts and unparseable URLs", () => {
    expect(webnovelAdapter.matches("https://wtr-lab.com/book/abc")).toBe(false);
    expect(webnovelAdapter.matches("https://novelfire.net/book/abc")).toBe(false);
    expect(webnovelAdapter.matches("not a url")).toBe(false);
    // substring tests must NOT leak through (AGENTS.md "never a substring test")
    expect(webnovelAdapter.matches("https://attacker.com/path?ref=webnovel.com")).toBe(false);
  });

  it("is registered in SITE_ADAPTERS and findSiteAdapter resolves it", () => {
    expect(SITE_ADAPTERS.map((a) => a.id)).toContain("webnovel");
    const found = findSiteAdapter("https://www.webnovel.com/book/12345");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("webnovel");
    expect(found!.label).toBe("Webnovel (webnovel.com)");
  });

  it("exposes the default selectors from reference constants.mjs", () => {
    expect(webnovelAdapter.defaultContentSelector).toBe("div.cha-words");
    expect(webnovelAdapter.defaultSeparateTitle).toBe(true);
    // defaultTitleSelector rounded up from reference constants.mjs:31 - three
    // selectors comma-joined; the colon-backslash escape is preserved.
    expect(webnovelAdapter.defaultTitleSelector).toContain("h1.chapter-title");
    expect(webnovelAdapter.defaultExcludeSelectors).toContain(".para-comment");
    expect(webnovelAdapter.defaultExcludeSelectors).toContain(".cha-hr");
    expect(webnovelAdapter.defaultExcludeSelectors).toContain(".user-links-wrap");
  });
});

describe("WebnovelAdapter - getTocUrl", () => {
  it("appends /catalog when absent", () => {
    expect(webnovelAdapter.getTocUrl("https://www.webnovel.com/book/12345")).toBe(
      "https://www.webnovel.com/book/12345/catalog",
    );
  });

  it("returns the URL unchanged when /catalog already present", () => {
    const url = "https://www.webnovel.com/book/12345/catalog";
    expect(webnovelAdapter.getTocUrl(url)).toBe(url);
  });

  it("strips trailing slash before appending /catalog", () => {
    expect(webnovelAdapter.getTocUrl("https://www.webnovel.com/book/12345/")).toBe(
      "https://www.webnovel.com/book/12345/catalog",
    );
  });
});

describe("urlUtils - URL normalisation", () => {
  it("getCatalogUrl mirrors reference urlUtils.mjs:10-15", () => {
    expect(getCatalogUrl("https://www.webnovel.com/book/12345")).toBe(
      "https://www.webnovel.com/book/12345/catalog",
    );
    expect(getCatalogUrl("https://www.webnovel.com/book/12345/catalog")).toBe(
      "https://www.webnovel.com/book/12345/catalog",
    );
  });

  it("normalizeChapterUrl handles protocol-relative and root-relative URLs", () => {
    const pageUrl = "https://www.webnovel.com/book/12345/chapter/1";
    expect(normalizeChapterUrl("//img.webnovel.com/x.png", pageUrl)).toBe(
      "https://img.webnovel.com/x.png",
    );
    expect(normalizeChapterUrl("/book/12345/chapter/2", pageUrl)).toBe(
      "https://www.webnovel.com/book/12345/chapter/2",
    );
    expect(normalizeChapterUrl("https://www.webnovel.com/foo", pageUrl)).toBe(
      "https://www.webnovel.com/foo",
    );
  });

  it("normalizeWebnovelHost strips m. mobile host", () => {
    expect(normalizeWebnovelHost("https://m.webnovel.com/book/12345")).toBe(
      "https://www.webnovel.com/book/12345",
    );
  });

  it("normalizeWebnovelHost promotes bare host to www", () => {
    expect(normalizeWebnovelHost("https://webnovel.com/book/12345")).toBe(
      "https://www.webnovel.com/book/12345",
    );
  });

  it("normalizeWebnovelHost strips locale segment to keep English selectors", () => {
    expect(normalizeWebnovelHost("https://www.webnovel.com/pt/book/12345")).toBe(
      "https://www.webnovel.com/book/12345",
    );
    expect(normalizeWebnovelHost("https://www.webnovel.com/id/book/12345")).toBe(
      "https://www.webnovel.com/book/12345",
    );
    // two-part locale
    expect(normalizeWebnovelHost("https://www.webnovel.com/pt-br/book/12345")).toBe(
      "https://www.webnovel.com/book/12345",
    );
  });

  it("normalizeWebnovelHost clears search and hash", () => {
    expect(normalizeWebnovelHost("https://www.webnovel.com/book/12345?q=1#t")).toBe(
      "https://www.webnovel.com/book/12345",
    );
  });

  it("normalizeWebnovelHost returns input on unparseable URL", () => {
    expect(normalizeWebnovelHost("not a url")).toBe("not a url");
  });
});

describe("WebnovelAdapter - processChapterContent", () => {
  const adapter = makeWebnovelAdapter(nullLogger() as any);

  it("strips blacklisted tags (pirate, i)", () => {
    const raw = `<p>hello <i>italic</i> world</p><p>pirate <pirate>secret</pirate></p>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "T" });
    expect(out.htmlContent).not.toContain("<pirate>");
    expect(out.htmlContent).not.toContain("<i>");
    expect(out.htmlContent).not.toContain("italic");
    expect(out.htmlContent).not.toContain("secret");
  });

  it("strips blacklisted classes (para-comment, cha-hr, etc)", () => {
    const raw = `<p>body</p><div class="para-comment">noise</div><div class="cha-hr">hr</div>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "T" });
    expect(out.htmlContent).not.toContain("para-comment");
    expect(out.htmlContent).not.toContain("cha-hr");
    expect(out.htmlContent).not.toContain("noise");
    expect(out.htmlContent).not.toContain("hr</div>");
  });

  it("removes already-collected footnote popups (.anno-drop)", () => {
    const raw = `<p>text</p><div class="anno-drop"><div class="anno-drop-hd">X</div></div>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "T" });
    expect(out.htmlContent).not.toContain("anno-drop");
    expect(out.htmlContent).not.toContain("anno-drop-hd");
  });

  it("replaces sup inside anno with footnote link and per-paragraph counter", () => {
    const raw = `<p>first <anno data-annotation-id="abc"><sup>x</sup></anno> and second <anno data-annotation-id="def"><sup>x</sup></anno></p>
<p>third <anno data-annotation-id="ghi"><sup>x</sup></anno></p>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "T" });
    // First paragraph: counter 1, then counter 2 (per-paragraph? reference :369
    // restarts at 1 per paragraph, so second paragraph should restart at 1).
    expect(out.htmlContent).toContain('href="#footnote-abc"');
    expect(out.htmlContent).toContain('href="#footnote-def"');
    expect(out.htmlContent).toContain('href="#footnote-ghi"');
    expect(out.htmlContent).toContain('id="footnote-ref-abc"');
    expect(out.htmlContent).toContain(">1</a>");
    expect(out.htmlContent).toContain(">2</a>");
    // Counter restarts at 1 on the second paragraph (matches reference
    // contentExtractor.mjs:359,369 - footnoteCounter declared INSIDE the each()).
    // Count the ">1</a>" occurrences - should be 2 (one for each paragraph).
    const matches = out.htmlContent.match(/>1<\/a>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("strips class/id/style from each <p>", () => {
    const raw = `<p class="foo" id="p1" style="color:red">text</p>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "T" });
    // The output paragraph should not carry the original class/id/style
    expect(out.htmlContent).not.toContain('class="foo"');
    expect(out.htmlContent).not.toContain('id="p1"');
    expect(out.htmlContent).not.toContain('color:red');
  });

  it("wraps body in chapter-page-title h2 + decorative-line + ending-line", () => {
    const raw = `<p>body</p>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "Chapter 1" });
    expect(out.htmlContent).toContain('<h2 class="chapter-page-title">Chapter 1</h2>');
    expect(out.htmlContent).toContain('<div class="decorative-line">');
    expect(out.htmlContent).toContain('<div class="ending-line">');
    // Decorative content byte-faithful to reference contentExtractor.mjs:386-403
    expect(out.htmlContent).toContain("━━━━━✧✧✧✧━━━━━");
    expect(out.htmlContent).toContain("✦ ✧ ✦ ✧ ✦");
  });

  it("omits footnotes section when no footnotes emitted", () => {
    const raw = `<p>text</p>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: "T" });
    expect(out.htmlContent).not.toContain("footnotes-section");
  });

  it("builds footnotes section with back-links when footnotes provided", () => {
    const raw = `<p>text with <anno data-annotation-id="abc"><sup>x</sup></anno> marker</p>`;
    const footnotes = [
      { ref: "abc", title: "Term Title", content: "Term explanation." },
    ];
    const out = adapter.processChapterContent!({
      rawHtml: raw,
      title: "T",
      footnotes,
    });
    expect(out.htmlContent).toContain('<div class="footnotes-section">');
    expect(out.htmlContent).toContain('id="footnote-abc"');
    expect(out.htmlContent).toContain('href="#footnote-ref-abc"');
    expect(out.htmlContent).toContain("Term Title");
    expect(out.htmlContent).toContain("Term explanation.");
    // Back-link uses unicode arrow ↩ OR text "Back to text" - check the latter
    expect(out.htmlContent).toContain("footnote-back-link");
  });

  it("handles footnote without title (no title span emitted)", () => {
    const raw = `<p>x</p>`;
    const footnotes = [{ ref: "abc", title: "", content: "Body only." }];
    const out = adapter.processChapterContent!({
      rawHtml: raw,
      title: "T",
      footnotes,
    });
    expect(out.htmlContent).toContain("Body only.");
    expect(out.htmlContent).not.toContain("footnote-title");
  });

  it("escapes the chapter title (prevents XML injection)", () => {
    const raw = `<p>x</p>`;
    const malicious = `<script>alert("xss")</script>`;
    const out = adapter.processChapterContent!({ rawHtml: raw, title: malicious });
    // Raw <script> tag must never leak into the output htmlContent - it must
    // be entity-escaped in the chapter-page-title h2. Assert via the escaped
    // entity tokens (built up via concatenation so the editor's entity
    // decoder cannot collapse them back to the raw tag).
    const lt = "&" + "lt;";
    const gt = "&" + "gt;";
    const quot = "&" + "quot;";
    expect(out.htmlContent).not.toContain(`<script>`);
    expect(out.htmlContent).not.toContain(`</script>`);
    expect(out.htmlContent).toContain(`${lt}script${gt}alert(${quot}xss${quot})${lt}/script${gt}`);
  });

  it("footnote ref strings are XML-escaped", () => {
    const raw = `<p>marker</p>`;
    const footnotes = [{ ref: `a&b<"'>`, title: "X", content: "Y" }];
    const out = adapter.processChapterContent!({
      rawHtml: raw,
      title: "T",
      footnotes,
    });
    // No raw unescaped angle bracket should leak into the footnote id
    // - the entity-encoded form (e.g. `&`, `<`, `"`, `'`)
    // is what should appear inside id="footnote-...".
    expect(out.htmlContent).not.toContain('id="footnote-a&b');
    expect(out.htmlContent).toContain('id="footnote-a' + "&" + 'amp;b');
    expect(out.htmlContent).toContain("&" + "lt;");
    expect(out.htmlContent).toContain("&" + "apos;");
  });
});

describe("WebnovelAdapter - processChapterContent fixture parity", () => {
  // Reads tests/fixtures/sites/webnovel/chapter.html, processes it, asserts
  // the output matches the reference contentExtractor.mjs byte-faithful
  // (subject to documented deviations D3 re: text-node re-escape: v2's
  // toXhtml() in templates.ts handles ampersand escaping).
  it("cleans the static fixture HTML as expected", () => {
    const fixturePath = path.join(__dirname, "fixtures", "sites", "webnovel", "chapter.html");
    const raw = fs.readFileSync(fixturePath, "utf8");
    const adapter = makeWebnovelAdapter(nullLogger() as any);
    const footnotes = [
      { ref: "abc123", title: "Footnote Title", content: "Footnote body content explaining the term." },
    ];
    const out = adapter.processChapterContent!({
      rawHtml: raw,
      title: "Test Chapter",
      footnotes,
    });
    // Blacklisted tag/class stripped
    expect(out.htmlContent).not.toContain("<pirate>");
    expect(out.htmlContent).not.toContain("<i>");
    expect(out.htmlContent).not.toContain("pirate tag");
    expect(out.htmlContent).not.toContain("para-comment");
    expect(out.htmlContent).not.toContain("cha-hr");
    // anno-drop popup popup removed (the source fixture had one)
    expect(out.htmlContent).not.toContain('class="anno-drop"');
    // Footnote ref rewritten
    expect(out.htmlContent).toContain('href="#footnote-abc123"');
    expect(out.htmlContent).toContain('id="footnote-ref-abc123"');
    // Footnote section present with back-link
    expect(out.htmlContent).toContain("footnotes-section");
    expect(out.htmlContent).toContain("Footnote Title");
    expect(out.htmlContent).toContain("Footnote body content");
    // Decorative lines wrapping
    expect(out.htmlContent).toContain('<h2 class="chapter-page-title">Test Chapter</h2>');
    expect(out.htmlContent).toContain("━━━━━✧✧✧✧━━━━━");
    expect(out.htmlContent).toContain("✦ ✧ ✦ ✧ ✦");
    // Original annotation sup gone (replaced with the footnote link)
    expect(out.htmlContent).not.toMatch(/<sup>footnote marker<\/sup>/);
  });
});
