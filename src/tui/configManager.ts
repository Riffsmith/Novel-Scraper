// ─────────────────────────────────────────────────────────────────────────────
//  Config Manager TUI
//
//  Accessible from the main menu under "⚙  Settings".
//  Two sub-sections:
//    A) Global settings  (AppConfig  → XDG_CONFIG_HOME/webnovel-scraper/config.json)
//    B) Site profiles    (SiteProfile → XDG_DATA_HOME/webnovel-scraper/site-profiles.json)
// ─────────────────────────────────────────────────────────────────────────────

import chalk     from 'chalk';
import * as disp from './display.js';
import {
  readConfig, writeConfig, resetConfig,
  CONFIG_FILE, DEFAULT_CONFIG,
} from '../config/appConfig.js';
import {
  readProfiles, saveProfile, deleteProfile,
  listProfileDomains, loadProfile, PROFILES_FILE,
  normaliseDomain,
} from '../config/siteProfiles.js';
import { formatLocator } from '../scraper/selectors.js';
import type { AppConfig, SiteProfile } from '../types.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require('enquirer');
async function prompt<T extends Record<string, unknown>>(q: object | object[]): Promise<T> {
  return _prompt(q) as Promise<T>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Entry point — top-level settings menu
// ═══════════════════════════════════════════════════════════════════════════
export async function manageSettings(): Promise<void> {
  while (true) {
    disp.section('⚙   Settings');
    console.log(chalk.dim(`  Config  : ${CONFIG_FILE}`));
    console.log(chalk.dim(`  Profiles: ${PROFILES_FILE}`));
    console.log('');

    const { section } = await prompt<{ section: string }>({
      type   : 'select',
      name   : 'section',
      message: 'What would you like to configure?',
      choices: [
        { name: 'global',   message: '🌐  Global settings     (browser, delays, metadata defaults…)' },
        { name: 'profiles', message: '🗂   Site profiles       (per-domain extraction presets)' },
        { name: 'back',     message: chalk.dim('← Back') },
      ],
    });

    if (section === 'back')     break;
    if (section === 'global')   await editGlobalSettings();
    if (section === 'profiles') await manageSiteProfiles();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  A)  Global settings editor
// ═══════════════════════════════════════════════════════════════════════════
async function editGlobalSettings(): Promise<void> {
  const cfg = readConfig();

  disp.section('🌐  Global Settings');
  printConfig(cfg);

  while (true) {
    const { group } = await prompt<{ group: string }>({
      type   : 'select',
      name   : 'group',
      message: 'Which group of settings do you want to edit?',
      choices: [
        { name: 'output',    message: '📁  Output' },
        { name: 'browser',   message: '🌐  Browser & navigation' },
        { name: 'perf',      message: '⚡  Performance & stealth' },
        { name: 'metadata',  message: '📋  Metadata defaults' },
        { name: 'ux',        message: '🖥   UX behaviour' },
        { name: 'reset',     message: chalk.red('↺   Reset ALL settings to defaults') },
        { name: 'back',      message: chalk.dim('← Back') },
      ],
    });

    if (group === 'back') break;

    if (group === 'reset') {
      const { confirmed } = await prompt<{ confirmed: boolean }>({
        type   : 'confirm',
        name   : 'confirmed',
        message: chalk.red('Reset ALL settings to built-in defaults?'),
        initial: false,
      });
      if (confirmed) {
        resetConfig();
        disp.success('Settings reset to defaults');
      }
      break;
    }

    const latest = readConfig(); // re-read in case another group was just saved
    const updates = await editGroup(group, latest);
    if (Object.keys(updates).length > 0) {
      writeConfig(updates);
      disp.success('Settings saved');
      printConfig(readConfig()); // show updated values
    }
  }
}

// ── Edit one group of settings — returns only the changed keys ───────────────
async function editGroup(
  group: string,
  cfg  : AppConfig,
): Promise<Partial<AppConfig>> {
  if (group === 'output') {
    const r = await prompt<{ defaultOutputDir: string }>({
      type   : 'input',
      name   : 'defaultOutputDir',
      message: 'Default output directory:',
      initial: cfg.defaultOutputDir,
    });
    return { defaultOutputDir: r.defaultOutputDir.trim() || cfg.defaultOutputDir };
  }

  if (group === 'browser') {
    const r = await prompt<{
      headless: boolean; waitUntil: string; navigationTimeoutMs: string;
    }>([
      {
        type   : 'confirm',
        name   : 'headless',
        message: 'Run browser in headless mode? (false = see the browser window)',
        initial: cfg.headless,
      },
      {
        type   : 'select',
        name   : 'waitUntil',
        message: 'Wait for … before extracting content:',
        choices: [
          { name: 'domcontentloaded', message: 'domcontentloaded  (fastest — good for most sites)' },
          { name: 'load',             message: 'load              (wait for all resources)' },
          { name: 'networkidle',      message: 'networkidle       (best for heavy JS / SPA sites)' },
        ],
        initial: cfg.waitUntil,
      },
      {
        type    : 'input',
        name    : 'navigationTimeoutMs',
        message : 'Navigation timeout (ms):',
        initial : String(cfg.navigationTimeoutMs),
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 5_000) || 'Must be ≥ 5000 ms';
        },
      },
    ]);
    return {
      headless            : r.headless,
      waitUntil           : r.waitUntil as AppConfig['waitUntil'],
      navigationTimeoutMs : parseInt(r.navigationTimeoutMs, 10),
    };
  }

  if (group === 'perf') {
    const r = await prompt<{
      defaultConcurrency: string; delayRange: string; maxRetries: string;
    }>([
      {
        type    : 'input',
        name    : 'defaultConcurrency',
        message : 'Default concurrent pages (1–5):',
        initial : String(cfg.defaultConcurrency),
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 1 && n <= 5) || 'Must be 1–5';
        },
      },
      {
        type    : 'input',
        name    : 'delayRange',
        message : 'Default delay range in ms (min-max):',
        initial : `${cfg.defaultDelayMin}-${cfg.defaultDelayMax}`,
        validate: (v: string) => {
          const [a, b] = v.split('-').map(Number);
          return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || 'Format: min-max';
        },
      },
      {
        type    : 'input',
        name    : 'maxRetries',
        message : 'Max retries per failed chapter:',
        initial : String(cfg.maxRetries),
        validate: (v: string) => {
          const n = parseInt(v, 10);
          return (!isNaN(n) && n >= 0 && n <= 10) || 'Must be 0–10';
        },
      },
    ]);
    const [min, max] = r.delayRange.split('-').map(Number);
    return {
      defaultConcurrency: parseInt(r.defaultConcurrency, 10),
      defaultDelayMin   : min,
      defaultDelayMax   : max,
      maxRetries        : parseInt(r.maxRetries, 10),
    };
  }

  if (group === 'metadata') {
    const r = await prompt<{
      defaultLanguage: string; defaultAuthor: string; defaultPublisher: string;
    }>([
      { type: 'input', name: 'defaultLanguage',  message: 'Default language (ISO 639-1):', initial: cfg.defaultLanguage  },
      { type: 'input', name: 'defaultAuthor',    message: 'Default author name:',          initial: cfg.defaultAuthor    },
      { type: 'input', name: 'defaultPublisher', message: 'Default publisher / source:',   initial: cfg.defaultPublisher },
    ]);
    return {
      defaultLanguage : r.defaultLanguage.trim()  || cfg.defaultLanguage,
      defaultAuthor   : r.defaultAuthor.trim()    || cfg.defaultAuthor,
      defaultPublisher: r.defaultPublisher.trim() || cfg.defaultPublisher,
    };
  }

  if (group === 'ux') {
    const r = await prompt<{ askSaveProfile: boolean; logLevel: string }>([
      {
        type   : 'confirm',
        name   : 'askSaveProfile',
        message: 'After scraping a new domain, ask to save extraction settings as a site profile?',
        initial: cfg.askSaveProfile,
      },
      {
        type   : 'select',
        name   : 'logLevel',
        message: 'Console log level:',
        choices: ['error', 'warn', 'info', 'debug'],
        initial: cfg.logLevel,
      },
    ]);
    return {
      askSaveProfile: r.askSaveProfile,
      logLevel      : r.logLevel as AppConfig['logLevel'],
    };
  }

  return {};
}

// ── Pretty-print current AppConfig ────────────────────────────────────────────
function printConfig(cfg: AppConfig): void {
  const def = DEFAULT_CONFIG as Record<string, unknown>;
  const cur = cfg as unknown as Record<string, unknown>;

  console.log('');
  const rows: [string, string, boolean][] = [
    ['defaultOutputDir',     cur.defaultOutputDir     as string, true ],
    ['defaultConcurrency',   String(cur.defaultConcurrency),     true ],
    ['defaultDelayMin/Max',  `${cur.defaultDelayMin}–${cur.defaultDelayMax} ms`, true],
    ['headless',             String(cur.headless),               true ],
    ['waitUntil',            cur.waitUntil            as string, true ],
    ['navigationTimeoutMs',  `${cur.navigationTimeoutMs} ms`,    true ],
    ['maxRetries',           String(cur.maxRetries),             true ],
    ['defaultLanguage',      cur.defaultLanguage      as string, true ],
    ['defaultAuthor',        cur.defaultAuthor        as string, true ],
    ['defaultPublisher',     cur.defaultPublisher     as string, true ],
    ['logLevel',             cur.logLevel             as string, true ],
    ['askSaveProfile',       String(cur.askSaveProfile),         true ],
  ];

  for (const [key, val] of rows) {
    const isDefault = String(val) === String(def[key] ?? '');
    const valueStr  = isDefault
      ? chalk.dim(val)
      : chalk.cyan.bold(val) + chalk.yellow(' *');
    console.log(`  ${chalk.white(key.padEnd(24))} ${valueStr}`);
  }
  console.log(chalk.dim('  (* = differs from built-in default)'));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  B)  Site-profile manager
// ═══════════════════════════════════════════════════════════════════════════
export async function manageSiteProfiles(): Promise<void> {
  while (true) {
    const domains = listProfileDomains();

    disp.section('🗂   Site Profiles');
    console.log(chalk.dim(`  ${domains.length} profile(s) stored`));
    console.log('');

    const choices = [
      ...domains.map(d => {
        const p = loadProfile(d)!;
        const method = p.method === 'toc' ? chalk.cyan('toc') : chalk.magenta('seq');
        return {
          name   : d,
          message: `${chalk.white(d.padEnd(32))} [${method}]  ${chalk.dim(p.label ?? '')}`,
        };
      }),
      { name: '__back__', message: chalk.dim('← Back') },
    ];

    const { selected } = await prompt<{ selected: string }>({
      type   : 'select',
      name   : 'selected',
      message: domains.length > 0
        ? 'Select a profile to view / edit:'
        : 'No site profiles saved yet. They are created automatically after scraping.',
      choices,
    });

    if (selected === '__back__') break;
    await editSiteProfile(selected);
  }
}

// ── View + edit a single site profile ────────────────────────────────────────
async function editSiteProfile(domain: string): Promise<void> {
  const profile = loadProfile(domain);
  if (!profile) { disp.err(`Profile for ${domain} not found`); return; }

  printProfile(profile);

  while (true) {
    const { action } = await prompt<{ action: string }>({
      type   : 'select',
      name   : 'action',
      message: `Manage profile for ${chalk.cyan(domain)}:`,
      choices: [
        { name: 'edit_label',     message: '✏️   Edit label / notes' },
        { name: 'edit_selectors', message: '🎯  Edit selectors (content, title, excludes)' },
        { name: 'edit_perf',      message: '⚡  Edit per-site performance overrides' },
        { name: 'delete',         message: chalk.red('🗑   Delete this profile') },
        { name: 'back',           message: chalk.dim('← Back') },
      ],
    });

    if (action === 'back') break;

    if (action === 'edit_label') {
      const r = await prompt<{ label: string; notes: string }>([
        { type: 'input', name: 'label', message: 'Human-friendly label:', initial: profile.label ?? '' },
        { type: 'input', name: 'notes', message: 'Notes (optional):',     initial: profile.notes ?? '' },
      ]);
      profile.label = r.label.trim() || undefined;
      profile.notes = r.notes.trim() || undefined;
      saveProfile(profile);
      disp.success('Profile updated');
      printProfile(profile);
    }

    if (action === 'edit_selectors') {
      const r = await prompt<{
        contentSelector: string; separateTitle: boolean;
        titleSelector: string; exclusionList: string;
      }>([
        {
          type    : 'input',
          name    : 'contentSelector',
          message : 'Content selector (CSS or XPath):',
          initial : profile.contentSelector,
          validate: (v: string) => v.trim().length > 0 || 'Cannot be empty',
        },
        {
          type   : 'confirm',
          name   : 'separateTitle',
          message: 'Extract title from a separate element?',
          initial: profile.separateTitle,
        },
        {
          type   : 'input',
          name   : 'titleSelector',
          message: 'Title selector (leave blank to clear):',
          initial: profile.titleSelector ?? '',
        },
        {
          type   : 'input',
          name   : 'exclusionList',
          message: 'Exclude selectors (comma-separated, blank = none):',
          initial: profile.excludeSelectors.join(', '),
        },
      ]);

      profile.contentSelector  = r.contentSelector.trim();
      profile.separateTitle    = r.separateTitle;
      profile.titleSelector    = r.titleSelector.trim() || undefined;
      profile.excludeSelectors = r.exclusionList.split(',').map(s => s.trim()).filter(Boolean);
      saveProfile(profile);
      disp.success('Profile updated');
      printProfile(profile);
    }

    if (action === 'edit_perf') {
      const r = await prompt<{
        concurrency: string; delayRange: string;
      }>([
        {
          type    : 'input',
          name    : 'concurrency',
          message : 'Concurrency for this site (1–5, blank = use global default):',
          initial : String(profile.concurrency ?? ''),
          validate: (v: string) => {
            if (!v.trim()) return true;
            const n = parseInt(v, 10);
            return (!isNaN(n) && n >= 1 && n <= 5) || 'Must be 1–5';
          },
        },
        {
          type    : 'input',
          name    : 'delayRange',
          message : 'Delay range ms for this site (min-max, blank = use global default):',
          initial : profile.delayMin != null ? `${profile.delayMin}-${profile.delayMax}` : '',
          validate: (v: string) => {
            if (!v.trim()) return true;
            const [a, b] = v.split('-').map(Number);
            return (!isNaN(a) && !isNaN(b) && a >= 0 && b >= a) || 'Format: min-max';
          },
        },
      ]);

      profile.concurrency = r.concurrency.trim() ? parseInt(r.concurrency, 10) : undefined;
      if (r.delayRange.trim()) {
        const [mn, mx] = r.delayRange.split('-').map(Number);
        profile.delayMin = mn;
        profile.delayMax = mx;
      } else {
        profile.delayMin = undefined;
        profile.delayMax = undefined;
      }
      saveProfile(profile);
      disp.success('Profile updated');
    }

    if (action === 'delete') {
      const { confirmed } = await prompt<{ confirmed: boolean }>({
        type   : 'confirm',
        name   : 'confirmed',
        message: chalk.red(`Delete profile for ${domain}?`),
        initial: false,
      });
      if (confirmed) {
        deleteProfile(domain);
        disp.success(`Profile for ${domain} deleted`);
        break;
      }
    }
  }
}

// ── Pretty-print a SiteProfile ────────────────────────────────────────────────
function printProfile(p: SiteProfile): void {
  console.log('');
  const row = (k: string, v: string) =>
    console.log(`  ${chalk.dim(k.padEnd(22))} ${chalk.white(v)}`);

  row('Domain',   p.domain);
  if (p.label) row('Label', p.label);
  row('Method',   p.method);
  row('Content',  p.contentSelector);
  row('Sep.title', String(p.separateTitle));
  if (p.titleSelector) row('Title sel.', p.titleSelector);
  if (p.excludeSelectors.length) row('Exclude', p.excludeSelectors.join(', '));
  if (p.nextButtonLocators?.length) {
    p.nextButtonLocators.forEach((l, i) => {
      row(i === 0 ? 'Next (primary)' : `Next (fallback ${i})`, formatLocator(l));
    });
  }
  if (p.concurrency != null) row('Concurrency', String(p.concurrency));
  if (p.delayMin    != null) row('Delay', `${p.delayMin}–${p.delayMax} ms`);
  if (p.notes)               row('Notes', p.notes);
  row('Saved',    p.savedAt.slice(0, 10));
  row('Updated',  p.updatedAt.slice(0, 10));
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Post-scrape: ask user whether to save extraction settings as a profile.
//  Called from index.ts after a successful scrape of a new domain.
// ═══════════════════════════════════════════════════════════════════════════
export async function promptSaveProfile(
  domain         : string,
  partialProfile : Omit<SiteProfile, 'domain' | 'label' | 'notes' | 'savedAt' | 'updatedAt'>,
): Promise<void> {
  disp.section('💾  Save Site Profile');
  disp.info(`This is the first time you scraped ${chalk.cyan(domain)}.`);
  disp.dim('Saving these extraction settings lets you skip the selector prompts next time.');
  console.log('');

  const { save } = await prompt<{ save: boolean }>({
    type   : 'confirm',
    name   : 'save',
    message: `Save extraction settings for ${chalk.cyan(domain)} as a reusable profile?`,
    initial: true,
  });

  if (!save) return;

  const { label } = await prompt<{ label: string }>({
    type   : 'input',
    name   : 'label',
    message: 'Short label for this site (optional):',
    hint   : 'e.g.  Royal Road  |  WebNovel.com  |  ScribbleHub',
  });

  const profile: SiteProfile = {
    ...partialProfile,
    domain   : normaliseDomain(domain),
    label    : label.trim() || undefined,
    savedAt  : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveProfile(profile);
  disp.success(`Profile saved — it will auto-fill your selector prompts next time you scrape ${domain}`);
}
