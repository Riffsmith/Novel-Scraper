import winston from 'winston';
import chalk   from 'chalk';
import path    from 'path';
import fs      from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir   = path.join(process.cwd(), 'logs');

if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ── Level → colour mapping ──────────────────────────────────────────────────
const LEVEL_STYLES: Record<string, (s: string) => string> = {
  error:   (s) => chalk.bold.red(s),
  warn:    (s) => chalk.bold.yellow(s),
  info:    (s) => chalk.cyan(s),
  verbose: (s) => chalk.magenta(s),
  debug:   (s) => chalk.gray(s),
  silly:   (s) => chalk.white(s),
};

// ── Pretty console format ───────────────────────────────────────────────────
const consoleFormat = winston.format.printf(({ level, message, timestamp, ...meta }: {
  level: string; message: unknown; timestamp: unknown; [k: string]: unknown;
}) => {
  const colorFn = LEVEL_STYLES[level] ?? ((s: string) => s);
  const ts      = chalk.dim(String(timestamp));
  const lvl     = colorFn(`[${level.toUpperCase().padEnd(7)}]`);
  const msg     = typeof message === 'string' ? message : JSON.stringify(message);
  const extra   = Object.keys(meta).length
    ? chalk.dim(' ' + JSON.stringify(meta))
    : '';
  return `${ts} ${lvl} ${msg}${extra}`;
});

// ── JSON format for files ──────────────────────────────────────────────────
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// ── Logger instance ────────────────────────────────────────────────────────
export const logger = winston.createLogger({
  level: (process as NodeJS.Process).env['LOG_LEVEL'] ?? 'info',

  transports: [
    // Pretty console (suppressed in TUI-heavy flows by LOG_LEVEL=warn)
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        consoleFormat,
      ),
    }),

    // Rotating file – errors only
    new winston.transports.File({
      filename : path.join(logsDir, 'error.log'),
      level    : 'error',
      format   : fileFormat,
      maxsize  : 5_242_880,   // 5 MB
      maxFiles : 3,
    }),

    // Rotating file – everything
    new winston.transports.File({
      filename : path.join(logsDir, 'combined.log'),
      format   : fileFormat,
      maxsize  : 10_485_760,  // 10 MB
      maxFiles : 5,
    }),
  ],

  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
    }),
  ],

  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log'),
    }),
  ],
});

export default logger;
