// ─────────────────────────────────────────────────────────────────────────────
//  T1 — SelectorService parity tests (CSS, XPath, regex anchor, format)
//  Maps to docs/phase-1/readme.md §3 table entry T1
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  isXPath,
  toPlaywrightXPath,
  formatLocator,
  validateRegex,
} from "../src/core/services/SelectorService.ts";

describe("SelectorService — isXPath", () => {
  it("recognises // prefix", () => {
    expect(isXPath("//div[@class='c']")).toBe(true);
  });
  it("recognises (// prefix (wrapped XPath)", () => {
    expect(isXPath("(//a)[1]")).toBe(true);
  });
  it("recognises explicit xpath= prefix", () => {
    expect(isXPath("xpath=//h1")).toBe(true);
  });
  it('recognises case-insensitive "XPath="', () => {
    expect(isXPath("XPATH=//div")).toBe(true);
  });
  it("returns false for CSS", () => {
    expect(isXPath(".chapter-content")).toBe(false);
    expect(isXPath("#main")).toBe(false);
  });
  it("handles whitespace around prefix", () => {
    expect(isXPath("  //thing")).toBe(true);
  });
});

describe("SelectorService — toPlaywrightXPath", () => {
  it("adds xpath= prefix for double-slash", () => {
    expect(toPlaywrightXPath("//div[@id='x']")).toBe("xpath=//div[@id='x']");
  });
  it("keeps existing xpath= prefix", () => {
    expect(toPlaywrightXPath("xpath=//h1")).toBe("xpath=//h1");
  });
  it("handles wrapped (// XPaths", () => {
    expect(toPlaywrightXPath("(//a)[3]")).toBe("xpath=(//a)[3]");
  });
});

describe("SelectorService — formatLocator", () => {
  it("formats CSS", () => {
    expect(formatLocator({ kind: "css", value: ".next-btn" })).toBe("[css]   .next-btn");
  });
  it("formats XPath", () => {
    expect(formatLocator({ kind: "xpath", value: "//a[@class='next']" })).toBe(
      "[xpath] //a[@class='next']",
    );
  });
  it("formats regex with default flags", () => {
    expect(formatLocator({ kind: "regex", value: "Next >>" })).toBe("[regex/i] Next >>");
  });
  it("formats regex with explicit flags", () => {
    expect(formatLocator({ kind: "regex", value: "next", flags: "g" })).toBe(
      "[regex/g] next",
    );
  });
});

describe("SelectorService — validateRegex", () => {
  it("returns a RegExp for valid patterns", () => {
    expect(validateRegex("next", "i")).toBeInstanceOf(RegExp);
  });
  it("throws on invalid patterns", () => {
    expect(() => validateRegex("[", "i")).toThrow(SyntaxError);
  });
  it("defaults flags to i", () => {
    const re = validateRegex("NEXT");
    expect(re.flags).toContain("i");
  });
});