// src/scrapers/webnovel/webnovelScraper.js

import { BaseScraper, Chapter, NovelMetadata } from "../baseScraper.mjs";
import { BrowserManager } from "./browserManager.mjs";
import { RateLimiter } from "./rateLimiter.mjs";
import { ContentExtractor } from "./contentExtractor.mjs";
import { NetworkUtils } from "./networkUtils.mjs";
import { UrlUtils } from "./urlUtils.mjs";
import { RETRY_CONFIG, DEFAULT_RATE_LIMIT_DELAY } from "./constants.mjs";
import { getAccountFilePath } from "../../utils/accountUtils.mjs";

export class WebnovelScraper extends BaseScraper {
  constructor(novelUrl, cookiesPath = null, rateLimitDelay = DEFAULT_RATE_LIMIT_DELAY) {
    super();
    this.novelUrl = novelUrl;

    // Initialize components
    this.browserManager = new BrowserManager(cookiesPath || getAccountFilePath());
    this.rateLimiter = new RateLimiter(rateLimitDelay);
    this.contentExtractor = new ContentExtractor();

    // Data storage
    this.metadata = null;
    this.chapters = [];
    this.volumes = [];
    this.unlockedChapters = [];

    // Load cookies once at initialization
    this.browserManager.loadCookies();
  }

  /**
   * Get novel metadata
   * @returns {Promise<NovelMetadata>} - Novel metadata
   */
  async getMetadata() {
    await this.rateLimiter.limit();

    const { browser, context } = await this.browserManager.getBrowserContext();

    try {
      const page = await this.browserManager.createPage(context);

      // Navigate to novel page
      await this.browserManager.navigateToUrl(page, this.novelUrl);

      // Verify login status
      await this.browserManager.verifyLoginStatus(page);
      console.log("Fetching novel metadata...");

      // Extract metadata
      const metadata = await this.contentExtractor.extractMetadata(page);
      this.metadata = metadata;

      return metadata;
    } catch (error) {
      console.log(`Error extracting metadata: ${error}`);
      console.log(error.stack);
      return new NovelMetadata();
    } finally {
      await this.browserManager.closeBrowser(context, browser);
    }
  }

  /**
   * Get chapter list from catalog
   * @returns {Promise<Object>} - Object containing chapters, volumes, and unlocked chapters
   */
  async getChapterList() {
    await this.rateLimiter.limit();

    const { browser, context } = await this.browserManager.getBrowserContext();

    try {
      const page = await this.browserManager.createPage(context);

      // Construct catalog URL
      const catalogUrl = UrlUtils.getCatalogUrl(this.novelUrl);

      // Navigate to catalog page
      await this.browserManager.navigateToUrl(page, catalogUrl);

      // Verify login status on the catalog page
      await this.browserManager.verifyLoginStatus(page);

      // Extract chapter list
      const result = await this.contentExtractor.extractChapterList(page);

      // Store results
      this.chapters = result.chapters;
      this.volumes = result.volumes;
      this.unlockedChapters = result.unlockedChapters;

      return result;
    } catch (error) {
      console.log(`Error extracting chapter list: ${error}`);
      console.log(error.stack);

      // Handle specific error types
      if (NetworkUtils.isCloudflareError(error)) {
        NetworkUtils.logCloudflareError();
      }

      return { chapters: [], volumes: [], unlockedChapters: [] };
    } finally {
      await this.browserManager.closeBrowser(context, browser);
    }
  }

  /**
   * Get chapter content with robust error handling
   * @param {Chapter|Object} chapter - Chapter object or chapter data
   * @returns {Promise<string|null>} - Chapter content HTML or null
   */
  async getChapterContent(chapter) {
    await this.rateLimiter.limit();

    let attempt = 0;
    let htmlContent = null;

    while (attempt < RETRY_CONFIG.MAX_RETRIES) {
      let browser = null;
      let context = null;

      try {
        // Handle both chapter object directly or chapter inside a volume
        const chapterObj = this._normalizeChapterObject(chapter);

        if (!chapterObj || !chapterObj.url) {
          console.log("❌ Invalid chapter object provided");
          return null;
        }

        // Get browser context
        const browserContext = await this.browserManager.getBrowserContext();
        browser = browserContext.browser;
        context = browserContext.context;

        const page = await this.browserManager.createPage(context);

        // Navigate to chapter URL
        await this.browserManager.navigateToUrl(page, chapterObj.url, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });

        // Extract chapter content
        const chapterData = await this.contentExtractor.extractChapterContent(page);

        if (!chapterData || !chapterData.fullHtmlContent) {
          console.log(`⚠️  Warning: No content found for chapter ${chapterObj.title}`);
          return null;
        }

        // Process chapter content
        htmlContent = this.contentExtractor.processChapterContent(
          chapterData.fullHtmlContent,
          chapterData.pageChapterTitle,
          chapterData.footnotes
        );

        break; // Success! Exit the retry loop

      } catch (error) {
        const errorContext = NetworkUtils.createErrorContext(error, attempt, RETRY_CONFIG.MAX_RETRIES);
        console.log(`❌ Error in attempt ${attempt + 1} for chapter ${chapter.title || "unknown"}: ${error.message}`);

        if (errorContext.isNetwork && errorContext.canRetry) {
          NetworkUtils.logNetworkError(error, attempt);
          
          // Wait with exponential backoff
          await this.rateLimiter.waitWithBackoff(attempt);

          // Wait for network recovery
          await NetworkUtils.waitForNetworkRecovery(
            () => this.browserManager.getBrowserContext(),
            this.rateLimiter
          );
        } else if (errorContext.canRetry) {
          // Non-network error - shorter delay
          NetworkUtils.logNonNetworkError(error);
          await this.rateLimiter.waitForNonNetworkError();
        }

        attempt++;

        if (attempt >= RETRY_CONFIG.MAX_RETRIES) {
          console.log(`💥 Failed to scrape chapter ${chapter.title || "unknown"} after ${RETRY_CONFIG.MAX_RETRIES} attempts`);
          console.log(`📝 Final error: ${error.message}`);
          throw error;
        }

      } finally {
        // Ensure browser resources are cleaned up
        await this.browserManager.closeBrowser(context, browser);
      }
    }

    return htmlContent;
  }

  /**
   * Normalize chapter object to ensure consistent structure
   * @param {Chapter|Object} chapter - Chapter object or data
   * @returns {Chapter|null} - Normalized chapter object
   */
  _normalizeChapterObject(chapter) {
    if (chapter instanceof Chapter) {
      return chapter;
    }

    if (typeof chapter === "object" && chapter.url) {
      return new Chapter(chapter.title || "Chapter", chapter.url);
    }

    return null;
  }

  /**
   * Get login status
   * @returns {boolean} - True if logged in
   */
  isLoggedIn() {
    return this.browserManager.getLoginStatus();
  }

  /**
   * Get cookie header
   * @returns {string} - Cookie header string
   */
  getCookieHeader() {
    return this.browserManager.getCookieHeader();
  }

  /**
   * Check if cookies are available
   * @returns {boolean} - True if cookies are loaded
   */
  hasCookies() {
    return this.browserManager.hasCookies();
  }

  /**
   * Get all chapters (alias for backward compatibility)
   * @returns {Array<Chapter>} - Array of all chapters
   */
  getAllChapters() {
    return this.chapters;
  }

  /**
   * Get unlocked chapters only
   * @returns {Array<Chapter>} - Array of unlocked chapters
   */
  getUnlockedChapters() {
    return this.unlockedChapters;
  }

  /**
   * Get volumes with chapters
   * @returns {Array<Object>} - Array of volume objects
   */
  getVolumes() {
    return this.volumes;
  }

  /**
   * Get novel metadata (cached)
   * @returns {NovelMetadata|null} - Cached metadata or null
   */
  getCachedMetadata() {
    return this.metadata;
  }

  /**
   * Set rate limit delay
   * @param {number} delay - Delay in milliseconds
   */
  setRateLimitDelay(delay) {
    this.rateLimiter.setDelay(delay);
  }

  /**
   * Get current rate limit delay
   * @returns {number} - Current delay in milliseconds
   */
  getRateLimitDelay() {
    return this.rateLimiter.getDelay();
  }

  /**
   * Close scraper (for backward compatibility)
   */
  async close() {
    // No persistent browser to close in the current implementation
    console.log("WebnovelScraper closed");
  }
}

export default WebnovelScraper;