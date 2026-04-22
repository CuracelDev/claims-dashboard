import fs from 'fs';

const ADMINER_URL = process.env.ADMINER_URL || 'https://db.crl.to';
const ADMINER_SERVER = process.env.ADMINER_SERVER || '10.189.80.3';
const ADMINER_DRIVER = process.env.ADMINER_DRIVER || 'pgsql';
const ADMINER_USER = process.env.ADMINER_USER;
const ADMINER_PASSWORD = process.env.ADMINER_PASSWORD;
const ADMINER_DB = process.env.ADMINER_DB || 'claims_dashboard_db';

function loadLocalEnv() {
  if (!fs.existsSync('.env.local')) return;
  const lines = fs.readFileSync('.env.local', 'utf8').split(/\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

function requireEnv(name, value) {
  if (!value) throw new Error(`${name} is required`);
}

function updateCookies(cookies, res) {
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const eq = pair.indexOf('=');
    if (eq > -1) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
}

async function adminerRequest(cookies, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookie = cookieHeader(cookies);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  updateCookies(cookies, res);
  return res;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function adminerLogin(cookies) {
  await adminerRequest(cookies, ADMINER_URL);

  const body = new URLSearchParams();
  body.set('auth[driver]', ADMINER_DRIVER);
  body.set('auth[server]', ADMINER_SERVER);
  body.set('auth[username]', ADMINER_USER);
  body.set('auth[password]', ADMINER_PASSWORD);
  body.set('auth[db]', ADMINER_DB);

  const res = await adminerRequest(cookies, ADMINER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  let html = await res.text();
  let current = res;
  for (let i = 0; current.status >= 300 && current.status < 400 && i < 5; i += 1) {
    const location = current.headers.get('location') || ADMINER_URL;
    current = await adminerRequest(cookies, new URL(location, ADMINER_URL).toString());
    html = await current.text();
  }

  if (!html.includes('Schema: public') && !html.includes('SQL command')) {
    throw new Error(`Adminer login did not reach the database page. Status: ${current.status}. ${stripHtml(html).slice(0, 500)}`);
  }
}

function sqlUrl() {
  const query = new URLSearchParams({
    [ADMINER_DRIVER]: ADMINER_SERVER,
    username: ADMINER_USER,
    db: ADMINER_DB,
    ns: 'public',
    sql: '',
  });
  return `${ADMINER_URL}/?${query.toString()}`;
}

async function getSqlToken(cookies) {
  const res = await adminerRequest(cookies, sqlUrl());
  const html = await res.text();
  const match = html.match(/<form action="" method="post" enctype="multipart\/form-data" id="form">[\s\S]*?name='token' value='([^']+)'/);
  if (!match) throw new Error('Could not find Adminer SQL token');
  return match[1];
}

async function execSql(cookies, sql) {
  const token = await getSqlToken(cookies);
  const body = new URLSearchParams();
  body.set('query', sql);
  body.set('limit', '100');
  body.set('token', token);

  const res = await adminerRequest(cookies, sqlUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const html = await res.text();
  if (html.includes("<p class='error'>")) {
    throw new Error(`Adminer SQL failed: ${stripHtml(html).slice(0, 1200)}`);
  }
}

loadLocalEnv();
requireEnv('ADMINER_USER', ADMINER_USER);
requireEnv('ADMINER_PASSWORD', ADMINER_PASSWORD);

const cookies = new Map();
const sql = fs.readFileSync('scripts/prism-chat-schema.sql', 'utf8');

console.log('Logging in to Adminer...');
await adminerLogin(cookies);
console.log('Applying Prism chat schema...');
await execSql(cookies, sql);
console.log('Prism chat schema applied through Adminer.');
