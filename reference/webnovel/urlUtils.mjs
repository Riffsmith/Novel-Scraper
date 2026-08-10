// src/scrapers/webnovel/urlUtils.mjs
import fetch from "node-fetch";

export class UrlUtils {
  /**
   * Construct catalog URL from novel URL
   * @param {string} novelUrl - The base novel URL
   * @returns {string} - The catalog URL
   */
  static getCatalogUrl(novelUrl) {
    if (!novelUrl.endsWith("/catalog")) {
      return novelUrl.replace(/\/$/, "") + "/catalog";
    }
    return novelUrl;
  }

  /**
   * Normalize chapter URL to absolute URL
   * @param {string} chapterUrl - The chapter URL (may be relative)
   * @param {string} pageUrl - The current page URL for context
   * @returns {string} - Absolute chapter URL
   */
  static normalizeChapterUrl(chapterUrl, pageUrl) {
    if (chapterUrl.startsWith("//")) {
      return `https:${chapterUrl}`;
    }

    if (chapterUrl.startsWith("/")) {
      const baseUrl = pageUrl.split("//")[1].split("/")[0];
      return `https://${baseUrl}${chapterUrl}`;
    }

    return chapterUrl;
  }

  /**
   * Validate if URL is a valid Webnovel URL
   * @param {string} url - URL to validate
   * @returns {boolean} - True if valid Webnovel URL
   */
  static isValidWebnovelUrl(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.includes("webnovel.com");
    } catch (error) {
      return false;
    }
  }

  /**
   * Extract novel ID from Webnovel URL
   * @param {string} url - Webnovel URL
   * @returns {string|null} - Novel ID or null if not found
   */
  static extractNovelId(url) {
    try {
      const urlObj = new URL(url);
      const pathSegments = urlObj.pathname.split("/").filter(Boolean);

      for (const segment of pathSegments) {
        if (/^\d+$/.test(segment)) {
          return segment;
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Build search URL for connectivity testing
   * @returns {string} - Google URL for connectivity testing
   */
  static getConnectivityTestUrl() {
    return "https://www.google.com";
  }

  /**
   * Follow redirects on a shortlink (e.g. wbnv.in) and return wherever it
   * actually lands. node-fetch follows redirects by default, so response.url
   * is the final destination after all hops.
   * @param {string} url - URL that may redirect elsewhere
   * @returns {Promise<string>} - Final resolved URL, or the original if resolution fails
   */
  static async resolveRedirect(url) {
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "follow",
      });
      return response.url || url;
    } catch (error) {
      console.log(
        `Warning: Could not resolve redirect for ${url}: ${error.message}`,
      );
      return url;
    }
  }

  /**
   * Strip the mobile subdomain and any locale segment from a WebNovel URL,
   * so the scraper always lands on the same desktop, English page its
   * selectors were built for.
   * e.g. https://m.webnovel.com/pt/book/12345 -> https://www.webnovel.com/book/12345
   * @param {string} url - Raw WebNovel URL
   * @returns {string} - Normalized URL
   */
  static normalizeWebnovelHost(url) {
    try {
      const urlObj = new URL(url);

      // "m." serves the mobile layout, which uses different markup entirely
      if (urlObj.hostname.startsWith("m.")) {
        urlObj.hostname = urlObj.hostname.replace(/^m\./, "www.");
      } else if (urlObj.hostname === "webnovel.com") {
        urlObj.hostname = "www.webnovel.com";
      }

      // Locale segments (/pt/, /id/, /vi/, /pt-br/...) sit between the host
      // and "book", and quietly switch the page language away from English
      urlObj.pathname = urlObj.pathname.replace(
        /^\/([a-z]{2}(?:-[a-z]{2,4})?)\/book\//i,
        "/book/",
      );

      urlObj.search = "";
      urlObj.hash = "";

      return urlObj.toString();
    } catch (error) {
      return url;
    }
  }

  /**
   * Resolve any WebNovel link - shortlink, mobile link, localized link -
   * into the clean, canonical desktop URL the scraper's selectors expect.
   * This is the single entry point callers should use.
   * @param {string} rawUrl - URL as typed/pasted by the user
   * @returns {Promise<string>} - Clean, canonical WebNovel URL
   */
  static async resolveNovelUrl(rawUrl) {
    let url = rawUrl.trim();

    // Not on webnovel.com yet - almost certainly a shortener (wbnv.in etc.) -
    // so follow it until it lands on the real book page
    if (!/webnovel\.com/i.test(url)) {
      const resolvedUrl = await UrlUtils.resolveRedirect(url);
      if (resolvedUrl !== url) {
        console.log(`Resolved short URL to: ${resolvedUrl}`);
      }
      url = resolvedUrl;
    }

    return UrlUtils.normalizeWebnovelHost(url);
  }
}
