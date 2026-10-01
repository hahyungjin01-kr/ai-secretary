import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RequestHandler } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const SECRET_PATH = path.join(DATA_DIR, 'api-secret.json');

const HEADER = 'x-traders-secret';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** .env TRADERS_API_SECRET 또는 data/api-secret.json (자동 생성) */
export function getApiSecret(): string {
  const fromEnv = process.env.TRADERS_API_SECRET?.trim();
  if (fromEnv) return fromEnv;

  ensureDataDir();
  if (fs.existsSync(SECRET_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(SECRET_PATH, 'utf8')) as { secret?: string };
      if (raw.secret && raw.secret.length >= 16) return raw.secret;
    } catch {
      // regenerate
    }
  }
  const secret = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(SECRET_PATH, JSON.stringify({ secret }, null, 2), 'utf8');
  console.log('[auth] generated TRADERS_API_SECRET → data/api-secret.json');
  return secret;
}

export function extractApiSecret(req: {
  header(name: string): string | undefined;
  query?: Record<string, unknown>;
}): string {
  const h = req.header(HEADER) || req.header('X-Traders-Secret') || '';
  if (h) return h.trim();
  const q = req.query?.secret;
  return typeof q === 'string' ? q.trim() : '';
}

export function requireApiSecret(): RequestHandler {
  const expected = getApiSecret();
  return (req, res, next) => {
    const got = extractApiSecret(req);
    if (!got || got !== expected) {
      res.status(401).json({
        error: 'API 시크릿이 필요합니다. 앱을 새로고침하거나 TRADERS_API_SECRET 을 확인하세요.',
      });
      return;
    }
    next();
  };
}

/** 빌드된 index.html 에 시크릿 주입 (개인 HTTPS 터널용) */
export function injectSecretIntoHtml(html: string): string {
  const secret = getApiSecret();
  const snippet = `<script>window.__TRADERS_API_SECRET__=${JSON.stringify(secret)};</script>`;
  if (html.includes('__TRADERS_API_SECRET__')) {
    return html.replace(
      /window\.__TRADERS_API_SECRET__\s*=\s*["'].*?["']\s*;?/,
      `window.__TRADERS_API_SECRET__=${JSON.stringify(secret)};`,
    );
  }
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}</head>`);
  return `${snippet}${html}`;
}

export const API_SECRET_HEADER = HEADER;
