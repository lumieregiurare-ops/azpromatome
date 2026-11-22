// docs/ の HTML をすべて作る。収集のたび（collect.mjs）とビルドのたび（build.mjs）に呼ばれる。
// 表示はすべてここで HTML に焼き込み、ブラウザ側の JS は動画の再生・コメント・最近の書き込みだけにする。
// 画像は imgcache.mjs がサーバーに置いたコピーだけを使う（外部の画像には直リンクしない）。
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { readJson } from "./util.mjs";
import { loadArchive, jstDay } from "./archive.mjs";
import { loadImageIndex } from "./imgcache.mjs";
import { buildTopics } from "./cluster.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const WD = "日月火水木金土";
const jst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000);
const pad = (n) => String(n).padStart(2, "0");
const md = (iso) => {
  const d = jst(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`;
};
const mdhm = (iso) => {
  const d = jst(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const ymd = (iso) => {
  const d = jst(iso);
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
};
const time = (iso, f = mdhm) => `<time datetime="${esc(iso)}">${f(iso)}</time>`;
const num = (n) => Number(n || 0).toLocaleString("ja-JP");
const ext = 'target="_blank" rel="noopener"';

export function minifyHtml(html) {
  return html
    .replace(/<!--(?!\[)[\s\S]*?-->/g, "")
    .replace(/\n\s+/g, "\n")
    .replace(/>\n</g, "><")
    .trim();
}

async function verOf(path) {
  try {
    return createHash("sha1").update(await readFile(path)).digest("hex").slice(0, 8);
  } catch {
    return "0";
  }
}

// 画像の無い記事の札。媒体名から色を決めて、一覧が同じ灰色だらけにならないようにする
const NOIMG_COLORS = ["#d9e8f7", "#f9e3c8", "#dcefd8", "#f3dbe6", "#e6e0f5", "#f7f0c6"];
function noimg(label, cls = "") {
  const h = [...String(label)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return `<span class="noimg ${cls}" style="background:${NOIMG_COLORS[h % NOIMG_COLORS.length]}"><span>${esc(String(label).slice(0, 14))}</span></span>`;
}

export async function renderPages(root, { log = console.log } = {}) {
  const DOCS = join(root, "docs");
  const config = await readJson(join(root, "config.json"));
  const content = await readJson(join(root, "content.json"), {});
  const site = config.site;
  const base = site.url.replace(/\/$/, "");
  const videos = (await readJson(join(root, "data", "videos.json"), [])) || [];
  const store = (await readJson(join(root, "data", "store.json"), {})) || {};
  const state = (await readJson(join(root, "docs", "data", "news.json"), {})) || {};
  const images = await loadImageIndex(root);
  const days = await loadArchive(join(root, "data", "archive"));
  const all = days.flatMap((d) => d.items).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const main = all.filter((i) => i.scope === "main");
  const series = all.filter((i) => i.scope === "series");
  const now = new Date();
  const updatedAt = state.updatedAt || now.toISOString();
  const catLabel = Object.fromEntries([...(config.categories || []), config.fallbackCategory].map((c) => [c.id, c.label]));
  const charas = content.characters || [];
  const charaById = Object.fromEntries(charas.map((c) => [c.id, c]));
  const imgBase = content.charaImageBase || "";
  const cur = store.current;
  // 複数の媒体が報じた話題。過去の記事すべてから作り、1 つずつページにする（URL はいちばん古い記事の id）
  const allTopics = buildTopics(main, { ...config.cluster, maxTopics: 9999 }, config.entities || []).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  const topicOfUrl = new Map();
  for (const t of allTopics) for (const m of t.members) topicOfUrl.set(m.url, t);
  const topicHref = (t) => {
    const hit = topicOfUrl.get(t.url) || (t.articles || []).map((a) => topicOfUrl.get(a.url)).find(Boolean);
    return hit ? `/topic/${hit.key}/` : "";
  };

  const ver = {
    css: await verOf(join(DOCS, "assets", "app.css")),
    js: await verOf(join(DOCS, "assets", "app.js")),
    comments: await verOf(join(DOCS, "assets", "comments.js")),
  };

  // 置いてある画像なら <img>、無ければ札
  function pic(url, preset, alt, { cls = "", eager = false, label = "" } = {}) {
    const e = images.get(url, preset);
    if (!e) return noimg(label || alt, cls);
    return `<img class="${cls}" src="${e.src}" width="${e.w}" height="${e.h}" alt="${esc(alt)}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">`;
  }
  const absImg = (url, preset) => {
    const e = images.get(url, preset);
    return e ? base + e.src : "";
  };
  const ytThumb = (v) => `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`;
  const avatarUrl = (c) => imgBase + c.avatar;
  const artUrl = (c) => imgBase + c.art;

  const pages = [];
  const put = (path, html, { index = true, priority = 0.5 } = {}) => pages.push({ path, html, index, priority });

  // ---------- リリースまでの日数 ----------
  const launchAt = new Date(site.launchAt);
  const dayMs = 86400000;
  const launchDay = jstDay(launchAt.toISOString());
  const today = jstDay(now.toISOString());
  const daysLeft = Math.round((new Date(launchDay) - new Date(today)) / dayMs);
  const launchLabel = daysLeft > 0 ? `正式リリースまで<b>あと${daysLeft}日</b>` : daysLeft === 0 ? `<b>本日リリース</b>` : `リリースから<b>${1 - daysLeft}日目</b>`;
  const launchDate = `${ymd(launchAt.toISOString())}（${WD[jst(launchAt.toISOString()).getUTCDay()]}）`;

  // ---------- 共通の部品 ----------
  const NAV = [
    ["/", "トップ"],
    ["/news/", "ニュース"],
    ["/topic/", "話題"],
    ["/videos/", "公式動画"],
    ["/chara/", "キャラクター"],
    ["/info/", "基本情報"],
    ["/bbs/", "掲示板"],
    ["/azurlane/", "アズレン・Manjuu"],
    ["/links/", "リンク"],
  ];

  function jsonLd(obj) {
    return `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
  }
  function crumbs(list) {
    // list: [[path, name], ...]（トップは自動で先頭に付く）
    const full = [["/", "トップ"], ...list];
    const html = `<nav class="crumb" aria-label="パンくずリスト">${full
      .map(([p, n], i) => (i === full.length - 1 ? `<span>${esc(n)}</span>` : `<a href="${p}">${esc(n)}</a>`))
      .join(" › ")}</nav>`;
    const ld = jsonLd({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: full.map(([p, n], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: base + p })),
    });
    return html + ld;
  }

  function layout({ path, title, desc, body, image = "", scripts = [], noindex = false, ld = [], type = "article" }) {
    const isTop = path === "/";
    const full = isTop ? `${site.title}｜アズールプロミリア（アズプロ）の最新情報まとめ` : `${title}｜${site.title}`;
    const url = base + path;
    const ogImage = image || `${base}/assets/og.png`;
    const nav = NAV.map(([href, label]) => {
      const on = href === "/" ? isTop : path.startsWith(href);
      return `<li><a href="${href}"${on ? ' aria-current="page"' : ""}>${label}</a></li>`;
    }).join("");
    return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(full)}</title>
<meta name="description" content="${esc(desc)}">
${noindex ? '<meta name="robots" content="noindex">' : `<meta name="robots" content="index,follow,max-image-preview:large">\n<link rel="canonical" href="${esc(url)}">`}
<meta property="og:type" content="${isTop ? "website" : type}">
<meta property="og:site_name" content="${esc(site.title)}">
<meta property="og:title" content="${esc(isTop ? full : title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(ogImage)}">
${image ? "" : '<meta property="og:image:width" content="1200">\n<meta property="og:image:height" content="630">'}
<meta property="og:locale" content="ja_JP">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#1f6fc5">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="alternate" type="application/rss+xml" title="${esc(site.title)}" href="/feed.xml">
<link rel="stylesheet" href="/assets/app.css?v=${ver.css}">
${site.gaId ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(site.gaId)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","${esc(site.gaId)}");</script>` : ""}
${site.googleSiteVerification ? `<meta name="google-site-verification" content="${esc(site.googleSiteVerification)}">` : ""}
${ld.map(jsonLd).join("\n")}
</head>
<body>
<header class="hd">
  <div class="wrap hd-in">
    ${isTop ? "<h1 class=\"logo-h\">" : ""}<a class="logo" href="/"><img src="/assets/logo-mark.png" width="40" height="40" alt=""><span class="logo-t">${esc(site.title)}<small>${esc(site.subtitle)}</small></span></a>${isTop ? "</h1>" : ""}
    <p class="hd-cd">${launchLabel}<span>${launchDate}${daysLeft > 0 ? " 配信予定" : " 配信開始"}</span></p>
  </div>
  <nav class="gnav"><ul class="wrap">${nav}</ul></nav>
</header>
<div class="wrap page">
<main class="main">
${body}
</main>
<aside class="side">
${side()}
</aside>
</div>
<footer class="ft">
  <div class="wrap">
    <p class="ft-links"><a href="/about/">このサイトについて</a> ／ <a href="/feed.xml">RSS</a> ／ <a href="${esc(site.contactUrl)}" ${ext}>お問い合わせ・削除依頼</a></p>
    <p class="ft-sis">運営サイト：${(config.sisterSites || []).map((s) => `<a href="${esc(s.url)}">${esc(s.name)}</a>`).join(" ／ ")}</p>
    <p class="ft-note">非公式ファンサイトです。『アズールプロミリア』© Manjuu Co., Ltd. © Yostar, Inc.</p>
  </div>
</footer>
<script src="/assets/app.js?v=${ver.js}" defer></script>
${scripts.map((s) => `<script src="${s}" defer></script>`).join("\n")}
</body>
</html>`;
  }

  function sec(title, body, { more = "", h = "h2", id = "", cls = "" } = {}) {
    return `<section class="sec ${cls}"${id ? ` id="${id}"` : ""}>
<${h} class="sec-t">${title}${more ? `<a class="sec-more" href="${more}">もっと見る »</a>` : ""}</${h}>
${body}
</section>`;
  }

  const catTags = (ids = []) => ids.map((c) => `<span class="tag tag-${esc(c)}">${esc(catLabel[c] || c)}</span>`).join("");
  const charaTags = (ids = []) =>
    ids
      .filter((id) => charaById[id])
      .map((id) => `<a class="ctag" href="/chara/${id}/">${esc(charaById[id].name)}</a>`)
      .join("");
  const isFresh = (iso) => now - new Date(iso) < 6 * 3600000;
  const newMark = (iso) => (isFresh(iso) ? '<span class="new" title="6時間以内の記事">NEW</span>' : "");

  // ---------- サイドバー ----------
  const campaigns = (content.campaigns || []).filter((c) => new Date(c.start) <= now && new Date(c.end) > now);
  function side() {
    const spec = (content.spec || []).filter(([k]) => /対応機種|価格|運営/.test(k));
    const topVideos = [...videos].filter((v) => !v.short).sort((a, b) => b.views - a.views).slice(0, 5);
    return `<section class="box box-launch">
<p class="bl-big">${launchLabel}</p>
<p class="bl-date">${launchDate}${daysLeft > 0 ? "配信予定" : "配信開始"}</p>
<dl class="kv">${spec.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
<p class="badges"><a href="${esc(config.store.appStoreUrl)}" ${ext}><img src="/assets/badge-appstore.svg" width="120" height="40" alt="App Storeからダウンロード"></a><a href="${esc(config.store.googlePlayUrl)}" ${ext}><img src="/assets/badge-googleplay.png" width="135" height="52" alt="Google Playで手に入れよう"></a></p>
${campaigns.length ? `<p class="bl-camp">開催中：${campaigns.map((c) => `<a href="${esc(c.url)}" ${ext}>${esc(c.name)}</a>（${md(c.end)}まで）`).join("、")}</p>` : ""}
</section>
<section class="box">
<h2 class="box-t">最近の書き込み</h2>
<ul class="rc" id="recentComments"><li class="muted">読み込み中…</li></ul>
</section>
<section class="box">
<h2 class="box-t">掲示板</h2>
<ul class="bl">${(config.boards || []).map((b) => `<li><a href="/bbs/${b.id}/">${esc(b.name)}</a><span class="muted" data-count-for="${b.id}"></span></li>`).join("")}<li><a href="/chara/">キャラクター別の掲示板</a></li></ul>
</section>
${topVideos.length ? `<section class="box"><h2 class="box-t">再生数の多い公式動画</h2><ol class="sv">${topVideos.map((v, i) => `<li><b class="rk rk-${i + 1}">${i + 1}</b><a href="/videos/#v-${esc(v.id)}">${pic(ytThumb(v), "wide", v.title, { cls: "sv-img", label: "動画" })}<span>${esc(shortTitle(v.title))}</span></a><span class="muted">${num(v.views)}回</span></li>`).join("")}</ol></section>` : ""}`;
  }

  // ---------- 記事の部品 ----------
  // 記事は重要度で見せ方を変える。lead=大きい画像 / card=3列の画像 / row=小さい画像＋見出し / text=見出しだけ
  function meta(n) {
    return `<p class="n-m">${newMark(n.publishedAt)}${catTags(n.categories)}${charaTags(n.charas)}<span class="src">${esc(n.source)}</span>${time(n.publishedAt)}</p>`;
  }
  function newsItem(n, kind = "row") {
    const a = (inner, cls = "n-a") => `<a class="${cls}" href="${esc(n.url)}" ${ext}>${inner}</a>`;
    if (kind === "lead")
      return `<article class="n n-lead">${a(pic(n.image, "thumb", n.title, { label: n.source, eager: true }), "n-img")}<div class="n-b">${a(esc(n.title))}${meta(n)}</div></article>`;
    if (kind === "card") return `<article class="n n-card">${a(pic(n.image, "thumb", n.title, { label: n.source }), "n-img")}${a(esc(n.title))}${meta(n)}</article>`;
    if (kind === "row")
      return `<article class="n n-row">${a(images.get(n.image, "thumb") ? pic(n.image, "thumb", n.title) : noimg(n.source), "n-img")}<div class="n-b">${a(esc(n.title))}${meta(n)}</div></article>`;
    return `<article class="n n-text">${a(esc(n.title))}${meta(n)}</article>`;
  }
  // 新しい順のまま、先頭から lead → card → row → text と見せ方を落としていく。
  // 各媒体が同じ公式画像を使うことが多いので、同じ画像の 2 回目からは画像を出さない（lead・card は札、row は見出しだけ）
  function newsBlock(list, { leads = 0, cards = 0, rows = 999 } = {}) {
    const used = new Set();
    const view = (n) => {
      const ok = !!images.get(n.image, "thumb") && !used.has(n.image);
      if (ok) used.add(n.image);
      return { n: ok ? n : { ...n, image: "" }, dup: !ok && !!images.get(n.image, "thumb") };
    };
    const lead = list.slice(0, leads).map((n) => newsItem(view(n).n, "lead"));
    const card = list.slice(leads, leads + cards).map((n) => newsItem(view(n).n, "card"));
    const rest = list.slice(leads + cards).map((n, i) => {
      const v = view(n);
      return newsItem(v.n, i < rows && !v.dup ? "row" : "text");
    });
    return `${lead.join("")}${card.length ? `<div class="n-grid">${card.join("")}</div>` : ""}${rest.length ? `<div class="n-list">${rest.join("")}</div>` : ""}`;
  }
  function byDay(list) {
    const groups = new Map();
    for (const n of list) {
      const d = jstDay(n.publishedAt);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(n);
    }
    return [...groups].map(([, items]) => `<h3 class="day">${md(items[0].publishedAt)}<span>${items.length}件</span></h3>${newsBlock(items, { rows: 999 })}`).join("");
  }

  // ---------- 動画の部品 ----------
  function shortTitle(t) {
    return t
      .replace(/^【アズールプロミリア】/, "")
      .replace(/^『?アズールプロミリア』?\s*/, "")
      .replace(/^「アズールプロミリア」/, "")
      .trim() || t;
  }
  function viewsGain(v) {
    const lg = v.viewsLog || [];
    if (lg.length < 2) return "";
    const g = lg[lg.length - 1][1] - lg[lg.length - 2][1];
    return g > 0 ? `<span class="gain" title="前日からの再生数の伸び">+${num(g)}</span>` : "";
  }
  function videoCard(v, { big = false } = {}) {
    return `<article class="v${big ? " v-big" : ""}" id="v-${esc(v.id)}">
<a class="v-img" href="${esc(v.url)}" data-yt="${esc(v.id)}" ${ext}>${pic(ytThumb(v), "wide", v.title, { label: "公式動画", eager: big })}<i class="v-play" aria-hidden="true"></i></a>
<h3 class="v-t"><a href="${esc(v.url)}" ${ext}>${esc(shortTitle(v.title))}</a></h3>
<p class="v-m">${time(v.publishedAt, md)}<span>${num(v.views)}回再生</span>${viewsGain(v)}${charaTags(v.charas)}</p>
</article>`;
  }
  const videoLd = (list) =>
    list.map((v) => ({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: v.title,
      description: v.desc || v.title,
      thumbnailUrl: absImg(ytThumb(v), "wide") || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
      uploadDate: v.publishedAt,
      contentUrl: v.url,
      embedUrl: `https://www.youtube.com/embed/${v.id}`,
    }));

  // ---------- 話題（複数の媒体が報じたもの） ----------
  function topicList(topics) {
    return `<ol class="tp">${topics
      .map((t) => {
        // 同じ媒体が続報を出していることがあるので、媒体名は 1 回ずつにする
        const seen = new Set([t.leadSource]);
        const others = t.articles.filter((a) => !seen.has(a.source) && seen.add(a.source)).slice(0, 4);
        return `<li>${images.get(t.image, "thumb") ? `<a class="tp-img" href="${esc(t.url)}" ${ext} tabindex="-1">${pic(t.image, "thumb", t.title)}</a>` : ""}<div>${topicHref(t) ? `<a class="tp-a" href="${topicHref(t)}">${esc(t.title)}</a>` : `<a class="tp-a" href="${esc(t.url)}" ${ext}>${esc(t.title)}</a>`}
<p class="tp-m">${esc(t.leadSource)}${others.length ? "・" + others.map((a) => `<a href="${esc(a.url)}" ${ext}>${esc(a.source)}</a>`).join("・") : ""}　${time(t.publishedAt)}</p></div></li>`;
      })
      .join("")}</ol>`;
  }

  // ---------- コメント欄 ----------
  function commentsHtml(id, title, { lead = "", h = "h2" } = {}) {
    return `<section class="sec comments" id="comments" data-work="${esc(id)}" data-title="${esc(title)}">
<${h} class="sec-t"><span>${esc(title)}の掲示板<span class="c-count" id="cCount"></span></span></${h}>
${lead ? `` : ""}
<div class="c-list" id="cList"><p class="c-empty">読み込み中…</p></div>
<form class="c-form" id="cForm" novalidate>
<div class="c-row"><label>名前<input type="text" name="name" maxlength="20" placeholder="名無しの星臨者" autocomplete="nickname"></label>
<label class="c-sp"><input type="checkbox" name="spoiler" value="1"> ネタバレ</label></div>
<label class="c-body-label">本文<textarea name="body" rows="4" maxlength="500" required></textarea></label>
<input type="text" name="website" class="c-hp" tabindex="-1" autocomplete="off" aria-hidden="true">
<div class="c-foot"><span class="c-len" id="cLen">0 / 500</span><button type="submit">書き込む</button></div>
<p class="c-msg" id="cMsg" role="status"></p>
<p class="c-rule">URL・メールアドレス・電話番号は書き込めません。</p>
</form>
<noscript><p class="c-empty">書き込みを見るには JavaScript を有効にしてください。</p></noscript>
</section>`;
  }
  const commentScripts = [`/assets/comments.js?v=${ver.comments}`];
  const index = {};

  // ---------- キャラクターの部品 ----------
  function charaGrid(list = charas) {
    return `<ul class="cg">${list
      .map(
        (c) => `<li><a href="/chara/${c.id}/">${pic(avatarUrl(c), "icon", c.name, { cls: "cg-img", label: c.name })}<b>${esc(c.name)}</b>${c.badge ? `<span class="badge badge-${c.badge === "限定" ? "lim" : "free"}">${esc(c.badge)}</span>` : ""}</a></li>`
      )
      .join("")}</ul>`;
  }
  const newsOfChara = (c) => main.filter((n) => (n.charas || []).includes(c.id));
  const videosOfChara = (c) => videos.filter((v) => (v.charas || []).includes(c.id));

  // ---------- トップ ----------
  {
    const topics = (state.topics || []).slice(0, 5);
    const vids = videos.filter((v) => !v.short);
    const lead = vids[0];
    // 一番上は、画像のある新しい記事 3 本を大小の組み合わせで見せる（同じ画像は使わない）
    const feat = [];
    const featImgs = new Set();
    for (const n of main.slice(0, 12)) {
      if (feat.length >= 3) break;
      if (!images.get(n.image, "thumb") || featImgs.has(n.image)) continue;
      featImgs.add(n.image);
      feat.push(n);
    }
    const featHtml = feat.length === 3
      ? `<div class="fe">${feat
          .map((n, i) => `<a class="fe-i${i === 0 ? " fe-big" : ""}" href="${esc(n.url)}" ${ext}>${images.get(n.image, "wide") ? pic(n.image, "wide", n.title, { eager: i === 0 }) : pic(n.image, "thumb", n.title, { eager: i === 0 })}<span class="fe-c">${catTags(n.categories)}<b>${esc(n.title)}</b><small>${esc(n.source)}・${mdhm(n.publishedAt)}</small></span></a>`)
          .join("")}</div>`
      : "";
    const rest = feat.length === 3 ? main.filter((n) => !feat.includes(n)) : main;
    const pickup = `<div class="pick">
<div class="pick-t"><h2 class="pick-h">いま話題</h2>${topics.length ? topicList(topics) : `<div class="n-list">${rest.slice(0, 5).map((n) => newsItem(n, "text")).join("")}</div>`}</div>
${lead ? `<div class="pick-v"><h2 class="pick-h pick-h-v">最新の公式動画</h2>${videoCard(lead, { big: true })}${vids.length > 1 ? `<ul class="pick-more">${vids
      .slice(1, 3)
      .map((v) => `<li><a href="/videos/#v-${esc(v.id)}">${pic(ytThumb(v), "wide", v.title, { label: "動画" })}<span>${esc(shortTitle(v.title))}<small>${md(v.publishedAt)}・${num(v.views)}回再生</small></span></a></li>`)
      .join("")}</ul>` : ""}</div>` : ""}
</div>`;
    // 限定ガチャの期間は「2026-12-17 4:59」「2026-12-17 メンテナンス後」のような書き方なので、先頭の日付だけ見る
    const dayOf = (s) => (String(s).match(/\d{4}-\d{2}-\d{2}/) || [""])[0];
    const pickupG = (content.launchGacha || []).find((g) => dayOf(g.to) >= today && charaById[g.chara]);
    const spot = pickupG ? charaById[pickupG.chara] : charas[0];
    const spotLabel = pickupG ? (dayOf(pickupG.from) <= today ? "ピックアップ中" : `${md(dayOf(pickupG.from) + "T00:00:00+09:00")}からピックアップ`) : "";
    const strip = `<div class="cx">
<a class="cx-spot" href="/chara/${spot.id}/">${pic(artUrl(spot), "art", spot.name, { label: spot.name })}<span class="cx-b">${spotLabel ? `<span class="cx-l">${esc(spotLabel)}</span>` : ""}<b>${esc(spot.name)}</b>${spot.cv ? `<small>CV：${esc(spot.cv)}</small>` : ""}${pickupG ? `<small>限定ガチャ「${esc(pickupG.name)}」</small>` : ""}</span></a>
<ul class="cg cx-g">${charas
      .filter((c) => c !== spot)
      .map((c) => `<li><a href="/chara/${c.id}/">${pic(avatarUrl(c), "icon", c.name, { cls: "cg-img", label: c.name })}<b>${esc(c.name)}</b>${c.badge ? `<span class="badge badge-${c.badge === "限定" ? "lim" : "free"}">${esc(c.badge)}</span>` : ""}</a></li>`)
      .join("")}</ul>
</div>`;
    const shots = (cur?.screenshots || []).filter((u) => images.get(u, "shot"));
    const body = `${featHtml}
${pickup}
${sec("ニュース", rest.length ? newsBlock(rest.slice(0, 13), { cards: 3, rows: 10 }) : '<p class="muted">まだありません。</p>', { more: "/news/" })}
${sec("キャラクター", strip, { more: "/chara/", cls: "sec-pink" })}
${vids.length > 1 ? sec("公式動画", `<div class="vg vg-4">${vids.slice(1, 9).map((v) => videoCard(v)).join("")}</div>`, { more: "/videos/", cls: "sec-dark" }) : ""}
${shots.length ? sec("ゲーム画面", `<div class="shots">${shots.map((u) => pic(u, "shot", "アズールプロミリアのゲーム画面")).join("")}</div>`, { more: "/info/#shots" }) : ""}
${series.length ? sec("アズレン・Manjuuの話題", `<div class="n-list">${series.slice(0, 6).map((n) => newsItem(n, images.get(n.image, "thumb") ? "row" : "text")).join("")}</div>`, { more: "/azurlane/" }) : ""}`;
    const ld = [
      {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: site.title,
        alternateName: "アズールプロミリア情報まとめ",
        url: base + "/",
        description: site.tagline,
        inLanguage: "ja",
      },
    ];
    put("/", layout({ path: "/", title: site.title, desc: site.tagline, body, ld, scripts: commentScripts }), { priority: 1 });
  }

  // ---------- ニュース ----------
  const months = [...new Set(main.map((n) => jstDay(n.publishedAt).slice(0, 7)))].sort().reverse();
  const monthNav = (curMonth = "") =>
    months.length ? `<p class="months">月ごと：${months.map((m) => (m === curMonth ? `<b>${m.replace("-", "年")}月</b>` : `<a href="/news/${m}/">${m.replace("-", "年")}月</a>`)).join(" ")}</p>` : "";
  put(
    "/news/",
    layout({
      path: "/news/",
      title: "アズールプロミリアのニュース",
      desc: "ファミ通・4Gamer・GameWith などゲーム媒体が報じたアズールプロミリア（アズプロ）の記事を日ごとにまとめています。",
      body: `${crumbs([["/news/", "ニュース"]])}${sec("アズールプロミリアのニュース", `${monthNav()}${byDay(main.slice(0, 150))}`, { h: "h1" })}`,
    }),
    { priority: 0.8 }
  );
  for (const m of months) {
    const list = main.filter((n) => jstDay(n.publishedAt).startsWith(m));
    const label = `${m.replace("-", "年")}月`;
    put(
      `/news/${m}/`,
      layout({
        path: `/news/${m}/`,
        title: `${label}のアズールプロミリアのニュース`,
        desc: `${label}にゲーム媒体が報じたアズールプロミリア（アズプロ）の記事${list.length}件。`,
        body: `${crumbs([["/news/", "ニュース"], [`/news/${m}/`, label]])}${sec(`${label}のニュース`, `${monthNav(m)}${byDay(list)}`, { h: "h1" })}`,
      }),
      { priority: 0.4 }
    );
  }
  put(
    "/azurlane/",
    layout({
      path: "/azurlane/",
      title: "アズレン・Manjuuの話題",
      desc: "アズールプロミリアの開発元 Manjuu の『アズールレーン』など、関連するニュース。",
      body: `${crumbs([["/azurlane/", "アズレン・Manjuu"]])}${sec("アズレン・Manjuuの話題", `${byDay(series.slice(0, 150))}`, { h: "h1" })}`,
    }),
    { priority: 0.5 }
  );

  // ---------- 動画 ----------
  put(
    "/videos/",
    layout({
      path: "/videos/",
      title: "アズールプロミリアの公式動画",
      desc: "アズールプロミリア公式YouTubeチャンネルのPV・生放送・キャラクター紹介の動画をまとめて見られます。",
      body: `${crumbs([["/videos/", "公式動画"]])}${sec("公式動画", `<div class="vg">${videos.map((v) => videoCard(v)).join("")}</div>`, { h: "h1" })}`,
      ld: videoLd(videos.slice(0, 20)),
    }),
    { priority: 0.7 }
  );

  // ---------- キャラクター ----------
  put(
    "/chara/",
    layout({
      path: "/chara/",
      title: "アズールプロミリアのキャラクター一覧・声優",
      desc: `アズールプロミリアのキャラクター${charas.length}人の一覧。${charas.map((c) => c.name).join("・")}。`,
      body: `${crumbs([["/chara/", "キャラクター"]])}${sec(
        "キャラクター一覧",
        `<div class="cl">${charas
          .map(
            (c) => `<a class="cl-i" href="/chara/${c.id}/">${pic(artUrl(c), "art", c.name, { cls: "cl-img", label: c.name })}<span class="cl-b"><b>${esc(c.name)}</b><small>${esc(c.en)}</small>${c.cv ? `<span class="cl-cv">CV：${esc(c.cv)}</span>` : ""}${c.badge ? `<span class="badge badge-${c.badge === "限定" ? "lim" : "free"}">${esc(c.badge)}</span>` : ""}<span class="cl-n" data-count-for="chara-${c.id}"></span></span></a>`
          )
          .join("")}</div>
`,
        { h: "h1" }
      )}`,
      image: charas[0] ? absImg(artUrl(charas[0]), "og") : "",
      scripts: commentScripts,
    }),
    { priority: 0.8 }
  );
  for (const c of charas) {
    const wid = `chara-${c.id}`;
    const path = `/chara/${c.id}/`;
    index[wid] = { title: c.name, path };
    const ns = newsOfChara(c);
    const vs = videosOfChara(c);
    const gacha = (content.launchGacha || []).filter((g) => g.chara === c.id);
    const prof = [
      ["英語表記", c.en],
      ["出身・所属", c.from],
      ["役割", c.role],
      ["CV", c.cv],
    ].filter(([, v]) => v);
    const idx = charas.indexOf(c);
    const prevC = charas[(idx - 1 + charas.length) % charas.length];
    const nextC = charas[(idx + 1) % charas.length];
    const body = `${crumbs([["/chara/", "キャラクター"], [path, c.name]])}
<article class="sec chara">
<div class="ch">
<div class="ch-art">${pic(artUrl(c), "art", `${c.name}（アズールプロミリア）`, { eager: true, label: c.name })}</div>
<div class="ch-b">
<h1 class="ch-name">${esc(c.name)}${c.badge ? `<span class="badge badge-${c.badge === "限定" ? "lim" : "free"}">${esc(c.badge)}</span>` : ""}</h1>
<table class="tb"><tbody>${prof.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
<p class="ch-text">${esc(c.text)}</p>
${gacha.map((g) => `<p class="ch-gacha"><b>限定ガチャ「${esc(g.name)}」</b>${esc(g.from)} 〜 ${esc(g.to)}<br>${esc(g.event)}</p>`).join("")}

</div>
</div>
<p class="ch-nav"><a href="/chara/${prevC.id}/">« ${esc(prevC.name)}</a><a href="/chara/">キャラクター一覧</a><a href="/chara/${nextC.id}/">${esc(nextC.name)} »</a></p>
</article>
${vs.length ? sec(`${esc(c.name)}が出てくる公式動画`, `<div class="vg">${vs.slice(0, 6).map((v) => videoCard(v)).join("")}</div>`) : ""}
${ns.length ? sec(`${esc(c.name)}のニュース`, `<div class="n-list">${ns.slice(0, 30).map((n) => newsItem(n, images.get(n.image, "thumb") ? "row" : "text")).join("")}</div>`) : ""}
${commentsHtml(wid, c.name)}`;
    put(
      path,
      layout({
        path,
        title: `${c.name}（アズールプロミリア）のプロフィール・声優・掲示板`,
        desc: `アズールプロミリアの${c.name}${c.cv ? `（CV：${c.cv}）` : ""}。${c.text}`.slice(0, 120),
        body,
        image: absImg(artUrl(c), "og"),
        scripts: commentScripts,
      }),
      { priority: 0.7 }
    );
  }

  // ---------- 基本情報 ----------
  {
    const spec = `<table class="tb"><tbody>${(content.spec || []).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}${cur ? `<tr><th>容量（App Store）</th><td>${num(Math.round(cur.size / 1024 * 10) / 10)}GB</td></tr>` : ""}</tbody></table>`;
    const tl = `<ol class="tl">${(content.timeline || [])
      .map(([d, t]) => `<li class="${new Date(d + "T23:59:59+09:00") < now ? "done" : "next"}"><time datetime="${d}">${d.replace(/-/g, "/")}</time><span>${esc(t)}</span></li>`)
      .join("")}</ol>`;
    const terms = `<dl class="terms">${(content.terms || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
    const rewards = `<table class="tb"><thead><tr><th>報酬</th><th>数</th><th>説明</th></tr></thead><tbody>${(content.rewards || []).map(([n, c, d]) => `<tr><td><b>${esc(n)}</b></td><td class="nowrap">${esc(c)}</td><td>${esc(d)}</td></tr>`).join("")}</tbody></table>`;
    const gacha = `<table class="tb"><thead><tr><th>ガチャ</th><th>ピックアップ</th><th>期間</th></tr></thead><tbody>${(content.launchGacha || [])
      .map((g) => `<tr><td>${esc(g.name)}</td><td><a href="/chara/${g.chara}/">${esc(charaById[g.chara]?.name || g.chara)}</a></td><td>${esc(g.from)} 〜 ${esc(g.to)}</td></tr>`)
      .join("")}</tbody></table>`;
    const shots = (cur?.screenshots || []).filter((u) => images.get(u, "shot"));
    const hist = (store.history || []).length
      ? `<table class="tb"><thead><tr><th>バージョン</th><th>公開日</th><th>内容</th></tr></thead><tbody>${store.history.map((h) => `<tr><td>${esc(h.version)}</td><td class="nowrap">${h.date ? ymd(h.date) : ""}</td><td class="pre">${esc(h.notes || "")}</td></tr>`).join("")}</tbody></table>`
      : "";
    const body = `${crumbs([["/info/", "基本情報"]])}
${sec("アズールプロミリアの基本情報", `${spec}<p class="story">${esc(content.story || "")}</p>`, { h: "h1" })}
${sec("これまでの動きと予定", tl, { id: "timeline" })}
${sec("事前登録の報酬", rewards, { id: "rewards" })}
${sec("リリース直後の限定ガチャ", gacha, { id: "gacha" })}
${sec("用語", terms, { id: "terms" })}
${sec("地域", `<ul class="regions">${(content.regions || []).map((r) => `<li><b>${esc(r.name)}</b>${r.en ? `<small>${esc(r.en)}</small>` : ""}</li>`).join("")}</ul>`, { id: "world" })}
${shots.length ? sec("ゲーム画面", `<div class="shots">${shots.map((u) => pic(u, "shot", "アズールプロミリアのゲーム画面")).join("")}</div>`, { id: "shots" }) : ""}
${hist ? sec("アプリの更新履歴", hist, { id: "history" }) : ""}`;
    const ld = [
      {
        "@context": "https://schema.org",
        "@type": "VideoGame",
        name: "アズールプロミリア",
        alternateName: ["Azur Promilia", "アズプロ"],
        genre: "RPG",
        gamePlatform: ["iOS", "Android", "Windows"],
        applicationCategory: "Game",
        operatingSystem: "iOS, Android, Windows",
        datePublished: "2026-11-26",
        description: content.story,
        author: { "@type": "Organization", name: "Manjuu Games" },
        publisher: [{ "@type": "Organization", name: "Manjuu Games" }, { "@type": "Organization", name: "Yostar" }],
        offers: { "@type": "Offer", price: 0, priceCurrency: "JPY" },
        url: "https://azurpromilia.jp/",
      },
    ];
    put("/info/", layout({ path: "/info/", title: "アズールプロミリアの配信日・事前登録報酬・限定ガチャ", desc: "アズールプロミリアの配信日・対応機種・事前登録報酬・リリース直後の限定ガチャ・用語・これまでの動きをまとめています。", body, ld }), { priority: 0.8 });
  }

  // ---------- 話題のページ ----------
  {
    const topicRow = (t) => `<li><a class="tl-a" href="/topic/${t.key}/">${images.get(t.image, "thumb") ? pic(t.image, "thumb", t.title) : noimg(t.leadSource)}<span><b>${esc(t.title)}</b><small>${esc([...new Set(t.members.map((m) => m.source))].slice(0, 4).join("・"))}　${md(t.publishedAt)}</small></span></a></li>`;
    put(
      "/topic/",
      layout({
        path: "/topic/",
        title: "アズールプロミリアの話題",
        desc: "複数のゲーム媒体が報じたアズールプロミリア（アズプロ）の話題を、記事ごとにまとめています。",
        body: `${crumbs([["/topic/", "話題"]])}${sec("アズールプロミリアの話題", allTopics.length ? `<ul class="tls">${allTopics.map(topicRow).join("")}</ul>` : '<p class="muted">まだありません。</p>', { h: "h1" })}`,
      }),
      { priority: 0.7 }
    );
    allTopics.forEach((t, i) => {
      const path = `/topic/${t.key}/`;
      const wid = `t-${t.key}`;
      index[wid] = { title: t.title, path };
      const sources = [...new Set(t.members.map((m) => m.source))];
      const members = [...t.members].sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1));
      const img = images.get(t.image, "wide") ? pic(t.image, "wide", t.title, { eager: true }) : images.get(t.image, "thumb") ? pic(t.image, "thumb", t.title, { eager: true }) : "";
      const near = allTopics.filter((x) => x !== t).slice(Math.max(0, i - 3), i + 3);
      const body = `${crumbs([["/topic/", "話題"], [path, t.title.slice(0, 30)]])}
<article class="sec tpc">
<h1 class="tpc-h">${esc(t.title)}</h1>
<p class="n-m">${catTags(t.categories)}${charaTags(t.charas)}${time(t.publishedAt, ymd)}</p>
${img ? `<div class="tpc-img">${img}</div>` : ""}
<ol class="tpc-l">${members
        .map((m) => `<li><time datetime="${esc(m.publishedAt)}">${mdhm(m.publishedAt)}</time><span class="src">${esc(m.source)}</span><a href="${esc(m.url)}" ${ext}>${esc(m.title)}</a></li>`)
        .join("")}</ol>
</article>
${commentsHtml(wid, "この話題")}
${near.length ? sec("ほかの話題", `<ul class="tls">${near.map(topicRow).join("")}</ul>`, { more: "/topic/" }) : ""}`;
      put(
        path,
        layout({
          path,
          title: t.title,
          desc: `${sources.slice(0, 4).join("・")}などが報じたアズールプロミリアの話題。${t.title}`.slice(0, 120),
          body,
          image: absImg(t.image, "wide") || absImg(t.image, "thumb"),
          scripts: commentScripts,
        }),
        { priority: 0.6 }
      );
    });
  }

  // ---------- 掲示板 ----------
  put(
    "/bbs/",
    layout({
      path: "/bbs/",
      title: "アズールプロミリア掲示板（雑談・ガチャ報告・質問）",
      desc: "アズールプロミリアの雑談・ガチャ報告・質問の掲示板。キャラクターごとの掲示板もあります。",
      body: `${crumbs([["/bbs/", "掲示板"]])}${sec(
        "掲示板",
        `<ul class="bbs">${(config.boards || []).map((b) => `<li><a href="/bbs/${b.id}/"><b>${esc(b.name)}</b></a><span>${esc(b.desc)}</span><span class="muted" data-count-for="${b.id}"></span></li>`).join("")}</ul>
<h2 class="sub">キャラクターの掲示板</h2>
<ul class="bbs bbs-c">${charas.map((c) => `<li><a href="/chara/${c.id}/#comments">${pic(avatarUrl(c), "icon", c.name, { cls: "bbs-ic", label: c.name })}<b>${esc(c.name)}</b></a><span class="muted" data-count-for="chara-${c.id}"></span></li>`).join("")}</ul>`,
        { h: "h1" }
      )}`,
      scripts: commentScripts,
    }),
    { priority: 0.6 }
  );
  for (const b of config.boards || []) {
    index[b.id] = { title: b.name, path: `/bbs/${b.id}/` };
    put(
      `/bbs/${b.id}/`,
      layout({
        path: `/bbs/${b.id}/`,
        title: `${b.name}｜アズールプロミリア掲示板`,
        desc: `アズールプロミリア（アズプロ）の${b.name}掲示板。${b.desc}`,
        body: `${crumbs([["/bbs/", "掲示板"], [`/bbs/${b.id}/`, b.name]])}${commentsHtml(b.id, b.name, { h: "h1" })}`,
        scripts: commentScripts,
      }),
      { priority: 0.5 }
    );
  }

  // ---------- リンク ----------
  {
    const groups = new Map();
    for (const l of config.links || []) {
      if (!groups.has(l.group)) groups.set(l.group, []);
      groups.get(l.group).push(l);
    }
    const guideNews = main.filter((n) => (n.categories || []).includes("guide")).slice(0, 15);
    const body =
      crumbs([["/links/", "リンク"]]) +
      sec("リンク集", [...groups].map(([g, ls]) => `<h2 class="sub">${esc(g)}</h2><ul class="lk">${ls.map((l) => `<li><a href="${esc(l.url)}" ${ext}>${esc(l.name)}</a><span class="muted">${esc(new URL(l.url).hostname)}</span></li>`).join("")}</ul>`).join(""), { h: "h1" }) +
      (guideNews.length ? sec("攻略・レビューの新しい記事", `<div class="n-list">${guideNews.map((n) => newsItem(n, "text")).join("")}</div>`) : "");
    put("/links/", layout({ path: "/links/", title: "アズールプロミリアのリンク集（公式・攻略）", desc: "アズールプロミリアの公式サイト・公式X・公式YouTube・ストア・攻略サイトへのリンク。", body }), { priority: 0.4 });
  }

  // ---------- このサイトについて・404 ----------
  put(
    "/about/",
    layout({
      path: "/about/",
      title: "このサイトについて",
      desc: `${site.title}について。集めている情報と画像の扱い。`,
      body: `${crumbs([["/about/", "このサイトについて"]])}${sec(
        "このサイトについて",
        `<div class="prose">
<p>${esc(site.title)}は、『アズールプロミリア』の情報を集めている非公式のファンサイトです。</p>
<p>集めているもの：</p>
<ul>
<li>公式 YouTube チャンネルの動画と再生数</li>
<li>App Store のバージョン・評価・スクリーンショット</li>
<li>Google ニュースに載ったゲーム媒体・攻略サイトの記事（見出しと元記事の画像）</li>
</ul>
<p>約30分おきに自動で集め直しています。記事の本文は載せていないので、続きは元の記事でお読みください。</p>
<p>画像は、集めたときに一度だけ取得して縮小したものをこのサイトのサーバーに置いています。ページを開いたときに元のサイトへ画像を読みに行くことはありません。</p>
<p>キャラクターの紹介と基本情報は、公式サイト・App Store・ゲーム媒体の記事をもとに手で書いています。配信後に変わることがあります。</p>
<p>掲載内容や画像に問題がある場合は <a href="${esc(site.contactUrl)}" ${ext}>お問い合わせ</a> からご連絡ください。確認して削除します。</p>
</div>`,
        { h: "h1" }
      )}`,
    }),
    { priority: 0.2 }
  );
  put("/404.html", layout({ path: "/404.html", title: "ページが見つかりません", desc: "ページが見つかりません。", body: sec("ページが見つかりません", `<p>お探しのページは移動したか、なくなりました。</p><p><a href="/">トップへ戻る</a></p>`, { h: "h1" }), noindex: true }), { index: false });

  // ---------- 書き出し ----------
  for (const p of pages) {
    const file = p.path.endsWith(".html") ? join(DOCS, p.path) : join(DOCS, p.path, "index.html");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, minifyHtml(p.html), "utf8");
  }
  // 設定から消えたキャラクターのページを残さない
  try {
    const ids = new Set(charas.map((c) => c.id));
    for (const d of await readdir(join(DOCS, "chara"), { withFileTypes: true })) if (d.isDirectory() && !ids.has(d.name)) await rm(join(DOCS, "chara", d.name), { recursive: true });
  } catch {}

  try {
    const keys = new Set(allTopics.map((t) => t.key));
    for (const d of await readdir(join(DOCS, "topic"), { withFileTypes: true })) if (d.isDirectory() && !keys.has(d.name)) await rm(join(DOCS, "topic", d.name), { recursive: true });
  } catch {}

  // コメントを受け付けるページの一覧（api/comments.php が読む）
  await mkdir(join(DOCS, "data"), { recursive: true });
  await writeFile(join(DOCS, "data", "works-index.json"), JSON.stringify(index), "utf8");

  // sitemap.xml
  const sm = pages
    .filter((p) => p.index)
    .map((p) => `<url><loc>${esc(base + p.path)}</loc><lastmod>${updatedAt.slice(0, 10)}</lastmod><priority>${p.priority}</priority></url>`)
    .join("");
  await writeFile(join(DOCS, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sm}</urlset>\n`, "utf8");

  // feed.xml（公式動画とニュース）
  const feedItems = [
    ...videos.slice(0, 10).map((v) => ({ title: `【公式動画】${v.title}`, url: v.url, at: v.publishedAt, desc: v.desc })),
    ...main.slice(0, 50).map((n) => ({ title: n.title, url: n.url, at: n.publishedAt, desc: n.source })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 50);
  await writeFile(
    join(DOCS, "feed.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(site.title)}</title><link>${esc(site.url)}</link><description>${esc(site.tagline)}</description><language>ja</language><lastBuildDate>${new Date(updatedAt).toUTCString()}</lastBuildDate>${feedItems
      .map((i) => `<item><title>${esc(i.title)}</title><link>${esc(i.url)}</link><guid>${esc(i.url)}</guid><pubDate>${new Date(i.at).toUTCString()}</pubDate><description>${esc(i.desc || "")}</description></item>`)
      .join("")}</channel></rss>\n`,
    "utf8"
  );
  log(`pages: ${pages.length} written`);
}
