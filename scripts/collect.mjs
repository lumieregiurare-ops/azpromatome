// アズプロの情報を集めて data/ に貯め、画像をサーバーに置き、docs/ のページを作り直す。
//   node scripts/collect.mjs              いつもの収集（Google ニュースは直近 3 日）
//   node scripts/collect.mjs --backfill   初回用。Google ニュースを 90 日さかのぼる
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson, writeJson, idOf, hostOf, log, truncate } from "./lib/util.mjs";
import { fetchYouTube, fetchAppStore, fetchNews } from "./lib/sources.mjs";
import { enrichImages } from "./lib/enrich.mjs";
import { buildTopics } from "./lib/cluster.mjs";
import { updateArchive, loadArchive } from "./lib/archive.mjs";
import { syncImages } from "./lib/imgcache.mjs";
import { loadHostGuard } from "./lib/hostguard.mjs";
import { renderPages } from "./lib/pages.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const D = (f) => join(ROOT, "data", f);
const backfill = process.argv.includes("--backfill");

const started = Date.now();
const config = await readJson(join(ROOT, "config.json"));
const content = await readJson(join(ROOT, "content.json"), {});
const now = new Date();
const nowIso = now.toISOString();
const jstDayStr = (d) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);

const WATCHDOG_MIN = config.watchdogMinutes ?? 15;
setTimeout(() => {
  console.error(`[watchdog] ${WATCHDOG_MIN} 分を超えたため中断します`);
  process.exit(2);
}, WATCHDOG_MIN * 60 * 1000).unref();

const re = (list) => (list || []).map((k) => new RegExp(k, "i"));
const mainRe = re(config.keywords?.main);
const seriesRe = re(config.keywords?.series);
const blockRe = re(config.blockTitlePatterns);
const blockSourceRe = re(config.blockSources);
const cats = (config.categories || []).map((c) => ({ id: c.id, re: re(c.keywords) }));
const fallback = config.fallbackCategory || { id: "news", label: "ニュース" };
const guideHosts = new Set(config.guideHosts || []);
// カタカナだけの名前は、前後がカタカナでないときだけ当てる（「シャル」が「スペシャル」「シャルル村」に当たらないように）
const kanaOnly = /^[ァ-ヴー]+$/;
const charas = (content.characters || []).map((c) => ({
  id: c.id,
  re: (c.keywords || []).map((k) => new RegExp(kanaOnly.test(k) ? `(?<![ァ-ヴー])${k}(?![ァ-ヴー])` : k, "i")),
}));
const repostHosts = config.repostHosts || [];
const isRepost = (host) => repostHosts.some((h) => host === h || host.endsWith("." + h));

function categorize(text, host) {
  const out = [];
  if (guideHosts.has(host)) out.push("guide");
  for (const c of cats) if (c.re.some((r) => r.test(text)) && !out.includes(c.id)) out.push(c.id);
  return out.length ? out.slice(0, 2) : [fallback.id];
}
const charasOf = (text) => charas.filter((c) => c.re.some((r) => r.test(text))).map((c) => c.id);

// 重複判定用に見出しを正規化する（全角英数を半角に、空白と末尾の媒体名を落とす）
function normTitle(t) {
  return t
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（(][^（()）]{2,12}[)）]\s*$/, "")
    .replace(/^画像ギャラリー\s*No\.\d+\s*\|\s*/i, "")
    .replace(/[\s　]+/g, "")
    .toLowerCase()
    .slice(0, 40);
}

const stats = {};
// 取得を断ってきたサイトの記録（記事ページ・画像の両方で使う）
const guard = await loadHostGuard(ROOT);

// ---------- 1. 公式 YouTube ----------
const videosPrev = (await readJson(D("videos.json"), [])) || [];
let videos = videosPrev;
try {
  const map = new Map(videosPrev.map((v) => [v.id, v]));
  const got = await fetchYouTube(config.youtube.channelId);
  for (const v of got) {
    const old = map.get(v.id);
    // 再生数は収集のたびに変わる。日ごとの値を残して「伸び」を出せるようにする
    const viewsLog = [...(old?.viewsLog || [])];
    const day = jstDayStr(now);
    if (!viewsLog.length || viewsLog[viewsLog.length - 1][0] !== day) viewsLog.push([day, v.views]);
    else viewsLog[viewsLog.length - 1][1] = v.views;
    map.set(v.id, { ...old, ...v, viewsLog: viewsLog.slice(-14) });
  }
  for (const v of map.values()) v.charas = charasOf(v.title);
  videos = [...map.values()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  stats["YouTube"] = got.length;
} catch (e) {
  log("YouTube の取得に失敗:", e.message);
  stats["YouTube"] = "error";
}
await writeJson(D("videos.json"), videos);

// ---------- 2. App Store ----------
const store = (await readJson(D("store.json"), { current: null, history: [], ratings: [] })) || { history: [], ratings: [] };
try {
  const cur = await fetchAppStore(config.store.appStoreId);
  if (cur) {
    store.current = { ...cur, checkedAt: nowIso };
    store.history ||= [];
    if (!store.history.some((h) => h.version === cur.version)) {
      store.history.unshift({ version: cur.version, date: cur.versionDate, notes: truncate(cur.notes, 600), seenAt: nowIso });
    }
    const day = jstDayStr(now);
    store.ratings = (store.ratings || []).filter((r) => r[0] !== day);
    store.ratings.push([day, cur.rating, cur.ratingCount]);
    store.ratings = store.ratings.slice(-120);
  }
  stats["App Store"] = cur ? 1 : 0;
} catch (e) {
  log("App Store の取得に失敗:", e.message);
  stats["App Store"] = "error";
}
await writeJson(D("store.json"), store);

// ---------- 3. ニュース ----------
if (backfill) config.googleNews.within = "90d";
const { items: raw, stats: newsStats } = await fetchNews(config);
Object.assign(stats, newsStats);
log(`fetched ${raw.length} news items`);

const maxAge = (backfill ? 120 : config.maxArticleAgeDays ?? 14) * 86400000;
const byId = new Map();
const dropped = { offTopic: 0, tooOld: 0, dup: 0, blocked: 0 };

for (const r of raw) {
  if (!r.title || !/^https?:\/\//.test(r.url || "")) continue;
  // 「見出し - https://example.com/」の形で来る媒体がある
  r.title = r.title.replace(/\s+-\s+https?:\/\/\S+$/, "");
  if (/^https?:\/\//.test(r.source || "")) r.source = hostOf(r.source);
  if (r.publishedAt && now - new Date(r.publishedAt) > maxAge) {
    dropped.tooOld++;
    continue;
  }
  const host = r.sourceHost || hostOf(r.url);
  if (blockRe.some((x) => x.test(r.title)) || blockSourceRe.some((x) => x.test(r.source || ""))) {
    dropped.blocked++;
    continue;
  }
  // アズプロかどうかは見出しで決める。要約には関連作の名前が並ぶことがあるため
  const scope = mainRe.some((x) => x.test(r.title)) ? "main" : seriesRe.some((x) => x.test(r.title)) ? "series" : "";
  if (!scope) {
    dropped.offTopic++;
    continue;
  }
  const norm = normTitle(r.title);
  const id = idOf(`t:${norm}`);
  const prev = byId.get(id);
  if (prev) {
    dropped.dup++;
    // Yahoo!ニュースの転載より元の媒体を優先する
    if ((prev.viaGoogle && !r.viaGoogle) || (/news\.yahoo/.test(prev.host) && !/news\.yahoo/.test(host))) Object.assign(prev, { url: r.url, viaGoogle: !!r.viaGoogle, host, source: r.source });
    if (!prev.image && r.image) prev.image = r.image;
    continue;
  }
  byId.set(id, {
    id,
    title: truncate(r.title, 120),
    url: r.url,
    host,
    source: r.source,
    summary: r.summary || "",
    publishedAt: r.publishedAt || nowIso,
    image: r.image || "",
    scope,
    categories: categorize(r.title, host),
    charas: scope === "main" ? charasOf(r.title) : [],
    viaGoogle: !!r.viaGoogle,
  });
}

// Yahoo!ニュースなどの転載は、見出しの末尾に「（媒体名）」が付いたり後半が削られたりして完全には一致しない。
// 見出しの先頭 24 文字が同じ記事がほかにあれば、転載のほうを捨てる（両方が転載なら最初の 1 本だけ残す）
{
  const head = (t) => normTitle(t).slice(0, 24);
  const groups = new Map();
  for (const it of byId.values()) {
    const k = head(it.title);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const list of groups.values()) {
    if (list.length < 2 || !list.some((it) => isRepost(it.host))) continue;
    const keep = list.find((it) => !isRepost(it.host)) || list[0];
    for (const it of list) {
      if (it === keep || !isRepost(it.host)) continue;
      if (!keep.image && it.image) keep.image = it.image;
      byId.delete(it.id);
      dropped.dup++;
    }
  }
}

const items = [...byId.values()].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
log(`kept ${items.length} (対象外 ${dropped.offTopic} / 古い ${dropped.tooOld} / 除外 ${dropped.blocked} / 重複 ${dropped.dup})`);

// 前回までに画像・元記事の URL を取れた記事は、アーカイブの値を使って取りに行かない
const archivePrev = new Map();
for (const d of (await loadArchive(D("archive"))).slice(0, 30)) for (const it of d.items) archivePrev.set(it.id, it);
for (const it of items) {
  const old = archivePrev.get(it.id);
  if (!old) continue;
  if (!it.image && old.image) it.image = old.image;
  if (it.viaGoogle && old.url && !/news\.google\.com/.test(old.url)) {
    it.url = old.url;
    it.host = hostOf(old.url);
    it.viaGoogle = false;
  }
}
try {
  log(`og:image found: ${await enrichImages(items, { limit: backfill ? 200 : 60, concurrency: 4, guard })}`);
} catch (e) {
  log("画像の補完に失敗:", e.message);
}

// ---------- 4. 同じ出来事をまとめる ----------
let topics = [];
if (config.cluster?.enabled !== false) {
  topics = buildTopics(items.filter((i) => i.scope === "main"), config.cluster, config.entities || []);
  log(`topics: ${topics.length}`);
}

// ---------- 5. 新着の判定と更新間隔 ----------
const prev = (await readJson(D("state.json"), { ranAt: "", ids: [] })) || { ids: [] };
const prevIds = new Set(prev.ids || []);
for (const it of items) it.isNew = prevIds.size > 0 && !prevIds.has(it.id);
const runs = [...(prev.runs || []), nowIso].slice(-24);
function medianGapMin(list) {
  const ts = list.map((t) => new Date(t).getTime()).filter(Boolean).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 60000);
  if (!gaps.length) return null;
  const recent = gaps.slice(-6).sort((a, b) => a - b);
  return Math.round(recent[Math.floor((recent.length - 1) / 2)]);
}
const updateGapMin = medianGapMin(runs);

await writeJson(join(ROOT, "docs", "data", "news.json"), { updatedAt: nowIso, updateGapMin, topics, items });
await writeJson(D("state.json"), { ranAt: nowIso, runs, ids: items.map((i) => i.id) });

// ---------- 6. 過去の記事を貯める ----------
let archived = [];
try {
  const n = await updateArchive(D("archive"), items);
  log(`archive: ${n} day files updated`);
  archived = (await loadArchive(D("archive"))).flatMap((d) => d.items);
} catch (e) {
  log("アーカイブの更新に失敗:", e.stack || e.message);
}

// ---------- 7. 画像をサーバーに置く ----------
// ページに出す画像をここで全部挙げて、まだ置いていないものだけ取りに行く。
// 記事は新しいものから順に並べるので、1 回で取り切れなくても新しい記事の画像から埋まっていく。
const wants = [];
const base = content.charaImageBase || "";
for (const c of content.characters || []) {
  if (c.avatar) wants.push({ url: base + c.avatar, preset: "icon" });
  if (c.art) wants.push({ url: base + c.art, preset: "art" }, { url: base + c.art, preset: "og" });
}
for (const v of videos.slice(0, 60)) {
  wants.push({ url: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`, preset: "wide", alts: [`https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`] });
}
const cur = store.current;
if (cur?.icon) wants.push({ url: cur.icon, preset: "icon" });
for (const s of cur?.screenshots || []) wants.push({ url: s, preset: "shot" });
const newsSorted = archived.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
for (const n of newsSorted.slice(0, 400)) if (n.image) wants.push({ url: n.image, preset: "thumb" });
try {
  const r = await syncImages(ROOT, wants, { ...config.images, maxNewPerRun: backfill ? 300 : config.images?.maxNewPerRun, guard });
  log(`images: 新しく置いた ${r.fetched} / 失敗 ${r.failed} / 次回に回した ${r.pending} / 消した ${r.pruned}`);
  stats["画像"] = r;
} catch (e) {
  log("画像の取得に失敗:", e.stack || e.message);
}

await guard.save();
if (guard.list().length) log(`取得を控えているサイト: ${guard.list().join(", ")}`);

// ---------- 8. ページを作り直す ----------
try {
  await renderPages(ROOT, { log });
} catch (e) {
  log("ページの生成に失敗:", e.stack || e.message);
}

const summary = { ranAt: nowIso, durationSec: Math.round((Date.now() - started) / 1000), kept: items.length, topics: topics.length, dropped, sources: stats };
await writeJson(D("last-run.json"), summary);
log(`done in ${summary.durationSec}s`);
