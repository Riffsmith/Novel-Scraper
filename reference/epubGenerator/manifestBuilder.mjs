import fs from "fs";
import * as html from "html-entities";
import path from "path";

/**
 * Turns scraped, HTML-laden synopsis text into clean plain text for the
 * <dc:description> field, which the EPUB spec does not allow to contain
 * markup. Paragraph and line breaks are preserved as blank lines instead
 * of being silently deleted along with their tags.
 */
function sanitizeDescriptionForMetadata(rawDescription) {
    if (!rawDescription) return "";

    let description = rawDescription;

    // Decode any existing HTML entities first so we don't double-escape them.
    description = html.decode(description);

    // Remove document wrapper tags but keep the actual content.
    description = description
        .replace(/<!DOCTYPE[^>]*>/gi, "")
        .replace(/<\/?html[^>]*>/gi, "")
        .replace(/<head[\s\S]*?<\/head>/gi, "")
        .replace(/<\/?body[^>]*>/gi, "")
        .trim();

    // Escape for XML so the HTML is stored as text inside <dc:description>.
    return description
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export async function createContentOpf(coverPath, chapters, volumePages = []) {
    const title = this.metadata.title || "Untitled Novel";
    const author = this.metadata.author || "Unknown Author";
    const publisher = this.metadata.publisher || author;
    const description = this.metadata.description || "";
    const date = new Date().toISOString().split("T")[0];

    // Sanitize description - convert block-level HTML into line breaks,
    // strip whatever tags remain, then decode entities. Without this,
    // stripping tags outright collapses every paragraph into one block.
    const sanitizedDescription = sanitizeDescriptionForMetadata(description);

    // Start building metadata elements
    let metadataElements = `
    <dc:identifier id="BookId">urn:uuid:${this.uuid}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator id="creator">${author}</dc:creator>
    <dc:language>en</dc:language>
    <dc:publisher>${publisher}</dc:publisher>
    <dc:date>${date}</dc:date>`;

    // Add description if available
    if (sanitizedDescription.trim()) {
        metadataElements += `
    <dc:description>${sanitizedDescription.trim()}</dc:description>`;
    }

    // Add subjects/tags if available
    if (this.metadata.subjects && this.metadata.subjects.length > 0) {
        this.metadata.subjects.forEach((subject) => {
            metadataElements += `
    <dc:subject>${subject}</dc:subject>`;
        });
    }

    metadataElements += `
    <meta property="dcterms:modified">${new Date()
            .toISOString()
            .replace(/\.\d+Z$/, "Z")}</meta>
    ${coverPath ? '<meta name="cover" content="cover-image"/>' : ""}`;

    // Start building the manifest items
    let manifestItems = `
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
    <item id="css" href="css/styles.css" media-type="text/css"/>
    <item id="titlepage" href="xhtml/titlepage.xhtml" media-type="application/xhtml+xml" properties="calibre:title-page"/>
    <item id="synopsis" href="xhtml/synopsis.xhtml" media-type="application/xhtml+xml"/>`;

    // Add cover image to manifest if available
    if (coverPath) {
        manifestItems += `
    <item id="cover-image" href="${coverPath}" media-type="image/jpeg" properties="cover-image"/>`;
    }

    /// Add chapter items to manifest
    chapters.forEach((chapter) => {
        manifestItems += `
    <item id="${chapter.id}" href="${chapter.href}" media-type="application/xhtml+xml" properties="scripted"/>`;
    });

    // Add fonts to manifest
    const fontDir = path.join(this.tempDir, "OEBPS", "fonts");
    if (fs.existsSync(fontDir)) {
        fs.readdirSync(fontDir).forEach((fontFile) => {
            const fontId = `font-${path.basename(fontFile, path.extname(fontFile)).split("_")[0]
                }`;
            // Use application/vnd.ms-opentype for both TTF and OTF files
            const mediaType = "application/vnd.ms-opentype";
            manifestItems += `
    <item id="${fontId}" href="fonts/${fontFile}" media-type="${mediaType}"/>`;
        });
    }

    // Add volume pages to manifest
    volumePages.forEach((volume) => {
        manifestItems += `
    <item id="${volume.id}" href="${volume.href}" media-type="application/xhtml+xml"/>`;
    });

    // Build the spine items - include volume pages at the right position
    let spineItems = `
    <itemref idref="titlepage"/>
    <itemref idref="synopsis"/>
    <itemref idref="nav"/>`; // Add nav to spine after synopsis

    // If we have volumes, insert volume pages before their corresponding chapters
    if (volumePages.length > 0 && this.volumes) {
        // Using our new method to correctly assign chapters to volumes
        const volumeChapters = await this.assignChaptersToVolumes(chapters);

        // Track which volumes actually have chapters
        const volumesWithChapters = new Set();

        // Loop through all possible volumes
        for (let i = 0; i < this.volumes.length; i++) {
            const chapterList = volumeChapters.get(i) || [];
            if (chapterList.length > 0) {
                volumesWithChapters.add(i);
            }
        }

        // Add volumes and their chapters to spine
        for (let i = 0; i < volumePages.length; i++) {
            // Find the corresponding volume index for this volume page
            const volumeIndex =
                parseInt(volumePages[i].id.replace("volume", "")) - 1;

            // Only add volumes that have chapters
            if (volumesWithChapters.has(volumeIndex)) {
                // Add the volume page
                spineItems += `
    <itemref idref="${volumePages[i].id}"/>`;

                // Add chapters for this volume
                const volumeChapterList = volumeChapters.get(volumeIndex) || [];
                for (const chapter of volumeChapterList) {
                    spineItems += `
    <itemref idref="${chapter.id}"/>`;
                }
            }
        }

        // Add any extra chapters
        const extraChapters = volumeChapters.get("extra") || [];
        if (extraChapters.length > 0) {
            // You may want to add a heading for these extra chapters
            for (const chapter of extraChapters) {
                spineItems += `
    <itemref idref="${chapter.id}"/>`;
            }
        }
    } else {
        // Original behavior - just add all chapters
        chapters.forEach((chapter) => {
            spineItems += `
    <itemref idref="${chapter.id}"/>`;
        });
    }

    // Add JavaScript files to manifest BEFORE creating the contentOpf string
    const jsDir = path.join(this.tempDir, "OEBPS", "js");
    if (fs.existsSync(jsDir)) {
        fs.readdirSync(jsDir).forEach((jsFile) => {
            if (jsFile.endsWith('.js')) {
                const jsId = `js-${path.basename(jsFile, '.js')}`;
                manifestItems += `
    <item id="${jsId}" href="js/${jsFile}" media-type="application/javascript"/>`;
            }
        });
    }

    const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId" prefix="calibre: https://calibre-ebook.com">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">${metadataElements}
  </metadata>
  <manifest>${manifestItems}
  </manifest>
  <spine toc="ncx">${spineItems}
  </spine>
</package>`;

    fs.writeFileSync(
        path.join(this.tempDir, "OEBPS", "content.opf"),
        contentOpf
    );
} 
