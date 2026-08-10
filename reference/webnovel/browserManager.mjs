// src/scrapers/webnovel/browserManager.js

import fs from "fs";
import { chromium } from "playwright";
import { 
  BROWSER_CONFIG, 
  SELECTORS, 
  TIMEOUTS, 
  WEBDRIVER_BYPASS_SCRIPT, 
  WEBNOVEL_DOMAIN 
} from './constants.mjs';

export class BrowserManager {
  constructor(cookiesPath = null) {
    this.cookiesPath = cookiesPath;
    this.cookies = [];
    this.cookieHeader = "";
    this.isLoggedIn = false;
  }

  /**
   * Load cookies from account.json file
   */
  loadCookies() {
    try {
      if (this.cookiesPath && fs.existsSync(this.cookiesPath)) {
        const accountsData = JSON.parse(
          fs.readFileSync(this.cookiesPath, "utf-8")
        );
        
        let webnovelAccount = null;
        for (const account of accountsData) {
          if (account.domain === "Webnovel" && account.cookies) {
            webnovelAccount = account;
            break;
          }
        }
        
        if (webnovelAccount && webnovelAccount.cookies) {
          const webnovelCookies = webnovelAccount.cookies;
          const cookieList = [];
          const cookieStrings = [];
          
          // Convert dictionary format to Playwright's cookie format
          for (const [name, value] of Object.entries(webnovelCookies)) {
            // Skip empty cookie values
            if (!value) continue;

            const cookie = {
              name: name,
              value: value,
              domain: WEBNOVEL_DOMAIN,
              path: "/",
              secure: true,
              httpOnly: true,
            };
            cookieList.push(cookie);
            cookieStrings.push(`${name}=${value}`);
          }
          
          if (cookieList.length > 0) {
            this.cookies = cookieList;
            this.cookieHeader = cookieStrings.join("; ");
            console.log("Cookies from account file loaded successfully");
          } else {
            console.log("No valid cookies found in account file");
          }
        } else {
          console.log("No Webnovel account found in account file");
        }
      } else {
        console.log(`Cookies file not found or not specified`);
      }
    } catch (error) {
      console.log(`Error loading cookies: ${error}`);
      console.log(error.stack);
    }
  }

  /**
   * Create and set up browser context
   * @returns {Promise<{browser: Browser, context: BrowserContext}>}
   */
  async getBrowserContext() {
    const browser = await chromium.launch({
      headless: true,
      args: BROWSER_CONFIG.ARGS,
    });

    // Create a new context with custom user agent
    const context = await browser.newContext({
      userAgent: BROWSER_CONFIG.USER_AGENT,
      extraHTTPHeaders: BROWSER_CONFIG.EXTRA_HEADERS,
    });

    // Apply cookies if available
    if (this.cookies.length > 0) {
      await context.addCookies(this.cookies);
    }

    // Bypass webdriver detection
    await context.addInitScript(WEBDRIVER_BYPASS_SCRIPT);

    return { browser, context };
  }

  /**
   * Verify if login was successful by checking for user profile elements
   * @param {Page} page - Playwright page object
   */
  async verifyLoginStatus(page) {
    try {
      // Wait briefly for page to load
      await page.waitForTimeout(TIMEOUTS.LOGIN_VERIFICATION);

      // Check for login indicators
      for (const indicator of SELECTORS.LOGIN_INDICATORS) {
        const element = await page.$(indicator);
        if (element) {
          this.isLoggedIn = true;
          console.log("Successfully logged in to Webnovel");
          return;
        }
      }

      console.log(
        "Warning: Login may not have been successful. Continuing without authenticated session."
      );
    } catch (error) {
      console.log(`Error verifying login status: ${error}`);
      console.log(error.stack);
    }
  }

  /**
   * Get login status
   * @returns {boolean} - True if logged in
   */
  getLoginStatus() {
    return this.isLoggedIn;
  }

  /**
   * Get cookie header string
   * @returns {string} - Cookie header string
   */
  getCookieHeader() {
    return this.cookieHeader;
  }

  /**
   * Get cookies array
   * @returns {Array} - Array of cookie objects
   */
  getCookies() {
    return this.cookies;
  }

  /**
   * Check if cookies are available
   * @returns {boolean} - True if cookies are loaded
   */
  hasCookies() {
    return this.cookies.length > 0;
  }

  /**
   * Create a new page with default settings
   * @param {BrowserContext} context - Browser context
   * @returns {Promise<Page>} - Configured page
   */
  async createPage(context) {
    const page = await context.newPage();
    
    // Set longer timeout for potentially slow connections
    page.setDefaultTimeout(TIMEOUTS.CHAPTER_CONTENT);
    
    return page;
  }

  /**
   * Navigate to URL with retry-friendly options
   * @param {Page} page - Playwright page
   * @param {string} url - URL to navigate to
   * @param {Object} options - Navigation options
   * @returns {Promise<Response>} - Navigation response
   */
  async navigateToUrl(page, url, options = {}) {
    const defaultOptions = {
      waitUntil: "domcontentloaded",
      timeout: TIMEOUTS.PAGE_LOAD,
      ...options
    };

    return await page.goto(url, defaultOptions);
  }

  /**
   * Close browser resources safely
   * @param {BrowserContext} context - Browser context to close
   * @param {Browser} browser - Browser to close
   */
  async closeBrowser(context, browser) {
    try {
      if (context) await context.close();
      if (browser) await browser.close();
    } catch (cleanupError) {
      console.log(`⚠️  Warning: Error during cleanup: ${cleanupError.message}`);
    }
  }
}
