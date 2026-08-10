// src/scrapers/webnovel/rateLimiter.js

import { TIMEOUTS, RETRY_CONFIG } from "./constants.mjs";
import { scraperEvents, ScraperEvents } from "../../events/scraperEvents.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  /**
   * @param {number} delay - Minimum ms to leave between requests
   * @param {Object} [overrides] - Optional overrides. Mainly here so tests
   *   can shrink the real-world delays down to milliseconds and supply an
   *   isolated event bus instead of the shared singleton.
   */
  constructor(delay = 750, overrides = {}) {
    this.delay = delay;
    this.lastRequestTime = 0;

    this.backoffBaseMs = overrides.backoffBaseMs ?? TIMEOUTS.RETRY_BASE_DELAY;
    this.backoffMaxMs = overrides.backoffMaxMs ?? TIMEOUTS.RETRY_MAX_DELAY;
    this.countdownIntervalMs =
      overrides.countdownIntervalMs ?? TIMEOUTS.COUNTDOWN_INTERVAL;
    // Delays at or above this length get a countdown instead of one silent
    // wait. Configurable (default 30s, matching the old hardcoded value) so
    // tests can shrink it instead of actually waiting half a minute.
    this.countdownThresholdMs = overrides.countdownThresholdMs ?? 30000;
    this.connectivityRetryMs =
      overrides.connectivityRetryMs ?? TIMEOUTS.CONNECTIVITY_RETRY;
    this.nonNetworkErrorDelayMs =
      overrides.nonNetworkErrorDelayMs ?? TIMEOUTS.NON_NETWORK_ERROR_DELAY;
    this.maxRetries = overrides.maxRetries ?? RETRY_CONFIG.MAX_RETRIES;
    this.events = overrides.events ?? scraperEvents;
  }

  /**
   * Simple rate limiting - wait if necessary between requests
   */
  async limit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.delay) {
      const waitMs = this.delay - timeSinceLastRequest;
      this.events.emit(ScraperEvents.RATE_LIMIT_WAIT, { waitMs });
      await sleep(waitMs);
    }

    this.lastRequestTime = Date.now();
  }

  /**
   * Wait with exponential backoff. Emits a BACKOFF_WAIT event for the
   * initial wait and for every countdown tick on long waits, so a listener
   * can render its own view instead of scraping console output for it.
   * @param {number} attemptNumber - Current attempt number (0-based)
   */
  async waitWithBackoff(attemptNumber) {
    const delayMs = Math.min(
      this.backoffBaseMs * Math.pow(2, attemptNumber),
      this.backoffMaxMs,
    );

    this.events.emit(ScraperEvents.BACKOFF_WAIT, {
      attempt: attemptNumber + 1,
      maxRetries: this.maxRetries,
      delayMs,
    });

    // Show a countdown for longer delays
    if (delayMs >= this.countdownThresholdMs) {
      const intervals = Math.floor(delayMs / this.countdownIntervalMs);
      for (let i = intervals; i > 0; i--) {
        this.events.emit(ScraperEvents.BACKOFF_WAIT, {
          attempt: attemptNumber + 1,
          maxRetries: this.maxRetries,
          remainingMs: i * this.countdownIntervalMs,
          countdown: true,
        });
        await sleep(this.countdownIntervalMs);
      }
    } else {
      await sleep(delayMs);
    }
  }

  /**
   * Wait for non-network errors
   */
  async waitForNonNetworkError() {
    await sleep(this.nonNetworkErrorDelayMs);
  }

  /**
   * Wait for connectivity retry
   */
  async waitForConnectivityRetry() {
    await sleep(this.connectivityRetryMs);
  }

  /**
   * Set custom delay
   * @param {number} delay - New delay in milliseconds
   */
  setDelay(delay) {
    this.delay = delay;
  }

  /**
   * Get current delay
   * @returns {number} - Current delay in milliseconds
   */
  getDelay() {
    return this.delay;
  }
}

