import archiver from "archiver";
import cliProgress from "cli-progress";
import fs from "fs";
import * as html from "html-entities";
import path from "path";

export async function createNavXhtml(chapters, volumePages = []) {
    let tocItems = `
      <li><a href="xhtml/titlepage.xhtml">Title Page</a></li>
      <li><a href="xhtml/synopsis.xhtml">Synopsis</a></li>`;

    // If we have volumes, create a nested TOC structure
    if (volumePages.length > 0 && this.volumes) {
        // Use our new method to correctly assign chapters to volumes
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

        // Add volumes and their chapters to TOC
        for (let i = 0; i < volumePages.length; i++) {
            // Find the corresponding volume index for this volume page
            const volumeIndex =
                parseInt(volumePages[i].id.replace("volume", "")) - 1;

            // Only add volumes that have chapters
            if (volumesWithChapters.has(volumeIndex)) {
                // Add volume entry
                tocItems += `
      <li>
        <a href="${volumePages[i].href}">${volumePages[i].title}</a>
        <ol>`;

                // Add chapters for this volume
                const volumeChapterList = volumeChapters.get(volumeIndex) || [];
                for (const chapter of volumeChapterList) {
                    const decodedTitle = html.decode(chapter.title);
                    tocItems += `
          <li><a href="${chapter.href}">${decodedTitle}</a></li>`;
                }

                tocItems += `
        </ol>
      </li>`;
            }
        }

        // Add any extra chapters
        const extraChapters = volumeChapters.get("extra") || [];
        if (extraChapters.length > 0) {
            tocItems += `
      <li>
        <a href="#">Additional Chapters</a>
        <ol>`;

            for (const chapter of extraChapters) {
                const decodedTitle = html.decode(chapter.title);
                tocItems += `
          <li><a href="${chapter.href}">${decodedTitle}</a></li>`;
            }

            tocItems += `
        </ol>
      </li>`;
        }
    } else {
        // Original behavior - flat chapter list
        chapters.forEach((chapter) => {
            const decodedTitle = html.decode(chapter.title);
            tocItems += `
      <li><a href="${chapter.href}">${decodedTitle}</a></li>`;
        });
    }

    const navXhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head>
  <title>Navigation</title>
  <meta charset="utf-8"/>
  <link rel="stylesheet" type="text/css" href="css/styles.css" />
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Table of Contents</h1>
    <ol>${tocItems}
    </ol>
  </nav>
</body>
</html>`;

    fs.writeFileSync(path.join(this.tempDir, "OEBPS", "nav.xhtml"), navXhtml);
}

export async function createTocNcx(chapters, volumePages = []) {
    const title = this.metadata.title || "Untitled Novel";
    const author = this.metadata.author || "Unknown Author";

    let navPoints = `
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel>
        <text>Title Page</text>
      </navLabel>
      <content src="xhtml/titlepage.xhtml"/>
    </navPoint>
    <navPoint id="navpoint-2" playOrder="2">
      <navLabel>
        <text>Synopsis</text>
      </navLabel>
      <content src="xhtml/synopsis.xhtml"/>
    </navPoint>`;

    let playOrder = 3;

    // If we have volumes, create a nested TOC structure
    if (volumePages.length > 0 && this.volumes) {
        // Use our new method to correctly assign chapters to volumes
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

        // Add volumes and their chapters to NCX
        for (let i = 0; i < volumePages.length; i++) {
            // Find the corresponding volume index for this volume page
            const volumeIndex =
                parseInt(volumePages[i].id.replace("volume", "")) - 1;

            // Only add volumes that have chapters
            if (volumesWithChapters.has(volumeIndex)) {
                // Add volume entry
                navPoints += `
      <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">
        <navLabel>
          <text>${volumePages[i].title}</text>
        </navLabel>
        <content src="${volumePages[i].href}"/>`;

                playOrder++;

                // Add chapters for this volume
                const volumeChapterList = volumeChapters.get(volumeIndex) || [];
                for (const chapter of volumeChapterList) {
                    const decodedTitle = html.decode(chapter.title);
                    navPoints += `
        <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">
          <navLabel>
            <text>${decodedTitle}</text>
          </navLabel>
          <content src="${chapter.href}"/>
        </navPoint>`;

                    playOrder++;
                }

                // Close volume navPoint
                navPoints += `
      </navPoint>`;
            }
        }

        // Add any extra chapters
        const extraChapters = volumeChapters.get("extra") || [];
        if (extraChapters.length > 0) {
            navPoints += `
      <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">
        <navLabel>
          <text>Additional Chapters</text>
        </navLabel>
        <content src="#"/>`;

            playOrder++;

            for (const chapter of extraChapters) {
                const decodedTitle = html.decode(chapter.title);
                navPoints += `
        <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">
          <navLabel>
            <text>${decodedTitle}</text>
          </navLabel>
          <content src="${chapter.href}"/>
        </navPoint>`;

                playOrder++;
            }

            navPoints += `
      </navPoint>`;
        }
    } else {
        // Original behavior - flat chapter list
        chapters.forEach((chapter) => {
            const decodedTitle = html.decode(chapter.title);
            navPoints += `
      <navPoint id="navpoint-${playOrder}" playOrder="${playOrder}">
        <navLabel>
          <text>${decodedTitle}</text>
        </navLabel>
        <content src="${chapter.href}"/>
      </navPoint>`;

            playOrder++;
        });
    }

    const tocNcx = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${this.uuid}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${title}</text>
  </docTitle>
  <docAuthor>
    <text>${author}</text>
  </docAuthor>
  <navMap>${navPoints}
  </navMap>
</ncx>`;

    fs.writeFileSync(path.join(this.tempDir, "OEBPS", "toc.ncx"), tocNcx);
}

export async function assignChaptersToVolumes(chapters) {
    // Create a map to hold chapters by volume
    const volumeChapters = new Map();
    for (let i = 0; i < this.volumes.length; i++) {
        volumeChapters.set(i, []);
    }
    volumeChapters.set("extra", []);

    // Go through each chapter and assign it to the correct volume
    for (const chapter of chapters) {
        // Extract the actual chapter number from filename
        const chapterFile = path.basename(chapter.href);
        const match = chapterFile.match(/chapter_(\d+)\.xhtml/);
        let chapterNumber = 0;

        if (match) {
            chapterNumber = parseInt(match[1], 10);
        } else {
            // Try to extract from the original id pattern
            const idMatch = chapter.id.match(/chapter(\d+)/);
            if (idMatch) {
                chapterNumber = parseInt(idMatch[1], 10);
            }
        }

        // Find which volume this chapter belongs to
        let volumeIndex = -1;
        let chapterStart = 0;

        for (let i = 0; i < this.volumes.length; i++) {
            const volume = this.volumes[i];
            const volumeChapterCount = volume.chapters?.length || 0;

            // If this volume has chapters and our chapter number falls in its range
            if (volumeChapterCount > 0) {
                // Check if the chapter number falls within this volume's range
                if (
                    chapterNumber > chapterStart &&
                    chapterNumber <= chapterStart + volumeChapterCount
                ) {
                    volumeIndex = i;
                    break;
                }
            }

            chapterStart += volumeChapterCount;
        }

        // Add chapter to the correct volume
        if (volumeIndex >= 0 && volumeChapters.has(volumeIndex)) {
            volumeChapters.get(volumeIndex).push(chapter);
        } else {
            volumeChapters.get("extra").push(chapter);
        }
    }

    return volumeChapters;
}

export async function getVolumeForChapterIndex(chapterIndex) {
    if (!this.volumes || this.volumes.length === 0) return null;

    // Get the actual chapter number from the filename
    // (assuming filenames are like "123_chaptername.html" where 123 is the chapter number)
    // Instead of using relative position, use absolute chapter number

    for (let i = 0; i < this.volumes.length; i++) {
        const volume = this.volumes[i];

        // Check if this chapter number falls within this volume's chapter range
        if (volume.chapters && volume.chapters.length > 0) {
            const firstChapter = volume.chapters[0].number || 0;
            const lastChapter =
                volume.chapters[volume.chapters.length - 1].number || 0;

            if (chapterIndex >= firstChapter && chapterIndex <= lastChapter) {
                return volume;
            }
        }
    }

    return null;
}