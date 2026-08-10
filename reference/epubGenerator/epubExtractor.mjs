import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import AdmZip from "adm-zip";
import * as cheerio from "cheerio";
import { logger } from "../cli/ui/logger.mjs";
import { theme } from "../cli/ui/theme.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class EPUBExtractor {
    constructor(epubPath, outputDir) {
        this.epubPath = epubPath;
        this.outputDir = outputDir;
        this.chaptersDir = path.join(outputDir, "chapters");
        this.extractedDir = path.join(outputDir, "extracted_epub");
    }

    async extractEpub() {
        try {
            logger.info(`Extracting existing EPUB: ${theme.accent(path.basename(this.epubPath))}`);

            // Check if EPUB exists
            if (!fs.existsSync(this.epubPath)) {
                throw new Error(`EPUB file not found: ${this.epubPath}`);
            }

            // Create extraction directory
            if (!fs.existsSync(this.extractedDir)) {
                fs.mkdirSync(this.extractedDir, { recursive: true });
            }

            // Extract EPUB
            const zip = new AdmZip(this.epubPath);
            zip.extractAllTo(this.extractedDir, true);

            // Find and extract chapters
            const extractedChapters = await this.findAndExtractChapters();

            logger.info(`Extracted ${theme.accent(extractedChapters.length)} chapters from existing EPUB`);
            return extractedChapters;

        } catch (error) {
            logger.warn(`Failed to extract EPUB: ${error.message}`);
            logger.warn("Falling back to replace mode (redownload all chapters)");
            return null; // Return null to indicate fallback to replace mode
        }
    }

    async findAndExtractChapters() {
        const extractedChapters = [];
        const oebpsDir = path.join(this.extractedDir, "OEBPS");

        if (!fs.existsSync(oebpsDir)) {
            throw new Error("Invalid EPUB structure: OEBPS directory not found");
        }

        // Read content.opf to find chapter files
        const contentOpfPath = path.join(oebpsDir, "content.opf");
        if (!fs.existsSync(contentOpfPath)) {
            throw new Error("Invalid EPUB structure: content.opf not found");
        }

        const contentOpf = fs.readFileSync(contentOpfPath, "utf8");
        const $ = cheerio.load(contentOpf, { xmlMode: true });

        // Build manifest map for quick lookup
        const manifestMap = new Map();
        $("manifest item").each((i, elem) => {
            const $elem = $(elem);
            const id = $elem.attr("id");
            const href = $elem.attr("href");
            const mediaType = $elem.attr("media-type");

            if (id && href && mediaType) {
                manifestMap.set(id, {
                    id: id,
                    href: href,
                    mediaType: mediaType,
                    path: path.join(oebpsDir, href)
                });
            }
        });

        // Get spine order (this is the correct reading order)
        const spineItems = [];
        $("spine itemref").each((i, elem) => {
            const idref = $(elem).attr("idref");
            if (idref && manifestMap.has(idref)) {
                const manifestItem = manifestMap.get(idref);

                // Filter for chapter files using your specific convention
                if (manifestItem.mediaType === "application/xhtml+xml" &&
                    manifestItem.href &&
                    (manifestItem.href.startsWith("chapter") || manifestItem.href.includes("chapter")) &&
                    !manifestItem.href.includes("title") &&
                    !manifestItem.href.includes("synopsis") &&
                    !manifestItem.href.includes("volume")) {

                    spineItems.push({
                        spineIndex: i + 1, // 1-based spine position
                        ...manifestItem
                    });
                }
            }
        });

        logger.info(`Found ${spineItems.length} chapter items in spine order`);

        // Extract chapter content and save to chapters directory
        for (let i = 0; i < spineItems.length; i++) {
            const item = spineItems[i];

            if (fs.existsSync(item.path)) {
                const chapterContent = fs.readFileSync(item.path, "utf8");

                // Extract the original chapter number from filename for verification
                const filenameMatch = item.href.match(/chapter(\d+)/);
                const originalChapterNumber = filenameMatch ? parseInt(filenameMatch[1]) : null;

                // Use spine order as the new chapter number (1-based)
                const newChapterNumber = i + 1;

                const chapterData = this.parseChapterContent(chapterContent, newChapterNumber, originalChapterNumber);

                if (chapterData) {
                    // Save chapter in HTML format using spine order
                    const chapterFileName = `${String(newChapterNumber).padStart(3, '0')}_${this.sanitizeFilename(chapterData.title)}.html`;
                    const chapterFilePath = path.join(this.chaptersDir, chapterFileName);

                    // Create chapters directory if it doesn't exist
                    if (!fs.existsSync(this.chaptersDir)) {
                        fs.mkdirSync(this.chaptersDir, { recursive: true });
                    }

                    // Save chapter content as HTML
                    fs.writeFileSync(chapterFilePath, chapterData.content, "utf8");

                    extractedChapters.push({
                        number: newChapterNumber,
                        originalNumber: originalChapterNumber,
                        title: chapterData.title,
                        fileName: chapterFileName,
                        filePath: chapterFilePath,
                        originalHref: item.href,
                        spineIndex: item.spineIndex
                    });

                    // Log mapping for debugging
                    if (originalChapterNumber && originalChapterNumber !== newChapterNumber) {
                        logger.info(`Mapped: ${item.href} (orig: ${originalChapterNumber}) -> ${String(newChapterNumber).padStart(3, '0')} (spine order)`);
                    }
                }
            } else {
                logger.warn(`Chapter file not found: ${item.path}`);
            }
        }

        return extractedChapters;
    }

    parseChapterContent(htmlContent, chapterNumber, originalChapterNumber = null) {
        try {
            // Load with XML mode to properly handle XHTML
            const $ = cheerio.load(htmlContent, {
                xmlMode: true,
                decodeEntities: false
            });

            // Extract title - try different selectors
            let title = $("title").text().trim() ||
                $("h1").first().text().trim() ||
                $("h2").first().text().trim() ||
                $(".chapter-page-title").first().text().trim() ||
                `Chapter ${chapterNumber}`;

            // Clean up title - remove "Chapter X:" prefix if present
            title = title.replace(/^Chapter\s*\d+\s*:?\s*/i, "").trim();
            if (!title) {
                title = `Chapter ${chapterNumber}`;
            }

            // Add original chapter number info to title if different (for debugging)
            if (originalChapterNumber && originalChapterNumber !== chapterNumber) {
                // You can remove this line if you don't want the original number in the title
                // title = `${title} (orig: ${originalChapterNumber})`;
            }

            // Get the CSS link from the original
            const cssLink = $('link[rel="stylesheet"]').attr('href');

            // Extract the main content from the body
            let bodyContent = $("body").html();

            if (!bodyContent) {
                logger.warn(`No body content found for chapter ${chapterNumber}`);
                return null;
            }

            // Clean up the body content to remove any [object Promise] or similar artifacts
            bodyContent = bodyContent
                .replace(/\[object Promise\]/g, '') // Remove [object Promise]
                .replace(/\s*\[object\s+[^\]]*\]/g, '') // Remove any [object ...] patterns
                .trim();

            // Check if the body content already contains a chapter div
            // If it does, don't wrap it in another one
            const $bodyContent = cheerio.load(bodyContent, { xmlMode: true });
            const hasChapterDiv = $bodyContent('.chapter').length > 0;

            // Create a clean HTML structure that preserves the original formatting
            const content = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
    <title>${this.escapeHtml(title)}</title>
    <meta charset="utf-8"/>
    ${cssLink ? `<link rel="stylesheet" type="text/css" href="${cssLink}" />` : ''}
    <style>
        body {
            font-family: serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        .chapter {
            margin: 20px 0;
        }
        .chapter-page-title {
            text-align: center;
            font-size: 1.5em;
            margin: 20px 0;
        }
        .decorative-line {
            text-align: center;
            margin: 20px 0;
            font-size: 0.9em;
        }
        .ending-line {
            text-align: center;
            margin: 30px 0;
            font-size: 0.9em;
        }
        p {
            margin: 1em 0;
            text-align: justify;
        }
    </style>
</head>
<body>
${hasChapterDiv ? bodyContent : `<div class="chapter">\n${bodyContent}\n</div>`}
</body>
</html>`;

            return {
                title: title,
                content: content
            };

        } catch (error) {
            logger.warn(`Failed to parse chapter ${chapterNumber}: ${error.message}`);
            return null;
        }
    }

    escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }

    sanitizeFilename(filename) {
        return filename
            .replace(/[<>:"/\\|?*]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 100);
    }

    cleanup() {
        // Clean up extracted directory
        if (fs.existsSync(this.extractedDir)) {
            fs.rmSync(this.extractedDir, { recursive: true, force: true });
        }
    }
}