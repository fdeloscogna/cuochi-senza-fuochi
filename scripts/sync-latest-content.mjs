#!/usr/bin/env node
/**
 * Builds data/latest-content.json from the public social feeds.
 *
 * Run by .github/workflows/sync-latest-content.yml on a schedule, and locally
 * with `node scripts/sync-latest-content.mjs`. No dependencies and no API keys:
 * YouTube publishes a public RSS feed per channel, which needs neither.
 *
 * Writes the file twice on purpose:
 *   data/latest-content.json        the source copy, which Quarto treats as a
 *                                   project resource and copies on render
 *   docs/data/latest-content.json   the copy actually served, so the workflow
 *                                   never has to run Quarto just to publish data
 *
 * Instagram and TikTok have no equivalent public feed. Items for those
 * platforms are read from data/manual-content.json if that file exists, so the
 * page can carry them without this script needing credentials. See the notes at
 * the bottom of this file.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const YOUTUBE_HANDLE = 'cuochisenzafuochi';
/* Channel ids are permanent. The handle is resolved at run time anyway so that
   renaming the channel does not silently empty the page, but this is the
   fallback if the resolve step is ever blocked. */
const YOUTUBE_CHANNEL_ID_FALLBACK = 'UCiVakwKVTyv72K-1NVYQXCg';

const MAX_ITEMS = 12;

/* youtube.com serves an interstitial consent page to normal browser user agents
   from the EU, which contains no channel id. The crawler user agent gets the
   real page. The RSS endpoint itself is not gated at all. */
const CRAWLER_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function resolveChannelId(handle) {
  try {
    const html = await get(`https://www.youtube.com/@${handle}`, {
      'User-Agent': CRAWLER_UA,
      'Accept-Language': 'en',
    });
    const m =
      html.match(/"(?:externalId|channelId)"\s*:\s*"(UC[\w-]{22})"/) ||
      html.match(/UC[A-Za-z0-9_-]{22}/);
    if (m) return m[1] || m[0];
    console.warn('could not resolve channel id from the handle page');
  } catch (err) {
    console.warn(`resolving the handle failed: ${err.message}`);
  }
  return YOUTUBE_CHANNEL_ID_FALLBACK;
}

/* Small helpers rather than an XML dependency. The YouTube feed shape is stable
   and simple: a flat list of <entry> elements. */
const between = (text, open, close) => {
  const out = [];
  let i = 0;
  for (;;) {
    const s = text.indexOf(open, i);
    if (s === -1) break;
    const e = text.indexOf(close, s);
    if (e === -1) break;
    out.push(text.slice(s + open.length, e));
    i = e + close.length;
  }
  return out;
};

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
};

const attr = (xml, name, key) => {
  const m = xml.match(new RegExp(`<${name}[^>]*\\b${key}="([^"]*)"`));
  return m ? m[1] : '';
};

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

async function youtubeItems() {
  const channelId = await resolveChannelId(YOUTUBE_HANDLE);
  const xml = await get(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
  );

  return between(xml, '<entry>', '</entry>').map((entry) => {
    const id = decodeEntities(tag(entry, 'yt:videoId'));
    return {
      platform: 'youtube',
      id,
      title: decodeEntities(tag(entry, 'title')),
      url: attr(entry, 'link', 'href') || `https://www.youtube.com/watch?v=${id}`,
      /* hqdefault exists for every video; maxres does not */
      thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      published: decodeEntities(tag(entry, 'published')),
    };
  });
}

/* Items added by hand (or by any other tool) for the platforms without a public
   feed. Missing or malformed file is not an error: the page just shows fewer
   items rather than breaking. */
async function manualItems() {
  const path = join(ROOT, 'data', 'manual-content.json');
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const items = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(items)) return [];
    return items.filter((it) => it && it.url && it.platform);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`ignoring data/manual-content.json: ${err.message}`);
    }
    return [];
  }
}

async function main() {
  const collected = [];

  /* One failing platform must not empty the whole page, so each source is
     settled independently and its failure only drops its own items. */
  const sources = await Promise.allSettled([youtubeItems(), manualItems()]);
  for (const [i, result] of sources.entries()) {
    const name = ['youtube', 'manual'][i];
    if (result.status === 'fulfilled') {
      console.log(`${name}: ${result.value.length} items`);
      collected.push(...result.value);
    } else {
      console.error(`${name} failed: ${result.reason.message}`);
    }
  }

  if (collected.length === 0) {
    /* Refusing to write an empty file means a transient outage leaves the last
       good data in place instead of blanking the page. */
    console.error('no items from any source, leaving the existing file alone');
    process.exit(1);
  }

  const items = collected
    .filter((it) => it.url)
    .sort((a, b) => String(b.published).localeCompare(String(a.published)))
    .slice(0, MAX_ITEMS);

  const payload = { generated: new Date().toISOString(), items };
  const json = JSON.stringify(payload, null, 2) + '\n';

  for (const rel of [
    join('data', 'latest-content.json'),
    join('docs', 'data', 'latest-content.json'),
  ]) {
    const out = join(ROOT, rel);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, json, 'utf8');
    console.log(`wrote ${rel}`);
  }

  console.log(`${items.length} items, newest: ${items[0]?.title ?? 'none'}`);
}

await main();

/* ---------------------------------------------------------------------------
   Why YouTube only, automatically

   YouTube  public RSS per channel, no key, no account, no expiry. Fully
            automatic and what this script uses.

   Instagram  has no public feed. The Basic Display API that used to cover this
            was shut down by Meta. The remaining route is the Instagram Graph
            API, which needs a Business or Creator account linked to a Facebook
            Page, an app, and a long lived token that expires every 60 days and
            has to be refreshed. That token would live in repository secrets.

   TikTok   likewise has no public feed. Its Display API needs an approved app
            and an OAuth flow per user, with refresh tokens.

   Until one of those is set up, add Instagram and TikTok posts to
   data/manual-content.json in this shape and they appear alongside the videos:

   { "items": [
       { "platform": "instagram",
         "title": "Salame di cioccolato, four ingredients",
         "url": "https://www.instagram.com/p/XXXXXXXXX/",
         "thumbnail": "images/content/salame.jpg",
         "published": "2026-07-20T18:00:00Z" }
   ] }
   --------------------------------------------------------------------------- */
