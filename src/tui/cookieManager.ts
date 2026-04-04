// ─────────────────────────────────────────────────────────────────────────────
//  Cookie Manager TUI
//
//  Provides an interactive terminal UI to:
//    • List domains that have stored cookies
//    • Inspect cookies for a domain  
//    • Add cookies (interactive k/v OR paste a raw Cookie: header)
//    • Delete individual cookies by name
//    • Delete all cookies for a domain
// ─────────────────────────────────────────────────────────────────────────────

import chalk      from 'chalk';
import * as disp  from './display.js';
import {
  listDomains,
  readStore,
  saveCookiesForDomain,
  upsertCookies,
  deleteCookie,
  deleteDomain,
  parseCookieHeader,
  COOKIE_FILE,
  type StoredCookie,
} from '../cookies/store.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { prompt: _prompt } = require('enquirer');

async function prompt<T extends Record<string, unknown>>(
  questions: object | object[],
): Promise<T> {
  return _prompt(questions) as Promise<T>;
}

// ── URL validator ─────────────────────────────────────────────────────────────
function validateDomain(val: string): boolean | string {
  const trimmed = val.trim();
  if (!trimmed) return 'Domain cannot be empty';
  // Accept bare hostname or full URL
  try {
    const h = trimmed.startsWith('http') ? new URL(trimmed).hostname : trimmed;
    if (h.includes('.') || h === 'localhost') return true;
    return 'Enter a valid hostname  e.g. novelupdates.com';
  } catch {
    return 'Invalid domain / URL';
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────
function printCookieTable(cookies: StoredCookie[], domain: string): void {
  console.log('');
  console.log(
    chalk.dim('  ' + '─'.repeat(70)),
  );
  console.log(
    chalk.white.bold(`  Cookies for ${chalk.cyan(domain)}`) +
    chalk.dim(` (${cookies.length} stored)`),
  );
  console.log(chalk.dim('  ' + '─'.repeat(70)));

  if (cookies.length === 0) {
    console.log(chalk.dim('  (no cookies stored)'));
  } else {
    cookies.forEach((c, i) => {
      const expiry = c.expires === -1
        ? chalk.dim('session')
        : chalk.dim(new Date(c.expires * 1000).toLocaleDateString());
      const flags  = [
        c.httpOnly ? chalk.yellow('httpOnly') : '',
        c.secure   ? chalk.green('secure')    : '',
      ].filter(Boolean).join(' ');

      console.log(
        `  ${chalk.dim((i + 1).toString().padStart(3) + '.')}  ` +
        chalk.cyan(c.name.padEnd(32)) +
        chalk.white(truncate(c.value, 24).padEnd(26)) +
        expiry.padEnd(14) + flags,
      );
    });
  }
  console.log(chalk.dim('  ' + '─'.repeat(70)));
  console.log('');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main cookie manager entry point
// ═══════════════════════════════════════════════════════════════════════════
export async function manageCookies(): Promise<void> {
  disp.section('🍪  Cookie Manager');
  console.log(chalk.dim(`  Store: ${COOKIE_FILE}`));
  console.log('');

  while (true) {
    const domains = listDomains();

    // ── Top-level domain picker ──────────────────────────────────────────
    const domainChoices = [
      ...domains.map(d => {
        const count = readStore()[d]?.length ?? 0;
        return { name: d, message: `${chalk.cyan(d)}  ${chalk.dim(`(${count} cookie${count !== 1 ? 's' : ''})`)}`};
      }),
      { name: '__add__',  message: chalk.green('➕  Add cookies for a new domain') },
      { name: '__back__', message: chalk.dim('← Back / Exit') },
    ];

    const { selectedDomain } = await prompt<{ selectedDomain: string }>({
      type   : 'select',
      name   : 'selectedDomain',
      message: domains.length > 0
        ? 'Select a domain to manage, or add a new one:'
        : 'No cookies stored yet. Add some?',
      choices: domainChoices,
    });

    if (selectedDomain === '__back__') break;

    if (selectedDomain === '__add__') {
      await addDomainFlow(null);
      continue;
    }

    // ── Domain-level actions ─────────────────────────────────────────────
    await manageDomainFlow(selectedDomain);
  }
}

// ── Add-domain flow (shared with "add from domain management screen") ─────────
async function addDomainFlow(prefillDomain: string | null): Promise<void> {
  const { domain } = await prompt<{ domain: string }>({
    type    : 'input',
    name    : 'domain',
    message : 'Domain (e.g. novelupdates.com):',
    initial : prefillDomain ?? '',
    validate: validateDomain,
  });

  await addCookiesFlow(domain.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]);
}

// ── Per-domain management loop ────────────────────────────────────────────────
async function manageDomainFlow(domain: string): Promise<void> {
  while (true) {
    const cookies = readStore()[domain] ?? [];
    printCookieTable(cookies, domain);

    const { action } = await prompt<{ action: string }>({
      type   : 'select',
      name   : 'action',
      message: `Manage cookies for ${chalk.cyan(domain)}:`,
      choices: [
        { name: 'add_kv',     message: '➕  Add / update cookie (interactive key-value)' },
        { name: 'add_header', message: '📋  Paste raw Cookie: header string' },
        { name: 'delete_one', message: '🗑   Delete a cookie by name', disabled: cookies.length === 0 },
        { name: 'delete_all', message: chalk.red('💥  Delete ALL cookies for this domain'), disabled: cookies.length === 0 },
        { name: 'back',       message: chalk.dim('← Back') },
      ],
    });

    if (action === 'back') break;

    if (action === 'add_kv') {
      await addCookiesFlow(domain);

    } else if (action === 'add_header') {
      await pasteHeaderFlow(domain);

    } else if (action === 'delete_one') {
      const { cookieName } = await prompt<{ cookieName: string }>({
        type   : 'select',
        name   : 'cookieName',
        message: 'Which cookie to delete?',
        choices: cookies.map(c => ({ name: c.name, message: `${chalk.cyan(c.name)}  ${chalk.dim(truncate(c.value, 40))}` })),
      });
      const deleted = deleteCookie(domain, cookieName);
      deleted
        ? disp.success(`Deleted "${cookieName}"`)
        : disp.warn(`"${cookieName}" was not found`);

    } else if (action === 'delete_all') {
      const { confirmed } = await prompt<{ confirmed: boolean }>({
        type   : 'confirm',
        name   : 'confirmed',
        message: chalk.red(`Delete ALL ${cookies.length} cookie(s) for ${domain}?`),
        initial: false,
      });
      if (confirmed) {
        deleteDomain(domain);
        disp.success(`All cookies for ${domain} deleted`);
        break; // return to domain list since domain is gone
      }
    }
  }
}

// ── Interactive key-value cookie entry ────────────────────────────────────────
async function addCookiesFlow(domain: string): Promise<void> {
  disp.info('Enter cookie name/value pairs. Leave name blank to finish.');
  disp.dim ('Press Enter on the name prompt with nothing typed to stop.');

  const added: StoredCookie[] = [];

  while (true) {
    const { name } = await prompt<{ name: string }>({
      type   : 'input',
      name   : 'name',
      message: `Cookie name  (blank = done):`,
    });

    if (!name.trim()) break;

    const { value } = await prompt<{ value: string }>({
      type   : 'input',
      name   : 'value',
      message: `Value for "${name.trim()}":`,
    });

    // Optional advanced settings
    const { wantAdvanced } = await prompt<{ wantAdvanced: boolean }>({
      type   : 'confirm',
      name   : 'wantAdvanced',
      message: 'Set advanced options (path / secure / httpOnly / sameSite / expiry)?',
      initial: false,
    });

    let path     = '/';
    let secure   = false;
    let httpOnly = false;
    let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
    let expires  = -1;

    if (wantAdvanced) {
      const adv = await prompt<{
        path: string; secure: boolean; httpOnly: boolean;
        sameSite: string; expiryDays: string;
      }>([
        { type: 'input',   name: 'path',       message: 'Path:',         initial: '/'    },
        { type: 'confirm', name: 'secure',      message: 'Secure?',       initial: false  },
        { type: 'confirm', name: 'httpOnly',    message: 'HttpOnly?',     initial: false  },
        {
          type   : 'select',
          name   : 'sameSite',
          message: 'SameSite:',
          choices: ['Lax', 'Strict', 'None'],
          initial: 'Lax',
        },
        {
          type    : 'input',
          name    : 'expiryDays',
          message : 'Expire after N days (-1 = session):',
          initial : '-1',
          validate: (v: string) => {
            const n = parseInt(v, 10);
            return (!isNaN(n) && (n === -1 || n > 0)) || 'Enter a positive integer or -1';
          },
        },
      ]);

      path     = adv.path || '/';
      secure   = adv.secure;
      httpOnly = adv.httpOnly;
      sameSite = adv.sameSite as 'Strict' | 'Lax' | 'None';
      const days = parseInt(adv.expiryDays, 10);
      expires  = days === -1 ? -1 : Math.floor(Date.now() / 1000) + days * 86_400;
    }

    added.push({ name: name.trim(), value: value.trim(), path, secure, httpOnly, sameSite, expires });
    disp.success(`Queued "${name.trim()}" — continue adding or leave blank to save`);
  }

  if (added.length > 0) {
    upsertCookies(domain, added);
    disp.success(`Saved ${added.length} cookie(s) for ${chalk.cyan(domain)}`);
  } else {
    disp.dim('No cookies added.');
  }
}

// ── Paste raw Cookie: header string ──────────────────────────────────────────
async function pasteHeaderFlow(domain: string): Promise<void> {
  disp.info('Paste the value of the Cookie: request header from your browser.');
  disp.dim ('Example:  session=abc123; theme=dark; _ga=GA1.2.0.000');
  disp.dim ('Tip: open DevTools → Network tab → any request → Headers → Cookie');
  console.log('');

  const { raw } = await prompt<{ raw: string }>({
    type   : 'input',
    name   : 'raw',
    message: 'Paste Cookie: header value:',
    validate: (v: string) => v.trim().includes('=') || 'Doesn\'t look like a valid Cookie header',
  });

  const parsed = parseCookieHeader(raw.trim(), domain);
  if (parsed.length === 0) {
    disp.warn('Could not parse any cookies from that string.');
    return;
  }

  disp.info(`Parsed ${parsed.length} cookie(s):`);
  parsed.forEach(c => {
    console.log(`  ${chalk.cyan(c.name)} = ${chalk.dim(truncate(c.value, 60))}`);
  });
  console.log('');

  const { confirmed } = await prompt<{ confirmed: boolean }>({
    type   : 'confirm',
    name   : 'confirmed',
    message: `Save these ${parsed.length} cookie(s) for ${chalk.cyan(domain)}?`,
    initial: true,
  });

  if (confirmed) {
    upsertCookies(domain, parsed);
    disp.success(`Saved ${parsed.length} cookie(s) for ${chalk.cyan(domain)}`);
  }
}
