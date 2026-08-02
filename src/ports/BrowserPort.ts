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
}

export interface BrowserPort {
  launch(opts: BrowserLaunchOpts): Promise<BrowserHandle>;
  createContext(browser: BrowserHandle, cookies?: import("../core/domain/Cookie.js").DomainCookie[]): Promise<ContextHandle>;
  newPage(ctx: ContextHandle): Promise<PageHandle>;
  closeAll(): Promise<void>;

  /** Ephemeral headed browser for login capture.  Phase 3 scope. */
  launchEphemeral?(opts: BrowserLaunchOpts): Promise<BrowserHandle>;
}