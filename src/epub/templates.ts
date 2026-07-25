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

function synopsisParagraphsXhtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escXml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n    ');
}

// ── Flatten to single-line plain text for OPF metadata (dc:description
//    isn't a rendered field — it shouldn't carry paragraph markup).
function flattenSynopsis(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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

// ── Embedded font(s) ─────────────────────────────────────────────────────────
// Every embedded font gets one manifest entry pointing at OEBPS/fonts/<file>.
// Add more entries here if additional fonts are embedded later (e.g. Firlest).
interface EmbeddedFont {
  id:       string;
  filename: string;
  mediaType: string;
}

export const EMBEDDED_FONTS: EmbeddedFont[] = [
  { id: 'font-foglihten', filename: 'FoglihtenNo07_Subset_Deep.ttf', mediaType: 'font/ttf' },
];

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

  // The cover now doubles as the book's title page (Calibre convention:
  // properties="calibre:title-page" marks which manifest item is the title
  // page for readers/tools that look for it).
  const coverManifest = hasCover ? `
    <item id="cover-img"  href="images/cover.jpg"  media-type="image/jpeg" properties="cover-image"/>
    <item id="cover-page" href="cover.xhtml"        media-type="application/xhtml+xml" properties="calibre:title-page"/>` : '';

  // Part of the linear reading order now (no longer linear="no") since it's
  // the first page a reader sees.
  const coverSpine = hasCover
    ? `    <itemref idref="cover-page"/>` : '';

  const coverMeta = hasCover
    ? `    <meta name="cover" content="cover-img"/>` : '';

  const fontManifest = EMBEDDED_FONTS.map((f) =>
    `    <item id="${f.id}" href="fonts/${f.filename}" media-type="${f.mediaType}"/>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<package version="3.0"
         xmlns="http://www.idpf.org/2007/opf"
         unique-identifier="bookId"
         prefix="calibre: https://calibre-ebook.com"
         xml:lang="${escXml(meta.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"
            xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier id="bookId">${escXml(bookId)}</dc:identifier>
    <dc:title>${escXml(meta.title)}</dc:title>
    <dc:creator opf:role="aut">${escXml(meta.author)}</dc:creator>
    <dc:language>${escXml(meta.language)}</dc:language>
    <dc:publisher>${escXml(meta.publisher ?? 'WebNovel Scraper')}</dc:publisher>
    ${meta.synopsis ? `<dc:description>${escXml(flattenSynopsis(meta.synopsis))}</dc:description>` : ''}
    <meta property="dcterms:modified">${now}</meta>
    <meta property="schema:accessMode">textual</meta>
${coverMeta}
  </metadata>

  <manifest>
    <item id="nav"        href="nav.xhtml"           media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx"        href="toc.ncx"             media-type="application/x-dtbncx+xml"/>
    <item id="css"        href="styles/style.css"    media-type="text/css"/>
    <item id="synopsis"   href="synopsis.xhtml"      media-type="application/xhtml+xml"/>
${fontManifest}
${coverManifest}
${manifestChapters}
  </manifest>

  <spine toc="ncx">
${coverSpine}
    <itemref idref="synopsis"/>
    <itemref idref="nav"/>
${spineItems}
  </spine>

  <guide>
    ${hasCover ? '<reference type="cover"      title="Cover"              href="cover.xhtml"/>\n    <reference type="title-page" title="Title Page"          href="cover.xhtml"/>' : ''}
    <reference type="other.synopsis" title="Synopsis"          href="synopsis.xhtml"/>
    <reference type="toc"        title="Table of Contents"  href="nav.xhtml"/>
    <reference type="text"       title="Start of Content"   href="chapters/chapter-1.xhtml"/>
  </guide>
</package>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/nav.xhtml  (EPUB 3 navigation document)
// ─────────────────────────────────────────────────────────────────────────────
export function navXhtml(meta: NovelMetadata, chapters: Chapter[], hasCover: boolean): string {
  const items = chapters.map((ch) =>
    `      <li><a href="chapters/chapter-${ch.index}.xhtml">${escXml(ch.title)}</a></li>`,
  ).join('\n');

  const coverItem = hasCover
    ? `      <li><a href="cover.xhtml">Title Page</a></li>\n` : '';

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
${coverItem}      <li><a href="synopsis.xhtml">Synopsis</a></li>
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
export function tocNcx(meta: NovelMetadata, chapters: Chapter[], bookId: string, hasCover: boolean): string {
  // playOrder: [cover (if present) →] synopsis → chapters
  let playOrder = 1;

  const coverNavPoint = hasCover ? `
    <navPoint id="np-cover" playOrder="${playOrder++}">
      <navLabel><text>Title Page</text></navLabel>
      <content src="cover.xhtml"/>
    </navPoint>` : '';

  const synopsisNavPoint = `
    <navPoint id="np-synopsis" playOrder="${playOrder++}">
      <navLabel><text>Synopsis</text></navLabel>
      <content src="synopsis.xhtml"/>
    </navPoint>`;

  const chapterStart = playOrder;
  const navPoints = chapters.map((ch, i) => `
  <navPoint id="np-${ch.index}" playOrder="${chapterStart + i}">
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
  <navMap>${coverNavPoint}${synopsisNavPoint}
${navPoints}
  </navMap>
</ncx>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/synopsis.xhtml
//
//  Formerly "title.xhtml" — the cover now serves as the book's title page
//  (see coverXhtml below), so this page is declared purely as the synopsis
//  page in content.opf / nav.xhtml / toc.ncx. It still carries the title /
//  author / publisher line along with the synopsis text itself.
// ─────────────────────────────────────────────────────────────────────────────
export function synopsisXhtml(meta: NovelMetadata): string {
const synopsis = meta.synopsis
    ? `\n  <div class="synopsis">\n    ${synopsisParagraphsXhtml(meta.synopsis)}\n  </div>` : '';

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
//
//  Now doubles as the book's title page (properties="calibre:title-page" in
//  content.opf) — the novel title is rendered in an <h1> below the cover
//  image.
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
    <h1 class="cover-title">${escXml(meta.title)}</h1>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/chapters/chapter-N.xhtml
//
//  Decorative markers:
//    • A ".decorative-line" divider is inserted right after the chapter
//      title (matches the class defined in styles/style.css).
//    • An ".ending-line" divider caps off the chapter body.
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
  <div class="decorative-line">━━━━━✧✧✧✧━━━━━</div>
  <div class="chapter-body">
    ${toXhtml(ch.htmlContent)}
  </div>
  <div class="ending-line">✦ ✧ ✦ ✧ ✦</div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// OEBPS/styles/style.css
//
//  Sourced from the user-supplied stylesheet (mattharrison/epub-css-starter-kit
//  base), with font-face paths pointing at the embedded fonts under
//  OEBPS/fonts/. `.decorative-line` / `.ending-line` and `.chapter-title`
//  (h2) already carry the FoglihtenNo07 treatment this stylesheet defines.
// ─────────────────────────────────────────────────────────────────────────────
export function stylesheet(): string {
  return `/* credit: @mattharrison https://github.com/mattharrison/epub-css-starter-kit */
/* Base Reset */
html,
body,
div,
span,
applet,
object,
iframe,
h1,
h2,
h3,
h4,
h5,
h6,
p,
blockquote,
pre,
a,
abbr,
acronym,
address,
big,
cite,
code,
del,
dfn,
em,
img,
ins,
kbd,
q,
s,
samp,
small,
strike,
strong,
sub,
sup,
tt,
var,
b,
u,
i,
center,
dl,
dt,
dd,
fieldset,
form,
label,
legend,
table,
caption,
tbody,
tfoot,
thead,
tr,
th,
td,
article,
aside,
canvas,
details,
embed,
figure,
figcaption,
footer,
header,
hgroup,
menu,
nav,
output,
ruby,
section,
summary,
time,
mark,
audio,
video {
  /* Note kindle hates margin:0 ! (or margin-left or margin-top set) it inserts newlines galore */
  margin-right: 0;
  padding: 0;
  border: 0;
  font-size: 100%;
  vertical-align: baseline;
}
/* Font Face Definitions */
@font-face {
  font-family: "FoglihtenNo07";
  src: url(../fonts/FoglihtenNo07_Subset_Deep.ttf) format("truetype");
  font-weight: 500;
  font-style: normal;
  font-stretch: normal;
}
/* Body Styles */
body {
  font-size: 1em;
  line-height: 1.5;
  max-width: 100%;
  margin: 0 auto;
  font-family: "FoglihtenNo07", serif;
}
/* Media query for dark mode */
@media (prefers-color-scheme: dark) {
  body {
    color: #f0f0f0;
    background-color: #121212;
  }
  .chapter-ender {
    color: rgba(255, 255, 255, 0.5);
  }
  blockquote {
    border-left: 4px solid #666;
    color: #ccc;
  }
  i {
    color: rgba(255, 255, 255, 0.7);
  }
  img {
    border: 5px solid #444;
  }
  a {
    color: #82b1ff;
  }
  .toc a {
    color: #82b1ff;
  }
  code,
  pre {
    background-color: rgba(255, 255, 255, 0.1);
  }
}
/* Typography */
h1,
h2,
h3,
h4,
h5,
h6 {
  hyphens: none !important;
  -moz-hyphens: none !important;
  -webkit-hyphens: none !important;
  page-break-after: avoid;
  page-break-inside: avoid;
  text-indent: 0;
  text-align: left;
  font-family: Helvetica, Arial, sans-serif;
}
h1 {
  font-size: 1.4em !important;
  text-align: center !important;
  font-family: "FoglihtenNo07", serif;
}
h1:before {
  content: "" !important;
  display: block !important;
  font-size: 14px !important;
  letter-spacing: 5px !important;
  margin: 10px auto !important;
  width: 100% !important;
  text-align: center !important;
}
h2 {
  font-size: 1.25em;
  margin: 50px 0 0 0;
  margin-top: 0.5em;
  margin-bottom: 0.5em;
  text-align: center !important;
  font-style: normal;
  font-family: "FoglihtenNo07", serif;
}
p {
  font-family: "Palatino", "Times New Roman", Caecilia, serif;
  -webkit-hyphens: auto;
  -moz-hyphens: auto;
  hyphens: auto;
  -webkit-hyphenate-limit-lines: 2;
  line-height: 1.5em;
  margin-bottom: 1em;
  text-align: justify;
  text-indent: 1em;
  orphans: 2;
  widows: 2;
}
p.first-para,
p.first-para-chapter,
p.note-p-first {
  text-indent: 0;
}
p.first-para-chapter::first-line {
  /* handle run-in */
  font-variant: small-caps;
}
p + p {
  text-indent: 1.5em;
}
/* No-hyphen elements */
p.pseudo-title,
p.preface-pseudo-title,
p.pseudo-subtitle,
div.toc-title {
  -webkit-hyphens: none;
  -moz-hyphens: none;
  hyphens: none;
  -adobe-hyphenate: none;
  -epub-hyphens: none;
}
/* Special paragraph styles */
p.preface-pseudo-title {
  page-break-before: always !important;
  break-before: page;
  color: #594630;
  margin: 0 0 1em 0;
  text-indent: 0;
  font-size: 2.5em;
  text-align: center;
}
/* Links */
a {
  text-decoration: none;
  color: inherit;
}
.toc a:hover {
  text-decoration: underline;
}
/* Lists */
ul {
  list-style-type: circle;
  font-family: serif;
  padding-left: 2em;
}
ol {
  list-style-type: circle;
  font-family: serif;
  padding-left: 2em;
}
nav > ul {
  list-style-type: circle;
  padding-left: 1em;
  font-family: serif;
}
nav > ol {
  padding-left: 1em;
}
/* Blockquotes */
blockquote {
  margin: 1em;
  padding: 0.5em;
  font-style: italic;
  border-left: 3px solid #888;
}
/* Code and Preformatted Text */
code,
kbd,
samp,
tt {
  font-family: "Courier New", Courier, monospace;
  padding: 0.2em 0.4em;
  border-radius: 0.3em;
  background-color: rgba(0, 0, 0, 0.05);
}
pre {
  font-family: "Courier New", Courier, monospace;
  padding: 1em;
  white-space: pre-wrap;
  margin: 1em 0;
  overflow-x: auto;
  background-color: rgba(0, 0, 0, 0.05);
}
/* Superscript and Subscript */
sup,
sub {
  font-size: 0.8em;
  line-height: 0;
  position: relative;
  vertical-align: baseline;
}
sup {
  top: -0.5em;
}
sub {
  bottom: -0.25em;
}
/* Special Text Styles */
i {
  font-style: italic;
  color: rgba(0, 0, 0, 0.7);
}
span.c13 {
  font-size: 175%;
  font-weight: bold;
}
span.c14 {
  font-variant: small-caps;
}
/* Decorative Elements */
.decorative-line {
  text-align: center;
  margin: 5px 0;
  font-size: 1.1em;
  font-weight: bold;
  letter-spacing: 0;
  margin-bottom: 1.5em;
}
.ending-line {
  text-align: center;
  margin: 5px 0;
  font-size: 1.1em;
  font-weight: bold;
  letter-spacing: 0;
  margin-top: 1.5em;
}
/* Images */
img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 20px auto;
  border: 5px solid #ccc;
}
.cover {
  max-width: 100%;
  height: auto;
}
/* Special Sections */
.title h1 {
  margin-bottom: 0;
  margin-top: 1em;
}
div.div-literal-block-admonition {
  margin-left: 1em;
  background-color: #ccc;
  padding: 1em;
}
div.note,
div.tip,
div.hint {
  margin: 1em 0 1em 0 !important;
  background-color: #ccc;
  padding: 1em !important;
  border-top: 0 solid #ccc;
  border-bottom: 0 dashed #ccc;
  page-break-inside: avoid;
  break-inside: avoid;
}
/* Cover and Title Pages */
.cover-page {
  margin: 0;
  padding: 0;
  text-align: center;
  height: 100%;
  width: 100%;
}
.cover-image {
  max-width: 100%;
  max-height: 100%;
  height: auto;
}
.cover-title {
  font-size: 1.8em !important;
  margin-top: 0.6em;
  text-align: center;
  font-family: "FoglihtenNo07", serif;
}
.title-page {
  text-align: center;
  margin: 3em 0;
}
.title-page h1 {
  font-size: 2.5em;
  margin-bottom: 0.5em;
}
.title-page .author {
  font-size: 1.5em;
  margin-bottom: 2em;
}
.synopsis {
  margin: 2em 1em;
  font-style: italic;
  line-height: 1.6;
  border-left: 3px solid #888;
  padding-left: 1em;
}

.volume-title {
  position: absolute !important;
  top: 50% !important;
  left: 50% !important;
  transform: translate(-50%, -50%) !important;
  font-size: 2rem !important;
  text-align: center;
  font-family: "Firlest", serif;
}

.anno-drop {
  display: none;
}

.footnote-link {
  text-decoration: none;
  color: #0066cc;
  vertical-align: super;
  font-size: 0.8em;
}
.footnote-link:hover {
  text-decoration: underline;
}
.footnote-back-link {
  text-decoration: none;
  color: #0066cc;
  margin-right: 5px;
}
.footnote-back-link:hover {
  text-decoration: underline;
}
.footnotes-section {
  margin-top: 2em;
  border-top: 1px solid #ccc;
  padding-top: 1em;
}
.footnote-item {
  margin-bottom: 0.5em;
  padding: 0.25em 0;
}
.footnote-ref {
  font-weight: bold;
}
.footnote-title {
  font-style: italic;
}
`;
}
