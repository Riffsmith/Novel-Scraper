// src/scrapers/webnovel/constants.mjs

export const SELECTORS = {
  // Title selectors
  TITLE: "p:has(a[title=home]) > span:last-child",
  TITLE_WAIT: "p > span:last-child",

  // Author selectors
  AUTHOR_PRIMARY: "a.c_primary",
  AUTHOR_FALLBACK: "address div.ell span",

  // Description selectors
  DESCRIPTION: "div.g_txt_over",
  DESCRIPTION_REMOVE: "span._readmore",

  // Cover selectors
  COVER: "._sd > i:nth-child(1) > img:nth-child(1)",

  // Tags selectors
  TAGS_CONTAINER: ".m-tags",
  TAGS_ITEMS: ".m-tags a.fs12",

  // Chapter selectors
  CHAPTER_LINKS: ".volume-item a:not(:has(svg)), a.chapter-item",
  VOLUME_ITEMS: "div.volume-item",
  VOLUME_TITLE: "h4",
  UNLOCKED_CHAPTERS: "a:not(:has(svg))",

  // Chapter content selectors
  CHAPTER_CONTENT: "div.cha-words",
  CHAPTER_TITLE: "h1.dib.mb0.fw700.fs24.lh1\\.5, h1.chapter-title, .j_chapterName",

  // Login indicators
  LOGIN_INDICATORS: [
    ".j_user_name",
    "#headerAvatar",
    ".profile-avatar",
    'a[href*="myinfo"]',
    ".j_header_user_item",
  ],

  // Footnote selectors
  FOOTNOTE_ELEMENTS: 'anno[data-annotation-id] sup',
  FOOTNOTE_POPUPS: ['.anno-drop', '.footnote-popup', '.tooltip'],
  FOOTNOTE_TITLE: ".anno-drop-hd",
  FOOTNOTE_CONTENT: ".anno-drop-bd",

  // Alternative chapter selectors (fallback)
  ALTERNATIVE_CHAPTER_SELECTORS: [
    ".volume-item a:not(:has(svg))",
    "a.chapter-item",
    ".chapter-list a",
    ".catalog-content a:not(:has(svg))",
  ],
};

export const TIMEOUTS = {
  PAGE_LOAD: 60000,
  ELEMENT_WAIT: 60000,
  CHAPTER_CONTENT: 90000,
  TAGS_WAIT: 10000,
  LOGIN_VERIFICATION: 2000,
  FOOTNOTE_CLICK: 500,
  FOOTNOTE_CLOSE: 200,
  RETRY_BASE_DELAY: 10000,
  RETRY_MAX_DELAY: 300000,
  CONNECTIVITY_CHECK: 15000,
  CONNECTIVITY_RETRY: 30000,
  NON_NETWORK_ERROR_DELAY: 5000,
  COUNTDOWN_INTERVAL: 10000,
};

export const RETRY_CONFIG = {
  MAX_RETRIES: 5,
  MAX_CONNECTIVITY_ATTEMPTS: 10,
  COUNTDOWN_INTERVALS: 3, // For delays >= 30 seconds
};

export const NETWORK_ERROR_INDICATORS = [
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_CONNECTION_FAILED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_NAME_NOT_RESOLVED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'TimeoutError',
  'timeout',
  'Navigation timeout',
  'cloudflare',
  'challenge'
];

export const BLACKLISTED_CLASSES = [
  "icon",
  "para-comment",
  "j_open_para_comment",
  "j_para_comment_count",
  "para-comment-num",
  "cha-hr",
  "cha-info",
  "j_bottom_comment_area",
  "user-links-wrap",
];

export const BLACKLISTED_TAGS = ["pirate", "i"];

export const BROWSER_CONFIG = {
  ARGS: [
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-size=1280,720",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-gpu",
    "--no-sandbox",
    '--js-flags="--max_old_space_size=512"',
  ],
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  EXTRA_HEADERS: {
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  },
};

export const WEBDRIVER_BYPASS_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined
  });
  delete navigator.webdriver;
`;

export const WEBNOVEL_DOMAIN = ".webnovel.com";

export const DEFAULT_RATE_LIMIT_DELAY = 750;
