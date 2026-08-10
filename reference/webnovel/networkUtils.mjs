// src/scrapers/webnovel/networkUtils.js

import {
  NETWORK_ERROR_INDICATORS,
  RETRY_CONFIG,
  TIMEOUTS,
} from "./constants.mjs";
import { UrlUtils } from "./urlUtils.mjs";
import { scraperEvents, ScraperEvents } from "../../events/scraperEvents.mjs";

export class NetworkUtils {
  /**
   * Detect if error is network-related
   * @param {Error} error - Error to check
   * @returns {boolean} - True if network error
   */
  static isNetworkError(error) {
    const errorString = error.toString().toLowerCase();
    return NETWORK_ERROR_INDICATORS.some((indicator) =>
      errorString.includes(indicator.toLowerCase()),
    );
  }

  /**
   * Test network connectivity
   * @param {Function} getBrowserContext - Function to get browser context
   * @returns {Promise<boolean>} - True if network is available
   */
  static async testNetworkConnectivity(getBrowserContext) {
    try {
      const { browser, context } = await getBrowserContext();
      const page = await context.newPage();

      // Try to reach a simple, reliable endpoint
      await page.goto(UrlUtils.getConnectivityTestUrl(), {
        waitUntil: "domcontentloaded",
        timeout: TIMEOUTS.CONNECTIVITY_CHECK,
      });

      await context.close();
      await browser.close();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Wait for network recovery with multiple attempts, reporting progress
   * through events instead of console.log so any listener - progress bar,
   * plain logger, test - can react to the same signal.
   * @param {Function} getBrowserContext - Function to get browser context
   * @param {Object} rateLimiter - Rate limiter instance used to space out retries
   * @param {import('node:events').EventEmitter} [events] - Event bus to emit on
   * @returns {Promise<boolean>} - True if network recovered
   */
  static async waitForNetworkRecovery(
    getBrowserContext,
    rateLimiter,
    events = scraperEvents,
  ) {
    events.emit(ScraperEvents.CONNECTIVITY_CHECK_START, {});

    let networkOk = false;
    let connectivityAttempts = 0;

    while (
      !networkOk &&
      connectivityAttempts < RETRY_CONFIG.MAX_CONNECTIVITY_ATTEMPTS
    ) {
      networkOk = await NetworkUtils.testNetworkConnectivity(getBrowserContext);

      if (!networkOk) {
        connectivityAttempts++;
        events.emit(ScraperEvents.CONNECTIVITY_LOST, {
          attempt: connectivityAttempts,
          maxAttempts: RETRY_CONFIG.MAX_CONNECTIVITY_ATTEMPTS,
        });
        await rateLimiter.waitForConnectivityRetry();
      } else {
        events.emit(ScraperEvents.CONNECTIVITY_RESTORED, {});
      }
    }

    if (!networkOk) {
      events.emit(ScraperEvents.CONNECTIVITY_FAILED, {
        attempts: connectivityAttempts,
      });
      throw new Error("Network connectivity could not be established");
    }

    return networkOk;
  }

  /**
   * Emit network error information
   * @param {Error} error - The network error
   * @param {number} attempt - Current attempt number
   * @param {import('node:events').EventEmitter} [events] - Event bus to emit on
   */
  static logNetworkError(error, attempt, events = scraperEvents) {
    events.emit(ScraperEvents.NETWORK_ERROR, { error, attempt });
  }

  /**
   * Emit non-network error information
   * @param {Error} error - The error
   * @param {import('node:events').EventEmitter} [events] - Event bus to emit on
   */
  static logNonNetworkError(error, events = scraperEvents) {
    events.emit(ScraperEvents.NON_NETWORK_ERROR, { error });
  }

  /**
   * Check if error indicates Cloudflare challenge
   * @param {Error} error - Error to check
   * @returns {boolean} - True if likely Cloudflare challenge
   */
  static isCloudflareError(error) {
    const errorString = error.toString().toLowerCase();
    return (
      errorString.includes("cloudflare") || errorString.includes("challenge")
    );
  }

  /**
   * Emit Cloudflare error information
   * @param {import('node:events').EventEmitter} [events] - Event bus to emit on
   */
  static logCloudflareError(events = scraperEvents) {
    events.emit(ScraperEvents.CLOUDFLARE_CHALLENGE, {});
  }

  /**
   * Create error retry context
   * @param {Error} error - The error that occurred
   * @param {number} attempt - Current attempt number
   * @param {number} maxRetries - Maximum number of retries
   * @returns {Object} - Context object with error analysis
   */
  static createErrorContext(error, attempt, maxRetries) {
    const isNetwork = NetworkUtils.isNetworkError(error);
    const isCloudflare = NetworkUtils.isCloudflareError(error);
    const canRetry = attempt < maxRetries - 1;

    return {
      isNetwork,
      isCloudflare,
      canRetry,
      attempt,
      maxRetries,
      error,
    };
  }
}

