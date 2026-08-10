import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";

export async function processChapter(chapterFile, index) {
    const fullPath = path.join(this.chaptersDir, chapterFile);
    const chapterContent = fs.readFileSync(fullPath, "utf-8");
    const chapterName = path.basename(chapterFile, ".html");
    const actualChapterNumber = parseInt(chapterFile.split("_")[0], 10);

    // Parse chapter content with cheerio with decodeEntities set to false
    // to preserve the original entities while allowing DOM manipulation
    const $ = cheerio.load(chapterContent, {
        decodeEntities: false,
        xmlMode: true,
    });

    // Try to extract title from chapter content or generate one
    let title =
        chapterName.split("_").slice(1).join(" ") || `Chapter ${index + 1}`;
    const titleElement = $(".chapter-page-title");
    if (titleElement.length > 0 && titleElement.text().trim()) {
        const originalTitle = titleElement.text().trim();
        title = originalTitle;
        const chapterPattern =
            /Chapter\s+\d+(\.\d+)?\s*[:|\-|–|\s]+\s*Chapter\s+\d+(\.\d+)?\s*[:|\-|–|\s]*/i;
        if (chapterPattern.test(title)) {
            // Extract the second "Chapter X" and everything that follows
            const match = title.match(
                /Chapter\s+\d+(\.\d+)?\s*[:|\-|–|\s]+\s*(Chapter\s+\d+(\.\d+)?.*)/i
            );
            if (match && match[2]) {
                title = match[2];
            } else {
                // Fallback: just remove the first chapter reference
                title = title.replace(/Chapter\s+\d+(\.\d+)?\s*[:|\-|–|\s]+\s*/i, "");
            }
        }
        // Update the title element's text in the DOM
        titleElement.text(title);
    }

    // Safely escape text content but preserve HTML structure
    // Process each text node separately to preserve HTML tags
    $("*")
        .contents()
        .each(function () {
            if (this.type === "text") {
                // Replace only unescaped special characters in text nodes
                // This ensures we don't mess with already encoded entities or HTML tags
                const text = $(this).text();
                const escapedText = text
                    .replace(/&(?![a-zA-Z0-9#]+;)/g, "&amp;") // & not part of an entity
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/"/g, "&quot;")
                    .replace(/'/g, "&apos;")
                    .replace(/&nbsp;/g, " ");

                if (text !== escapedText) {
                    $(this).replaceWith(escapedText);
                }
            }
        });

    // Get the updated body content after modifying the DOM
    let bodyContent = $("body").html() || chapterContent;

    // Check if there's already a chapter title heading in the content
    let hasChapterTitle = titleElement.length > 0;

    // If there's no chapter title element, prepend a properly formatted heading
    if (!hasChapterTitle) {
        console.log(`Adding new chapter title: "${title}"`);
        bodyContent =
            `<h2 class="chapter-title">${title
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&apos;")}</h2>\n` + bodyContent;
    }

    // Escape title for XML safety
    const safeTitle = title
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    // Add proper XHTML structure
    const xhtmlContent = `<?xml version="1.0" encoding="utf-8"?>
    <!DOCTYPE html>
    <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
    <head>
      <title>${safeTitle}</title>
      <link rel="stylesheet" type="text/css" href="../css/styles.css" />
      <meta charset="utf-8"/>
      ${this.getScriptTags()}
    </head>
    <body>
      <div class="chapter">
        ${bodyContent}
      </div>
    </body>
    </html>`;

    const chapterFilename = `chapter_${actualChapterNumber.toString().padStart(3, "0")}.xhtml`;
    fs.writeFileSync(
        path.join(this.tempDir, "OEBPS", "xhtml", chapterFilename),
        xhtmlContent
    );

    return {
        id: `chapter${actualChapterNumber}`,
        href: `xhtml/${chapterFilename}`,
        title: safeTitle,
        chapterNumber: actualChapterNumber,
    };
}

export async function createTitlePage(coverPath) {
    const titlePage = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${this.metadata.title || "Untitled Novel"}</title>
  <link rel="stylesheet" type="text/css" href="../css/styles.css" />
  <meta charset="utf-8"/>
</head>
<body>
  <div class="title-page">
    ${coverPath
            ? `<div class="cover-container"><img class="cover-image" src="../${coverPath}" alt="Cover" /></div>`
            : ""
        }
    <h1>${this.metadata.title || "Untitled Novel"}</h1>
    ${this.metadata.publisher
            ? `<p>Published by ${this.metadata.publisher}</p>`
            : ""
        }
  </div>
</body>
</html>`;

    fs.writeFileSync(
        path.join(this.tempDir, "OEBPS", "xhtml", "titlepage.xhtml"),
        titlePage
    );
}

export async function createSynopsisPage() {
    const synopsisText =
        this.metadata.description || "No description available.";

    // Convert <br> tags to double newlines to create paragraph breaks
    const brToNewlines = synopsisText.replace(/<br\s*\/?>/gi, '\n\n');

    // Then remove other HTML tags
    const sanitizedText = brToNewlines.replace(/<\/?[^>]+(>|$)/g, "");

    const formattedText = sanitizedText
        .split(/\n\s*\n/) // Split on any newlines (including single ones)
        .filter(para => para.trim()) // Remove empty paragraphs
        .map((para) => `<p>${para.trim()}</p>`)
        .join("\n      ");

    const synopsisPage = `<?xml version="1.0" encoding="utf-8"?>
  <!DOCTYPE html>
  <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Synopsis</title>
    <link rel="stylesheet" type="text/css" href="../css/styles.css" />
    <meta charset="utf-8"/>
  </head>
  <body>
    <div class="chapter">
      <h2 class="chapter-title">Synopsis</h2>
      <div class="synopsis">
        ${formattedText}
      </div>
    </div>
  </body>
  </html>`;

    fs.writeFileSync(
        path.join(this.tempDir, "OEBPS", "xhtml", "synopsis.xhtml"),
        synopsisPage
    );
}

export async function createVolumePage(volume, index) {
    const volumeNumber = index + 1;
    const volumeName = volume.name || `Volume ${volumeNumber}`;

    const volumePage = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>${volumeName}</title>
  <link rel="stylesheet" type="text/css" href="../css/styles.css" />
  <meta charset="utf-8"/>
</head>
<body>
  <div class="volume-page">
    <h1 class="volume-title">${volumeName}</h1>
    ${volume.unlockedChapterCount < volume.chapterCount
            ? `<p class="volume-info">Unlocked Chapters: ${volume.unlockedChapterCount}</p>`
            : ""
        }
  </div>
</body>
</html>`;

    const volumeFilename = `volume_${volumeNumber
        .toString()
        .padStart(2, "0")}.xhtml`;
    fs.writeFileSync(
        path.join(this.tempDir, "OEBPS", "xhtml", volumeFilename),
        volumePage
    );

    return {
        id: `volume${volumeNumber}`,
        href: `xhtml/${volumeFilename}`,
        title: volumeName,
    };
}