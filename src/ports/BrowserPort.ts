// ─────────────────────────────────────────────────────────────────────────────
//  BrowserPort — thin abstraction over a headless browser.
//
//  Deliberately does NOT expose a generic evaluate() method. Every
//  browser-side operation is a named method on PageHandle so the
//  evaluate-as-string constraint (audit P4) is enforced by construction,
//  not by convention.  See docs/phase-1/readme.md §1.6.
// ─────────────────────────────────────────────────────────────────────────────

import type { DomainCookie } from "../core/domain/Cookie.js";

export type WaitUntil = "domcontentloaded" | "networkidle" | "load";

export interface BrowserLaunchOpts {
  headless: boolean;
  humanize: boolean;
  humanPreset: "default" | "careful";
  fingerprintSeed: number | null;
  timezone: string;
  locale: string;
}

export interface BrowserHandle {
  close(): Promise<void>;
}

export interface ContextHandle {
  close(): Promise<void>;
}

export interface ElementRef {
  // Opaque reference to a live DOM element inside the page.
  // Consumers call hrefOf() or clickAndWaitNav() on it.
  readonly _kind: "ElementRef";
}

export interface PageHandle {
  goto(url: string, opts: { waitUntil: WaitUntil; timeoutMs: number }): Promise<void>;
  title(): Promise<string>;
  content(): Promise<string>;
  locatorCount(cssSelector: string): Promise<number>;
  innerHTML(selector: string, timeoutMs: number): Promise<string | null>;
  textContent(selector: string, timeoutMs: number): Promise<string | null>;
  removeFromDom(selectors: string[]): Promise<void>;
  findElement(selector: string): Promise<ElementRef | null>;
  findAnchorByRegex(pattern: string, flags: string): Promise<ElementRef | null>;
  hrefOf(el: ElementRef): Promise<string | null>;
  clickAndWaitNav(el: ElementRef, timeoutMs: number): Promise<string>;
  waitForSelector(selector: string, timeoutMs: number): Promise<void>;
  bodyInnerText(): Promise<string>;
  url(): string;
  close(): Promise<void>;

  // ── Phase 4 site-adapter additions (ADR-P4-A) ──────────────────────────────
  //
  // All three are the v2 ports of v1 site-adapter evaluate operations. Every
  // one is a NAMED method returning plain values - never a generic evaluate()
  // closure - so the P4 evaluate-as-string invariant stays enforced by
  // construction (read AGENTS.md "page.evaluate() string-constant rule").

  /**
   * Read the first matching element's `attr` (optionally falling back to a
   * second attribute, mirroring v1's lazy-load `src`/`data-src` cover probe).
   * Returns null on miss or error.
   */
  getAttribute(selector: string, attr: string, fallbackAttr?: string): Promise<string | null>;

  /**
   * Read the first matching element's `innerText`, with optional noise
   * descendant strips so the cover-toggle/text-toggle that ships inside the
   * synopsis container doesn't leak into the description. Best-effort null
   * on miss.
   */
  innerText(selector: string, timeoutMs: number, excludeSelectors?: string[]): Promise<string | null>;

  /**
   * Return `Array.from(document.querySelectorAll(selector)).map(a => a.href)`
   * from the live page - used by every site adapter's chapter-list extractor.
   * The selector does both: scope (`.chapter-list` for novelfire) and pattern
   * (`a[href*="/chapter-"]` for wtr-lab). Honouring the P4 rule: the actual
   * script is a string constant inside the Playwright adapter, not a closure
   * parameter here.
   */
  anchorHrefs(selector: string): Promise<string[]>;

  /**
   * Evaluate a string script in the page context (ADR-P4-A).
   *
   * The script MUST be a plain string constant defined in the adapter, never a
   * function reference or a closure - esbuild's keepNames transform would
   * inject a `__name()` helper that does not exist in browser scope, causing
   * a silent ReferenceError (read AGENTS.md "page.evaluate() string-constant
   * rule", v1 sites/wtrLab.ts:61-73 note). The TUI's SiteAdapter ports supply
   * the constant; this method just ships it.
   */
  evaluateScript<T>(script: string): Promise<T>;
}

export interface BrowserPort {
  launch(opts: BrowserLaunchOpts): Promise<BrowserHandle>;
  createContext(browser: BrowserHandle, cookies?: import("../core/domain/Cookie.js").DomainCookie[]): Promise<ContextHandle>;
  newPage(ctx: ContextHandle): Promise<PageHandle>;
  closeAll(): Promise<void>;

  /** Ephemeral headed browser for login capture.  Phase 3 scope. */
  launchEphemeral?(opts: BrowserLaunchOpts): Promise<BrowserHandle>;

  /**
   * Read every cookie currently attached to a context.
   *
   * Phase 3 addition (ADR-P3-A): cookie login-capture needs the equivalent
   * of Playwright's `context.cookies()` exposed through the port so the
   * ui-clack capture flow never imports Playwright. A named method (not a
   * generic evaluate()) keeps the P4 evaluate-as-string rule enforceable
   * by construction, mirroring `findElement()` / `url()` from Phase 1 D3.
   */
  contextCookies(ctx: ContextHandle): Promise<import("../core/domain/Cookie.js").StoredCookie[]>;
}