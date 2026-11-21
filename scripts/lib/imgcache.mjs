// 外部の画像（記事の og:image・YouTube のサムネイル・App Store のスクリーンショット・公式サイトのキャラクター画像）は
// 収集のときに 1 回だけ取りに行き、縮小した WebP を docs/img/ に置く。ページはこのコピーだけを指すので、
// 閲覧者のブラウザが相手のサーバーへ画像を読みに行くことはない（直リンクしない）。
//
// 相手のサーバーに負担をかけないための決まり
//  - 一度取れた画像は二度と取りに行かない（data/images.json に「元の URL → 置いたファイル」を記録する）
//  - 同じホストへは 1 枚ずつ順番に、hostGapMs あけて取りに行く。並べて走らせるのは別々のホストだけ
//  - 1 回の収集で新しく取りに行くのは maxNewPerRun 枚まで。残りは次の収集に回す
//  - 失敗した画像は 6 時間 → 1 日 → 3 日あけて取り直し、4 回失敗したらあきらめる
//  - 画像でない応答・maxBytes を超える画像は捨てる
//  - pruneDays 日どのページからも使われなかった画像は消す（リポジトリが膨らまないように）
//
// 収集（collect.mjs）だけが取りに行く。ページを作る側（pages.mjs）は記録を読むだけで、
// 記録に無い画像は「画像なし」の札にする。
import { createHash } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { readJson, writeJson, hostOf, UA, log } from "./util.mjs";

// 表示する大きさの 2 倍くらいを上限にする。crop は元画像に対する割合 [左, 上, 幅, 高さ]
export const PRESETS = {
  thumb: { w: 480, h: 480, q: 70 }, // 記事のサムネイル（一覧の表示は最大 240px 前後）
  wide: { w: 800, h: 450, q: 72 }, // 大きく出す動画・記事
  shot: { w: 360, h: 640, q: 72 }, // ストアのスクリーンショット
  icon: { w: 160, h: 160, q: 80 }, // キャラクターの顔アイコン（透過のまま）
  art: { w: 600, h: 720, q: 78, crop: "figure" }, // キャラクターの立ち絵（人物のまわりだけ切り出す）
  // SNS で共有されたときのカード。WebP を表示できないアプリがあるので JPEG にする
  og: { w: 1200, h: 630, q: 80, crop: "figure", fit: "cover", position: "north", format: "jpeg" },
};

// 公式サイトの立ち絵は 2 種類ある。縦長（1500x3000）は上の半分に人物がいて、
// 正方形（3000x3000）は真ん中から上の 2/3 に人物がいる。どちらも下のほうは白くぼかしてある
function figureBox(w, h) {
  if (h >= w * 1.5) return { left: 0, top: Math.round(h * 0.04), width: w, height: Math.round(Math.min(h * 0.5, w * 1.2)) };
  const height = Math.round(h * 0.68);
  const width = Math.min(w, Math.round(height * 0.9));
  return { left: Math.round((w - width) / 2), top: Math.round(h * 0.03), width, height };
}

const RETRY_HOURS = [6, 24, 72];
const MAX_FAILS = 4;

const keyOf = (url, preset) => `${preset}|${url}`;
const fileOf = (url, preset) => {
  const h = createHash("sha1").update(keyOf(url, preset)).digest("hex").slice(0, 16);
  return `img/${h.slice(0, 2)}/${h}.${PRESETS[preset]?.format === "jpeg" ? "jpg" : "webp"}`;
};

export async function loadImageIndex(root) {
  const path = join(root, "data", "images.json");
  const index = (await readJson(path, {})) || {};
  return {
    path,
    index,
    // ページから使う。置いてあれば { src, w, h }、無ければ null
    get(url, preset = "thumb") {
      if (!url) return null;
      const e = index[keyOf(url, preset)];
      return e && e.f ? { src: "/" + e.f, w: e.w, h: e.h } : null;
    },
  };
}

async function fetchImage(url, { timeoutMs, maxBytes }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" },
      signal: ac.signal,
      redirect: "follow",
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const type = r.headers.get("content-type") || "";
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) throw new Error(`not image (${type})`);
    const len = Number(r.headers.get("content-length") || 0);
    if (len > maxBytes) throw new Error(`too large (${len})`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`too large (${buf.length})`);
    return buf;
  } finally {
    clearTimeout(t);
  }
}

async function convert(sharp, buf, preset) {
  const p = PRESETS[preset] || PRESETS.thumb;
  let img = sharp(buf, { failOn: "none", animated: false }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("unreadable");
  // YouTube は動画が無いと 120x90 の灰色の画像を返す。そういう小さすぎる画像は使わない
  if (meta.width <= 120 && meta.height <= 90) throw new Error("placeholder");
  if (p.crop === "figure") {
    img = sharp(buf, { failOn: "none" }).rotate().extract(figureBox(meta.width, meta.height));
  } else if (Array.isArray(p.crop)) {
    const [x, y, w, h] = p.crop;
    img = sharp(buf, { failOn: "none" })
      .rotate()
      .extract({ left: Math.round(meta.width * x), top: Math.round(meta.height * y), width: Math.round(meta.width * w), height: Math.round(meta.height * h) });
  }
  const fit = p.fit || "inside";
  img = img.resize({ width: p.w, height: p.h, fit, position: p.position || "centre", withoutEnlargement: fit === "inside" });
  img = p.format === "jpeg" ? img.flatten({ background: "#ffffff" }).jpeg({ quality: p.q, mozjpeg: true }) : img.webp({ quality: p.q, effort: 5 });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/**
 * wants: [{ url, preset, alts?: [url...] }]
 * alts は url が取れなかったときに代わりに取りに行く URL（YouTube の maxresdefault → hqdefault など）。
 * 取れた画像は url の名前で記録する。
 */
export async function syncImages(root, wants, opts = {}) {
  const cfg = { maxNewPerRun: 60, hostGapMs: 1500, hostParallel: 3, timeoutMs: 15000, maxBytes: 10000000, pruneDays: 45, budgetMs: 240000, ...opts };
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    log("sharp が無いので画像の取得を飛ばします（npm ci をしてください）");
    return { fetched: 0, failed: 0, pending: 0, pruned: 0 };
  }
  const DOCS = join(root, "docs");
  const { path, index } = await loadImageIndex(root);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // 今回のページで使う画像に印を付ける（消す判定に使う）
  const seen = new Set();
  const todo = [];
  for (const w of wants) {
    if (!w?.url || !/^https?:\/\//.test(w.url)) continue;
    const preset = w.preset || "thumb";
    const k = keyOf(w.url, preset);
    if (seen.has(k)) continue;
    seen.add(k);
    const e = (index[k] ||= {});
    e.used = nowIso;
    if (e.f) continue;
    if ((e.fails || 0) >= MAX_FAILS) continue;
    if (e.next && new Date(e.next).getTime() > now) continue;
    // 取得を断ってきたサイトの画像は、期限が過ぎるまで取りに行かない（失敗の回数にも数えない）
    if (cfg.guard?.blocked(hostOf(w.url))) continue;
    todo.push({ ...w, preset, k });
  }

  // 同じ画像から何種類もの大きさを作るときも、取りに行くのは 1 回だけにする
  const byUrl = new Map();
  for (const w of todo) {
    if (!byUrl.has(w.url)) byUrl.set(w.url, { url: w.url, alts: w.alts || [], outs: [] });
    byUrl.get(w.url).outs.push({ preset: w.preset, k: w.k });
  }
  const batch = [...byUrl.values()].slice(0, cfg.maxNewPerRun);
  const byHost = new Map();
  for (const w of batch) {
    const h = hostOf(w.url) || "?";
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(w);
  }

  let fetched = 0;
  let failed = 0;
  const started = Date.now();
  const hosts = [...byHost.entries()];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runHost([host, list]) {
    for (let i = 0; i < list.length; i++) {
      if (Date.now() - started > cfg.budgetMs) return;
      // このホストに途中で断られたら、残りは次の機会に回す
      if (cfg.guard?.blocked(host)) return;
      const w = list[i];
      let ok = false;
      let lastErr = "";
      for (const u of [w.url, ...w.alts]) {
        try {
          const buf = await fetchImage(u, cfg);
          for (const o of w.outs) {
            const out = await convert(sharp, buf, o.preset);
            const f = fileOf(w.url, o.preset);
            await mkdir(dirname(join(DOCS, f)), { recursive: true });
            await writeFile(join(DOCS, f), out.data);
            const e = index[o.k];
            Object.assign(e, { f, w: out.w, h: out.h, at: nowIso, bytes: out.data.length });
            delete e.fails;
            delete e.next;
            delete e.err;
          }
          ok = true;
          break;
        } catch (err) {
          lastErr = String(err.message || err).slice(0, 80);
          if (cfg.guard?.note(hostOf(u), err)) break;
        }
      }
      if (ok) fetched++;
      else {
        failed++;
        for (const o of w.outs) {
          const e = index[o.k];
          e.fails = (e.fails || 0) + 1;
          e.err = lastErr;
          const wait = RETRY_HOURS[Math.min(e.fails - 1, RETRY_HOURS.length - 1)];
          e.next = new Date(now + wait * 3600000).toISOString();
        }
      }
      if (i < list.length - 1) await sleep(cfg.hostGapMs);
    }
  }

  // 別々のホストだけを並べて走らせる
  let hi = 0;
  await Promise.all(
    Array.from({ length: Math.min(cfg.hostParallel, hosts.length) }, async () => {
      while (hi < hosts.length) await runHost(hosts[hi++]);
    })
  );

  // しばらく使われていない画像を消す
  let pruned = 0;
  const limit = now - cfg.pruneDays * 86400000;
  for (const [k, e] of Object.entries(index)) {
    if (e.used && new Date(e.used).getTime() < limit) {
      if (e.f) await unlink(join(DOCS, e.f)).catch(() => {});
      delete index[k];
      pruned++;
    }
  }

  await writeJson(path, index);
  return { fetched, failed, pending: Math.max(0, byUrl.size - fetched - failed), pruned };
}
