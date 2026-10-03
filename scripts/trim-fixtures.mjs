// Trim recorded API responses to the fields the engine reads, so committed fixtures stay small.
// Usage: node scripts/trim-fixtures.mjs <recordedDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: trim-fixtures.mjs <recordedDir> <outDir>');
fs.mkdirSync(out, { recursive: true });

const pick = (o, keys) => (o == null ? o : Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]])));

function trimEspn(body) {
  return {
    events: (body.events ?? []).map((e) => ({
      id: e.id, date: e.date, season: pick(e.season, ['year', 'type']), week: e.week,
      status: { type: pick(e.status?.type, ['name', 'state', 'completed']) },
      competitions: (e.competitions ?? []).slice(0, 1).map((c) => ({
        competitors: c.competitors.map((x) => ({ homeAway: x.homeAway, team: pick(x.team, ['abbreviation', 'displayName', 'shortDisplayName']) })),
      })),
    })),
  };
}

function trimYouTube(url, body) {
  if (url.includes('/playlistItems')) {
    return { nextPageToken: body.nextPageToken, items: body.items.map((i) => ({ snippet: pick(i.snippet, ['title', 'channelId']), contentDetails: pick(i.contentDetails, ['videoId', 'videoPublishedAt']) })) };
  }
  if (url.includes('/videos')) {
    return { items: body.items.map((v) => ({ id: v.id, snippet: pick(v.snippet, ['title', 'channelId', 'publishedAt', 'liveBroadcastContent']), contentDetails: pick(v.contentDetails, ['duration', 'regionRestriction', 'contentRating']), status: pick(v.status, ['embeddable', 'privacyStatus', 'uploadStatus']) })) };
  }
  if (url.includes('/channels')) return { items: body.items.map((c) => ({ id: c.id, contentDetails: { relatedPlaylists: { uploads: c.contentDetails.relatedPlaylists.uploads } } })) };
  return body;
}

for (const f of fs.readdirSync(src)) {
  const rec = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
  if (/[?&]key=/.test(rec.url)) throw new Error(`Secret in fixture URL: ${f}`);
  const body = rec.status !== 200 ? rec.body : rec.url.includes('espn.com') ? trimEspn(rec.body) : trimYouTube(rec.url, rec.body);
  fs.writeFileSync(path.join(out, f), JSON.stringify({ url: rec.url, status: rec.status, body }) + '\n');
}
console.log(`trimmed ${fs.readdirSync(src).length} fixture(s) → ${out}`);
