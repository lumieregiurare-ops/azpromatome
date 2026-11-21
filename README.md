# アズプロ速報

『アズールプロミリア』（アズプロ）の情報をまとめるサイトです。ragadmatome を元にしています。`docs/` がサイトルートで、ロリポップ（FTP）に置いて公開します。公開先は `https://azpromatome.gamelab.website/`。

ロゴとファビコンはオリジナルのドット絵です。キャラクターの画像は公式サイトのものを縮小して載せています。

## 集めているもの

| 集め先 | 中身 | 保存先 |
| --- | --- | --- |
| 公式 YouTube の RSS | 動画・再生数（日ごとに記録して伸びを出す） | `data/videos.json` |
| App Store の lookup API | 評価・バージョン・更新内容・スクリーンショット | `data/store.json` |
| Google ニュースの検索 | ゲーム媒体・攻略サイトの記事（見出しと元記事の og:image） | `data/archive/` |

公式サイトにはお知らせの一覧が無い（お知らせは公式 X で出る）ので、公式サイトからは集めていません。見出しに「アズールプロミリア」「アズプロ」があればアズプロの記事、「アズールレーン」「Manjuu」だけなら「アズレン・Manjuu」の記事に分けます。Yahoo!ニュースなどの転載は、元の記事があれば捨てます。

## 画像の扱い（直リンクしない）

外部の画像は、収集のときに 1 回だけ取りに行き、縮小した WebP（SNS 用のカードは JPEG）を `docs/img/` に置きます。ページはこのコピーだけを指すので、閲覧者のブラウザが相手のサーバーへ画像を読みに行くことはありません。処理は `scripts/lib/imgcache.mjs`。

- 一度取れた画像は二度と取りに行かない（`data/images.json` に記録）。同じ画像から何種類かの大きさを作るときも取得は 1 回
- 同じサイトへは 1 枚ずつ、1.5 秒あけて取りに行く。1 回の収集で新しく取るのは 60 枚まで
- 失敗した画像は 6 時間 → 1 日 → 3 日あけて取り直し、4 回失敗したらあきらめる
- 403 / 429 を返してきたサイトは `data/hosts.json` に記録し、403 なら 1 週間、429 なら 1 日、記事ページも画像も取りに行かない（いまは gamer.ne.jp と mezha.net）。その記事は色付きの札で表示する
- 45 日どのページからも使われなかった画像は消す

設定は `config.json` の `images`。

## 使い方

```bash
npm install                          # esbuild / sharp
node scripts/collect.mjs             # 集めて、画像を置いて、ページを作る
node scripts/collect.mjs --backfill  # 初回だけ。Google ニュースを 90 日さかのぼる
node scripts/build.mjs               # site/ を最小化して docs/ に出力し、ページを作る
python scripts/make-og.py            # ロゴ・ファビコン・OGP 画像を作り直す（普段は不要）
```

画面を確かめるときは、コメントも動くように XAMPP の PHP で `docs/` を配信します（`http://127.0.0.1:3297/`）。

```bash
C:\xampp\php\php.exe -S 127.0.0.1:3297 -t docs
```

編集するのは `site/`・`scripts/`・`config.json`・`content.json` です。`docs/` は直接編集しないでください（次のビルドで上書きされます）。HTML はすべて `scripts/lib/pages.mjs` が作ります。

## ページ

| URL | 内容 |
| --- | --- |
| `/` | 最新の公式動画・複数の媒体が報じた話題・ニュース・キャラクター・ゲーム画面 |
| `/news/` `/news/2026-11/` | ニュースの一覧（日ごと・月ごと） |
| `/videos/` | 公式動画 |
| `/chara/` `/chara/<id>/` | キャラクター一覧と、キャラごとのページ（紹介・関連ニュース・掲示板） |
| `/info/` | 基本情報・これまでの動き・事前登録報酬・限定ガチャ・用語・地域・アプリの更新履歴 |
| `/bbs/` `/bbs/talk/` `/bbs/gacha/` `/bbs/question/` | 掲示板 |
| `/azurlane/` | アズレン・Manjuu の話題 |
| `/links/` `/about/` `/404.html` `/feed.xml` `/sitemap.xml` | |

## SEO

- ページごとの title・description・canonical・OGP（キャラのページはキャラの画像のカード）
- 構造化データ：WebSite（トップ）、BreadcrumbList（各ページ）、VideoGame（基本情報）、VideoObject（動画）
- `sitemap.xml`・`robots.txt`・`feed.xml`
- `site/.htaccess`：無いページを 404 で返す・画像と CSS/JS を長くキャッシュ・圧縮
- 画像に width/height を付けて読み込み中に画面がずれないようにし、2 枚目以降は遅延読み込み

Search Console を使うときは `config.json` の `site.googleSiteVerification` に確認コードを、アナリティクスは `site.gaId` に測定 ID を書きます。

## 手で更新するもの

- `content.json` … 基本情報・これまでの動き・事前登録報酬・限定ガチャ・用語・キャラクター。公式サイトとストア、ゲーム媒体の記事から書いたもの。新しい発表があれば足す
- キャラクターを足すときは `content.json` の `characters` に足す。`avatar` と `art` は公式サイトの画像のファイル名、`keywords` が記事や動画の見出しに当たると、そのキャラのページに並ぶ（カタカナだけの名前は、前後がカタカナでないときだけ当たる）
- `config.json` の `links` … 攻略サイトなど

## 掲示板（コメント）

ragadmatome と同じ仕組みです（`site/api/` の PHP、保存はサーバーの `api/data/`）。名前は空欄なら「名無しの星臨者」。`>>12` と書くとそのレスへのリンクになります。

- NG ワードは `site/api/ngwords.json`。悪口・性的な言葉・差別語・アカウント売買／RMT／代行の勧誘、URL・メールアドレス・電話番号・LINE や Discord の ID 交換を弾く。カタカナ・半角・間に空白を入れた書き方も同じに扱う
- 同じ人は 20 秒に 1 回、1 時間に 10 回まで。10 人から通報されると自動で隠れる
- コメントを受け付けるページは `docs/data/works-index.json`（`pages.mjs` が書く）にあるものだけ

**管理画面** `https://azpromatome.gamelab.website/api/admin.php` を使うには、サーバーの `api/data/admin.php` に次の 1 行だけのファイルを置いてください（FTP の自動アップロードでは送りません）。

```php
<?php return 'ここにパスワード';
```

## 公開の設定

ragadmatome と同じです。GitHub Actions の cron は当てにならないので、ロリポップの cron から `repository_dispatch` を叩きます。trend-video-watcher の `tools/trigger-collect.php` の `REPOS` に `lumieregiurare-ops/azpromatome` を足してください（サーバーのファイルも差し替える）。収集では画像の縮小に sharp を使うので、ragadmatome と違って `npm ci` をしてから集めます。

**Secrets**: `LOLIPOP_FTP_SERVER` / `LOLIPOP_FTP_USER` / `LOLIPOP_FTP_PASSWORD`
**Variables**: `DEPLOY_TARGET` = `lolipop`、`LOLIPOP_SERVER_DIR` = サブドメインの公開ディレクトリ（末尾のスラッシュ必須）

サブドメインを変える場合は `config.json` の `site.url`、`site/robots.txt`、`scripts/make-og.py`（`DOMAIN`）を直してください。
