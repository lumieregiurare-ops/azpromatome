// アズプロの情報の集め先。
//  - 公式 YouTube チャンネルの RSS
//  - App Store の lookup API（評価・バージョン・更新内容・スクリーンショット）
//  - Google ニュースの検索フィード（ゲーム媒体の記事）
// 公式サイトにはお知らせの一覧が無い（お知らせは公式 X で出る）ので、公式サイトからは集めない。
// 記事本文は転載しない。見出し・冒頭の一部・元記事へのリンクだけを持つ。
import { fetchText, fetchJson, cleanUrl, hostOf, log, truncate } from "./util.mjs";
import { parseFeed, stripTags, decodeEntities, firstImage } from "./xml.mjs";

// ---------- 公式 YouTube ----------

export async function fetchYouTube(channelId) {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { timeoutMs: 20000 });
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((e) => {
    const g = (re) => decodeEntities((e.match(re) || [])[1] || "").trim();
    const id = g(/<yt:videoId>([^<]+)/);
    const link = (e.match(/<link rel="alternate" href="([^"]+)"/) || [])[1] || "";
    return {
      id,
      title: g(/<title>([^<]+)/),
      publishedAt: g(/<published>([^<]+)/),
      views: Number(g(/<media:statistics views="(\d+)"/)) || 0,
      desc: truncate(g(/<media:description>([\s\S]*?)<\/media:description>/), 200),
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      short: /\/shorts\//.test(link),
      url: `https://www.youtube.com/watch?v=${id}`,
    };
  });
}

// ---------- App Store ----------

export async function fetchAppStore(id) {
  const j = await fetchJson(`https://itunes.apple.com/lookup?id=${id}&country=jp`, { timeoutMs: 20000 });
  const r = j.results?.[0];
  if (!r) return null;
  return {
    name: r.trackName,
    version: r.version,
    versionDate: r.currentVersionReleaseDate,
    releaseDate: r.releaseDate,
    rating: r.averageUserRating || 0,
    ratingCount: r.userRatingCount || 0,
    size: r.fileSizeBytes ? Math.round(Number(r.fileSizeBytes) / 1048576) : 0,
    minOs: r.minimumOsVersion,
    notes: (r.releaseNotes || "").trim(),
    icon: r.artworkUrl512 || r.artworkUrl100 || "",
    screenshots: (r.screenshotUrls || []).slice(0, 10),
    advisory: r.trackContentRating || "",
  };
}

// ---------- Google ニュース ----------

// Google ニュースの見出しは「本文 - 媒体名」の形なので分ける
function splitGoogleTitle(title) {
  const m = title.match(/^(.*)\s[-–—]\s([^-–—]{2,30})$/);
  return m ? { title: m[1].trim(), source: m[2].trim() } : { title: title.trim(), source: "" };
}

export async function fetchGoogleNews(query, { within = "2d", perQuery = 40 } = {}) {
  const q = encodeURIComponent(within ? `${query} when:${within}` : query);
  const xml = await fetchText(`https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`, { timeoutMs: 20000 });
  const blocks = xml.split(/<item>/).slice(1, perQuery + 1);
  const out = [];
  for (const b of blocks) {
    const rawTitle = decodeEntities((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").trim();
    const link = decodeEntities((b.match(/<link>([^<]*)<\/link>/) || [])[1] || "").trim();
    const date = (b.match(/<pubDate>([^<]*)<\/pubDate>/) || [])[1] || "";
    const srcName = decodeEntities((b.match(/<source url="[^"]*">([^<]*)<\/source>/) || [])[1] || "").trim();
    const srcUrl = (b.match(/<source url="([^"]*)"/) || [])[1] || "";
    if (!rawTitle || !link) continue;
    const t = splitGoogleTitle(rawTitle);
    out.push({
      source: srcName || t.source || "Google ニュース",
      sourceHost: hostOf(srcUrl),
      title: t.title,
      url: link,
      summary: "",
      publishedAt: date ? new Date(date).toISOString() : null,
      image: "",
      viaGoogle: true,
    });
  }
  return out;
}

export async function fetchFeed(feed) {
  const xml = await fetchText(feed.url, { timeoutMs: 20000 });
  return parseFeed(xml).map((e) => ({
    source: feed.name,
    title: decodeEntities(e.title || "").trim(),
    url: cleanUrl(e.link || ""),
    summary: truncate(stripTags(e.description || e.content || ""), 160),
    publishedAt: e.date ? new Date(e.date).toISOString() : null,
    image: e.media || firstImage(e.content || e.description || ""),
  }));
}

export async function fetchNews(config) {
  const items = [];
  const stats = {};
  for (const feed of config.feeds || []) {
    try {
      const got = await fetchFeed(feed);
      items.push(...got);
      stats[feed.name] = got.length;
    } catch (e) {
      log(`feed failed ${feed.name}: ${e.message}`);
      stats[feed.name] = "error";
    }
  }
  const g = config.googleNews || {};
  if (g.enabled !== false) {
    let n = 0;
    for (const q of g.queries || []) {
      try {
        const got = await fetchGoogleNews(q, { within: g.within, perQuery: g.perQuery });
        items.push(...got);
        n += got.length;
      } catch (e) {
        log(`google news failed (${q}): ${e.message}`);
      }
    }
    stats["Google ニュース"] = n;
  }
  return { items, stats };
}
