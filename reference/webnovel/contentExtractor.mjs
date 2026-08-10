import * as cheerio from "cheerio";
import he from "he";
import { Chapter, NovelMetadata } from "../baseScraper.mjs";
import { SELECTORS, TIMEOUTS, BLACKLISTED_CLASSES, BLACKLISTED_TAGS } from './constants.mjs';
import { UrlUtils } from './urlUtils.mjs';

export class ContentExtractor {
  constructor() { }

  /**
   * Extract novel metadata from page
   * @param {Page} page - Playwright page object
   * @returns {Promise<NovelMetadata>} - Novel metadata
   */
  async extractMetadata(page) {
    const metadata = new NovelMetadata();
    try {
      // Wait for title to be available
      await page.waitForSelector(SELECTORS.TITLE_WAIT);
      // Extract title
      const titleElem = await page.$(SELECTORS.TITLE);
      metadata.title = titleElem ? await titleElem.innerText() : "";
      // Extract author
      metadata.author = await this._extractAuthor(page);
      // Extract description
      metadata.description = await this._extractDescription(page);
      // Extract cover URL
      const coverElem = await page.$(SELECTORS.COVER);
      metadata.cover_url = coverElem ? await coverElem.getAttribute("src") : "";
      // Extract tags/subjects
      metadata.subjects = await this._extractTags(page);
    } catch (error) {
      console.log(`Error extracting metadata: ${error}`);
      console.log(error.stack);
    }
    return metadata;
  }

  /**
   * Extract author information from page
   * @param {Page} page - Playwright page object
   * @returns {Promise<string>} - Author name
   */
  async _extractAuthor(page) {
    try {
      // First attempt using the primary selector
      const authorElem = await page.$(SELECTORS.AUTHOR_PRIMARY);
      if (authorElem) {
        return await authorElem.innerText();
      }
      // If author is still empty, use the fallback structure
      const authorText = await page.evaluate(() => {
        const authorContainer = document.querySelector("address div.ell span");
        return authorContainer ? authorContainer.textContent.trim() : "";
      });
      return authorText;
    } catch (error) {
      console.error("Error extracting author:", error);
      return "";
    }
  }

  /**
   * Extract description from page
   * @param {Page} page - Playwright page object
   * @returns {Promise<string>} - Description HTML
   */
  async _extractDescription(page) {
    try {
      const descElem = await page.$(SELECTORS.DESCRIPTION);
      if (descElem) {
        const descriptionHtml = await descElem.innerHTML();
        // Clean description using cheerio
        const $ = cheerio.load(descriptionHtml);
        $(SELECTORS.DESCRIPTION_REMOVE).remove();
        return $.html();
      }
      return "";
    } catch (error) {
      console.error("Error extracting description:", error);
      return "";
    }
  }

  /**
   * Extract tags/subjects from page
   * @param {Page} page - Playwright page object
   * @returns {Promise<Array<string>>} - Array of tag names
   */
  async _extractTags(page) {
    try {
      await page.waitForSelector(SELECTORS.TAGS_CONTAINER, { timeout: TIMEOUTS.TAGS_WAIT });
      // Extract tag texts
      return await page.evaluate(() => {
        const tagElements = document.querySelectorAll(".m-tags a.fs12");
        const tags = [];
        tagElements.forEach((tag) => {
          // Extract just the tag name without the # symbol
          const tagText = tag.textContent.trim().replace("# ", "");
          if (tagText) {
            tags.push(tagText);
          }
        });
        return tags;
      });
    } catch (error) {
      console.error("Error extracting tags");
      return [];
    }
  }

  /**
   * Extract chapter list from catalog page
   * @param {Page} page - Playwright page object
   * @returns {Promise<Object>} - Object containing chapters, volumes, and unlocked chapters
   */
  async extractChapterList(page) {
    const chapters = [];
    const unlockedChapters = [];
    const volumes = [];
    try {
      // Wait for chapter links to load
      await page.waitForSelector(SELECTORS.CHAPTER_LINKS, { timeout: TIMEOUTS.ELEMENT_WAIT });
      // Extract volume information first
      const volumeItems = await page.$$(SELECTORS.VOLUME_ITEMS);
      if (volumeItems.length > 0) {
        // Process each volume
        for (const volumeItem of volumeItems) {
          const volumeData = await this._extractVolumeData(volumeItem, page);
          volumes.push(volumeData.volume);
          chapters.push(...volumeData.chapters);
          unlockedChapters.push(...volumeData.unlockedChapters);
        }
      }
      // If no chapters were found via volumes, fall back to alternative extraction
      if (chapters.length === 0) {
        console.log("No volume structure found, trying alternative chapter selectors...");
        const alternativeChapters = await this._extractAlternativeChapters(page);
        chapters.push(...alternativeChapters);
        unlockedChapters.push(...alternativeChapters);
      }
      if (chapters.length === 0) {
        console.log("Warning: No chapters could be found. Please check the URL and ensure you have access to the chapters.");
      } else {
        console.log(`Successfully extracted ${chapters.length} total chapters (${unlockedChapters.length} unlocked)`);
      }
    } catch (error) {
      console.log(`Error extracting chapter list: ${error}`);
      console.log(error.stack);
    }
    return { chapters, volumes, unlockedChapters };
  }

  /**
   * Extract volume data including chapters
   * @param {ElementHandle} volumeItem - Volume element
   * @param {Page} page - Playwright page object
   * @returns {Promise<Object>} - Volume data with chapters
   */
  async _extractVolumeData(volumeItem, page) {
    // Get volume name
    const volumeTitleElem = await volumeItem.$(SELECTORS.VOLUME_TITLE);
    const volumeName = volumeTitleElem
      ? await volumeTitleElem.innerText()
      : `Volume ${Date.now()}`;
    // Get chapters in this volume
    const volumeChapters = [];
    const volumeUnlockedChapters = [];
    // Extract unlocked chapters
    const chapterLinks = await volumeItem.$$(SELECTORS.UNLOCKED_CHAPTERS);
    for (const link of chapterLinks) {
      const chapterData = await this._extractChapterData(link, page);
      if (chapterData) {
        volumeChapters.push(chapterData);
        volumeUnlockedChapters.push(chapterData);
      }
    }
    const volume = {
      name: volumeName,
      chapters: volumeChapters,
      chapterCount: volumeChapters.length,
      unlockedChapterCount: volumeUnlockedChapters.length,
    };
    return {
      volume,
      chapters: volumeChapters,
      unlockedChapters: volumeUnlockedChapters
    };
  }

  /**
   * Extract chapter data from link element
   * @param {ElementHandle} link - Chapter link element
   * @param {Page} page - Playwright page object
   * @returns {Promise<Chapter>} - Chapter object
   */
  async _extractChapterData(link, page) {
    try {
      // Get chapter title
      const chapterTitle = (await link.getAttribute("title")) || (await link.innerText());
      // Get chapter URL
      let chapterUrl = await link.getAttribute("href");
      // Normalize URL
      chapterUrl = UrlUtils.normalizeChapterUrl(chapterUrl, page.url());
      // Create chapter object
      return new Chapter(chapterTitle, chapterUrl);
    } catch (error) {
      console.error("Error extracting chapter data:", error);
      return null;
    }
  }

  /**
   * Extract chapters using alternative selectors
   * @param {Page} page - Playwright page object
   * @returns {Promise<Array<Chapter>>} - Array of chapters
   */
  async _extractAlternativeChapters(page) {
    const chapters = [];
    for (const selector of SELECTORS.ALTERNATIVE_CHAPTER_SELECTORS) {
      const chapterLinks = await page.$$(selector);
      if (chapterLinks.length > 0) {
        console.log(`Found ${chapterLinks.length} chapters using selector: ${selector}`);
        for (const link of chapterLinks) {
          const chapterData = await this._extractChapterData(link, page);
          if (chapterData) {
            chapters.push(chapterData);
          }
        }
        // If chapters found, break the selector loop
        if (chapters.length > 0) {
          break;
        }
      }
    }
    return chapters;
  }
  /**
   * Extract chapter content from page
   * @param {Page} page - Playwright page object
   * @returns {Promise<Object>} - Chapter content data
   */

  async extractChapterContent(page) {
    try {
      // Wait for chapter content with extended timeout
      await page.waitForSelector(SELECTORS.CHAPTER_CONTENT, { timeout: TIMEOUTS.CHAPTER_CONTENT });
      // Extract footnotes first
      const footnotes = await this._extractFootnotes(page);
      // Extract chapter title and content
      const chapterData = await page.evaluate(() => {
        // Get chapter title
        const titleElem = document.querySelector(
          "h1.dib.mb0.fw700.fs24.lh1\\.5, h1.chapter-title, .j_chapterName"
        );
        const pageChapterTitle = titleElem ? titleElem.textContent.trim() : "";
        // Get content HTML
        const chapterBody = document.querySelector("div.cha-words");
        const fullHtmlContent = chapterBody ? chapterBody.innerHTML : null;
        return { pageChapterTitle, fullHtmlContent };
      });
      // Add footnotes to the chapter data
      chapterData.footnotes = footnotes;
      return chapterData;
    } catch (error) {
      console.error("Error extracting chapter content:", error);
      return null;
    }
  }

  /**
 * Extract footnotes by clicking on sup elements and capturing popup content
 * @param {Page} page - Playwright page object
 * @returns {Promise<Array>} - Array of footnote objects
 */
  async _extractFootnotes(page) {
    const footnotes = [];
    try {
      // Find all anno elements that contain footnotes
      const annoElements = await page.$$('anno[data-annotation-id]');

      for (let i = 0; i < annoElements.length; i++) {
        const annoElement = annoElements[i];
        try {
          // Get the unique annotation ID
          const annotationId = await annoElement.getAttribute('data-annotation-id');

          // Find the sup element within this anno element
          const supElement = await annoElement.$('sup');
          if (!supElement) continue;

          // Click on the sup element to trigger the footnote popup
          await supElement.click();

          // Wait a bit for the popup to appear
          await page.waitForTimeout(TIMEOUTS.FOOTNOTE_CLICK);

          // Try to find the footnote popup within this anno element
          const footnoteElement = await annoElement.$('.anno-drop');
          let footnoteData = null;

          if (footnoteElement) {
            const titleElement = await footnoteElement.$('.anno-drop-hd');
            const contentElement = await footnoteElement.$('.anno-drop-bd');

            if (titleElement && contentElement) {
              const title = await titleElement.textContent();
              const content = await contentElement.textContent();
              footnoteData = {
                title: title.trim(),
                content: content.trim()
              };
            }
          }

          // If we found footnote content, store it with the annotation ID
          if (footnoteData && (footnoteData.title || footnoteData.content)) {
            footnotes.push({
              ref: annotationId, // Use annotation ID as unique reference
              title: footnoteData.title,
              content: footnoteData.content
            });
          }

          // Close the popup by clicking on the paragraph element
          const parentP = await annoElement.evaluateHandle(el => el.closest('p'));
          if (parentP) {
            await parentP.click();
            await page.waitForTimeout(TIMEOUTS.FOOTNOTE_CLOSE);
          }

        } catch (error) {
          console.log(`Warning: Could not extract footnote ${i + 1}: ${error.message}`);
          continue;
        }
      }
    } catch (error) {
      console.log(`Error extracting footnotes: ${error.message}`);
    }

    return footnotes;
  }

  /**
   * Process chapter content with HTML cleaning and formatting
   * @param {string} htmlContent - Raw HTML content
   * @param {string} pageChapterTitle - Chapter title
   * @param {Array} footnotes - Array of footnote objects
   * @returns {string} - Processed HTML content
   */
  processChapterContent(htmlContent, pageChapterTitle = null, footnotes = []) {
    // Use cheerio to clean up the HTML
    const $ = cheerio.load(htmlContent, { decodeEntities: false });
    // Clean the HTML
    this._cleanElement($);
    // Find all sup elements within anno elements and add anchor links
    // Extract all paragraph elements and add footnote links
    const paragraphs = [];
    let footnoteCounter = 0;

    $("p").each((_, el) => {
      const $p = $(el).clone();

      // Find all sup elements within anno elements and add anchor links
      $p.find('anno[data-annotation-id] sup').each((index, sup) => {
        const $sup = $(sup);
        const $anno = $sup.closest('anno');
        const annotationId = $anno.attr('data-annotation-id');
        footnoteCounter++;

        if (annotationId) {
          // Create a clickable link to the footnote with annotation ID
          const footnoteLink = `<a href="#footnote-${annotationId}" class="footnote-link" id="footnote-ref-${annotationId}" title="Go to footnote ${footnoteCounter}">${footnoteCounter}</a>`;
          $sup.replaceWith(footnoteLink);
        }
      });

      paragraphs.push($p);
      $(el).remove();
    });
    // Safely encode the title
    const safeTitle = he.encode(pageChapterTitle || "Chapter");
    // Create footnotes HTML section
    const footnotesHTML = this._createFootnotesHTML(footnotes);
    // Create a properly formatted HTML structure
    const formattedHTML = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <title>${safeTitle}</title>
  </head>
  <body>
    <h2 class="chapter-page-title">${safeTitle}</h2>
    <div class="decorative-line">━━━━━✧✧✧✧━━━━━</div>
${paragraphs
        .map((p) => {
          p.removeAttr("class").removeAttr("id").removeAttr("style");
          return "    " + $.html(p);
        })
        .join("\n")}
    <div class="ending-line">✦ ✧ ✦ ✧ ✦</div>${footnotesHTML}
  </body>
</html>`;
    return formattedHTML;
  }

  /**
   * Clean HTML element by removing blacklisted classes and tags
   * @param {CheerioAPI} $ - Cheerio instance
   */
  _cleanElement($) {
    // Remove blacklisted tags completely
    for (const tag of BLACKLISTED_TAGS) {
      $(tag).remove();
    }
    // Remove elements with blacklisted classes
    for (const cls of BLACKLISTED_CLASSES) {
      $(`[class*="${cls}"]`).remove();
    }
    // Remove anno-drop elements after we've processed the footnotes
    $('.anno-drop').remove();
  }

  /**
   * Create footnotes HTML section
   * @param {Array} footnotes - Array of footnote objects
   * @returns {string} - Footnotes HTML
   */
  /**
 * Create footnotes HTML section
 * @param {Array} footnotes - Array of footnote objects
 * @returns {string} - Footnotes HTML
 */
  _createFootnotesHTML(footnotes) {
    if (!footnotes || footnotes.length === 0) {
      return "";
    }

    const footnoteItems = footnotes.map((footnote, index) => {
      const footnoteNum = index + 1; // Sequential numbering for display

      if (footnote.title) {
        return `        <div class="footnote-item" id="footnote-${he.encode(footnote.ref)}">
        <span class="footnote-ref">
          <a href="#footnote-ref-${he.encode(footnote.ref)}" class="footnote-back-link" title="Back to text">↩</a>
          ${footnoteNum}:
        </span>
        <span class="footnote-title">${he.encode(footnote.title)}</span>
        <span class="footnote-separator"> - </span>
        <span class="footnote-content">${he.encode(footnote.content)}</span>
      </div>`;
      } else {
        return `        <div class="footnote-item" id="footnote-${he.encode(footnote.ref)}">
        <span class="footnote-ref">
          <a href="#footnote-ref-${he.encode(footnote.ref)}" class="footnote-back-link" title="Back to text">↩</a>
          ${footnoteNum}:
        </span>
        <span class="footnote-content">${he.encode(footnote.content)}</span>
      </div>`;
      }
    }).join('\n');

    return `
    <div class="footnotes-section">
      <h3>Footnotes</h3>
      <div class="footnotes-list">
${footnoteItems}
      </div>
    </div>`;
  }
}