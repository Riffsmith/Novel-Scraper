import type { NovelMetadata, Chapter } from '../types.js';

// ── XML/XHTML escaping ────────────────────────────────────────────────────
export function escXml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

// ── Convert HTML → valid XHTML ─────────────────────────────────────────────
export function toXhtml(html: string): string {
  return html
    // Self-close void tags
    .replace(/<br(\s[^>]*)?>(?!\s*<\/br>)/gi, '<br$1/>')
    .replace(/<hr(\s[^>]*)?>(?!\s*<\/hr>)/gi, '<hr$1/>')
    .replace(/<img([^>]*[^/\s])>/gi,          '<img$1/>')
    // Fix bare ampersands that weren't already escaped
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, '&amp;');
}

// ─────────────────────────────────────────────────────────────────────────────
// mimetype (must be plain text, first file in ZIP, uncompressed)
// ─────────────────────────────────────────────────────────────────────────────
export const MIMETYPE = 'application/epub+zip';

// ─────────────────────────────────────────────────────────────────────────────
// META-INF/container.xml
// ─────────────────────────────────────────────────────────────────────────────
export function containerXml(): string {
  // The namespace URI MUST be exactly this string per the EPUB OCF 3.x spec.
  // Any deviation (e.g. "urn:oasis:schemas:container") causes strict readers
  // like Readest to reject the file with "No package document defined".
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf"
              media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/content.opf  (EPUB 3 package document)
// ─────────────────────────────────────────────────────────────────────────────
export function contentOpf(
  meta    : NovelMetadata,
  chapters: Chapter[],
  hasCover: boolean,
  bookId  : string,
): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const manifestChapters = chapters.map((ch) =>
    `    <item id="ch-${ch.index}" href="chapters/chapter-${ch.index}.xhtml" media-type="application/xhtml+xml"/>`,
  ).join('\n');

  const spineItems = chapters.map((ch) =>
    `    <itemref idref="ch-${ch.index}"/>`,
  ).join('\n');

  const coverManifest = hasCover ? `
    <item id="cover-img"  href="images/cover.jpg"  media-type="image/jpeg" properties="cover-image"/>
    <item id="cover-page" href="cover.xhtml"        media-type="application/xhtml+xml"/>` : '';

  const coverSpine = hasCover
    ? `    <itemref idref="cover-page" linear="no"/>` : '';

  const coverMeta = hasCover
    ? `    <meta name="cover" content="cover-img"/>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0"
         xmlns="http://www.idpf.org/2007/opf"
         unique-identifier="bookId"
         xml:lang="${escXml(meta.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookId">${escXml(bookId)}</dc:identifier>
    <dc:title>${escXml(meta.title)}</dc:title>
    <dc:creator opf:role="aut">${escXml(meta.author)}</dc:creator>
    <dc:language>${escXml(meta.language)}</dc:language>
    <dc:publisher>${escXml(meta.publisher ?? 'WebNovel Scraper')}</dc:publisher>
    ${meta.synopsis ? `<dc:description>${escXml(meta.synopsis)}</dc:description>` : ''}
    <meta property="dcterms:modified">${now}</meta>
    <meta property="schema:accessMode">textual</meta>
${coverMeta}
  </metadata>

  <manifest>
    <item id="nav"        href="nav.xhtml"           media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx"        href="toc.ncx"             media-type="application/x-dtbncx+xml"/>
    <item id="css"        href="styles/style.css"    media-type="text/css"/>
    <item id="title-page" href="title.xhtml"         media-type="application/xhtml+xml"/>
${coverManifest}
${manifestChapters}
  </manifest>

  <spine toc="ncx">
${coverSpine}
    <itemref idref="title-page"/>
    <itemref idref="nav"/>
${spineItems}
  </spine>

  <guide>
    ${hasCover ? '<reference type="cover"      title="Cover"              href="cover.xhtml"/>' : ''}
    <reference type="title-page" title="Title Page"         href="title.xhtml"/>
    <reference type="toc"        title="Table of Contents"  href="nav.xhtml"/>
    <reference type="text"       title="Start of Content"   href="chapters/chapter-1.xhtml"/>
  </guide>
</package>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/nav.xhtml  (EPUB 3 navigation document)
// ─────────────────────────────────────────────────────────────────────────────
export function navXhtml(meta: NovelMetadata, chapters: Chapter[]): string {
  const items = chapters.map((ch) =>
    `      <li><a href="chapters/chapter-${ch.index}.xhtml">${escXml(ch.title)}</a></li>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      xml:lang="${escXml(meta.language)}">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents — ${escXml(meta.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles/style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>
      <li><a href="title.xhtml">Title Page</a></li>
${items}
    </ol>
  </nav>
  <nav epub:type="landmarks" id="landmarks" hidden="">
    <ol>
      <li><a epub:type="toc"        href="nav.xhtml">Table of Contents</a></li>
      <li><a epub:type="bodymatter" href="chapters/chapter-1.xhtml">Start of Content</a></li>
    </ol>
  </nav>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/toc.ncx  (EPUB 2 compatibility)
// ─────────────────────────────────────────────────────────────────────────────
export function tocNcx(meta: NovelMetadata, chapters: Chapter[], bookId: string): string {
  const navPoints = chapters.map((ch, i) => `
  <navPoint id="np-${ch.index}" playOrder="${i + 2}">
    <navLabel><text>${escXml(ch.title)}</text></navLabel>
    <content src="chapters/chapter-${ch.index}.xhtml"/>
  </navPoint>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN"
  "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid"            content="${escXml(bookId)}"/>
    <meta name="dtb:depth"          content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber"  content="0"/>
  </head>
  <docTitle><text>${escXml(meta.title)}</text></docTitle>
  <docAuthor><text>${escXml(meta.author)}</text></docAuthor>
  <navMap>
    <navPoint id="np-0" playOrder="1">
      <navLabel><text>Title Page</text></navLabel>
      <content src="title.xhtml"/>
    </navPoint>
${navPoints}
  </navMap>
</ncx>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/title.xhtml
// ─────────────────────────────────────────────────────────────────────────────
export function titleXhtml(meta: NovelMetadata): string {
  const synopsis = meta.synopsis
    ? `\n  <div class="synopsis">\n    <p>${escXml(meta.synopsis)}</p>\n  </div>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escXml(meta.language)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escXml(meta.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles/style.css"/>
</head>
<body>
  <div class="title-page">
    <h1 class="novel-title">${escXml(meta.title)}</h1>
    <p class="author">by ${escXml(meta.author)}</p>
    <p class="publisher">${escXml(meta.publisher ?? 'WebNovel Scraper')}</p>${synopsis}
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/cover.xhtml
// ─────────────────────────────────────────────────────────────────────────────
export function coverXhtml(meta: NovelMetadata): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escXml(meta.language)}">
<head>
  <meta charset="UTF-8"/>
  <title>Cover — ${escXml(meta.title)}</title>
  <link rel="stylesheet" type="text/css" href="styles/style.css"/>
</head>
<body class="cover-page">
  <div class="cover-wrapper">
    <img class="cover-image" src="images/cover.jpg" alt="Cover of ${escXml(meta.title)}"/>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/chapters/chapter-N.xhtml
// ─────────────────────────────────────────────────────────────────────────────
export function chapterXhtml(ch: Chapter, meta: NovelMetadata): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escXml(meta.language)}">
<head>
  <meta charset="UTF-8"/>
  <title>${escXml(ch.title)} — ${escXml(meta.title)}</title>
  <link rel="stylesheet" type="text/css" href="../styles/style.css"/>
</head>
<body>
  <h2 class="chapter-title">${escXml(ch.title)}</h2>
  <div class="chapter-body">
    ${toXhtml(ch.htmlContent)}
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/styles/style.css
// ─────────────────────────────────────────────────────────────────────────────
export function stylesheet(): string {
  return `/* ─── WebNovel Scraper — EPUB Stylesheet ─────────────────────── */

/* Reset */
* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family    : Georgia, "Times New Roman", serif;
  font-size      : 1em;
  line-height    : 1.75;
  color          : #1a1a1a;
  padding        : 1.2em 1.6em;
  max-width      : 100%;
}

/* ── Cover page ─────────────────────────────────────────────────────────── */
body.cover-page {
  padding : 0;
  margin  : 0;
}
.cover-wrapper {
  width  : 100%;
  height : 100%;
  text-align: center;
}
.cover-image {
  max-width  : 100%;
  max-height : 100%;
  display    : block;
  margin     : 0 auto;
  object-fit : contain;
}

/* ── Title page ─────────────────────────────────────────────────────────── */
.title-page {
  text-align  : center;
  margin-top  : 15%;
  padding     : 2em;
}
.novel-title {
  font-size     : 2.2em;
  font-weight   : bold;
  margin-bottom : 0.4em;
  line-height   : 1.2;
}
.author {
  font-size  : 1.2em;
  color      : #555;
  margin     : 0.5em 0;
}
.publisher {
  font-size  : 0.85em;
  color      : #999;
  margin-top : 1.5em;
}
.synopsis {
  margin     : 2em auto;
  max-width  : 34em;
  font-style : italic;
  color      : #444;
  border-left: 3px solid #ccc;
  padding    : 0.8em 1.2em;
  text-align : left;
}

/* ── Chapter ─────────────────────────────────────────────────────────────── */
.chapter-title {
  font-size     : 1.4em;
  font-weight   : bold;
  text-align    : center;
  margin        : 0 0 1.6em;
  padding-bottom: 0.5em;
  border-bottom : 1px solid #ddd;
}
.chapter-body {
  text-align: justify;
}
.chapter-body p {
  margin      : 0 0 0.9em;
  text-indent : 1.6em;
}
.chapter-body p:first-child,
.chapter-body p.no-indent {
  text-indent: 0;
}
.chapter-body blockquote {
  margin      : 1em 2.5em;
  padding     : 0.4em 1em;
  border-left : 3px solid #aaa;
  font-style  : italic;
  color       : #444;
}
.chapter-body hr {
  border     : none;
  border-top : 1px solid #ddd;
  margin     : 1.5em auto;
  width      : 60%;
}
.chapter-body pre,
.chapter-body code {
  font-family : "Courier New", Courier, monospace;
  font-size   : 0.9em;
  background  : #f5f5f5;
  padding     : 0.2em 0.4em;
  border-radius: 3px;
}
.chapter-body pre {
  display   : block;
  padding   : 1em;
  overflow-x: auto;
  margin    : 1em 0;
}

/* ── Navigation (nav.xhtml) ──────────────────────────────────────────────── */
nav[epub|type~="toc"] h1 {
  font-size     : 1.5em;
  margin-bottom : 1em;
}
nav[epub|type~="toc"] ol {
  list-style : none;
  padding    : 0;
}
nav[epub|type~="toc"] li {
  padding : 0.25em 0;
}
nav[epub|type~="toc"] a {
  text-decoration : none;
  color           : #2a5db0;
}
nav[epub|type~="toc"] a:hover {
  text-decoration: underline;
}
`;
}
