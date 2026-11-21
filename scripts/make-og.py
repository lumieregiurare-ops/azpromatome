"""ロゴ・ファビコン・OGP 画像を作る。

ロゴは 16x16 のドット絵の星と双葉（オリジナル）を拡大したもの。公式の絵は使わない。
文字は Windows の游ゴシック（Bold）。無い環境ではフォントのパスを書き換えて使う。

使い方: python scripts/make-og.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
FONT = "C:/Windows/Fonts/YuGothB.ttc"
DOMAIN = "azpromatome.gamelab.website"

# B=青の地 Y=星 O=星の影 G=双葉 D=双葉の影 W=光
SPRITE = [
    "BBBBBBBBBBBBBBBB",
    "BBBBBBBYBBBBBBBB",
    "BBBBBBYYYBBBBBBB",
    "BBBBBBYWYBBBBBBB",
    "BBYYYYYYYYYYYBBB",
    "BBBYYYYYYYYOBBBB",
    "BBBBYYYYYYOBBBBB",
    "BBBBYYYOYYOBBBBB",
    "BBBYYYOBOYYOBBBB",
    "BBBYOOBBBOOOBBBB",
    "BBBBBBBGBBBBBBBB",
    "BBGGGBBGBBGGGBBB",
    "BBGGGGBGBGGGGBBB",
    "BBBDGGGGGGGDBBBB",
    "BBBBBDDGDDBBBBBB",
    "BBBBBBBGBBBBBBBB",
]
COLORS = {
    "B": (31, 111, 197, 255),
    "Y": (255, 214, 64, 255),
    "O": (230, 150, 30, 255),
    "W": (255, 250, 220, 255),
    "G": (110, 200, 90, 255),
    "D": (60, 150, 70, 255),
}
BLUE = (31, 111, 197)
BLUE_D = (22, 79, 143)


def sprite(scale):
    im = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    for y, row in enumerate(SPRITE):
        for x, c in enumerate(row):
            if c in COLORS:
                im.putpixel((x, y), COLORS[c])
    return im.resize((16 * scale, 16 * scale), Image.NEAREST)


def icons():
    (SITE / "assets").mkdir(parents=True, exist_ok=True)
    sprite(5).save(SITE / "assets" / "logo-mark.png", optimize=True)  # 80x80（ヘッダーで 40px 表示）
    sprite(2).save(SITE / "favicon-32.png", optimize=True)
    sprite(16).save(SITE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    sprite(11).resize((180, 180), Image.NEAREST).convert("RGB").save(SITE / "apple-touch-icon.png", optimize=True)
    rects = []
    for y, row in enumerate(SPRITE):
        for x, c in enumerate(row):
            r, g, b, _ = COLORS[c]
            rects.append(f'<rect x="{x}" y="{y}" width="1" height="1" fill="#{r:02x}{g:02x}{b:02x}"/>')
    (SITE / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">' + "".join(rects) + "</svg>\n",
        encoding="utf-8",
    )
    print("wrote icons")


def og():
    W, H = 1200, 630
    im = Image.new("RGBA", (W, H), (238, 242, 246, 255))
    d = ImageDraw.Draw(im)
    # 上の帯（サイトのヘッダーと同じ並び）
    d.rectangle([0, 0, W, 10], fill=BLUE + (255,))
    d.rectangle([0, 10, W, 170], fill=(255, 255, 255, 255))
    im.alpha_composite(sprite(8), (60, 26))
    f_logo = ImageFont.truetype(FONT, 76)
    f_small = ImageFont.truetype(FONT, 28)
    d.text((210, 78), "アズプロ速報", font=f_logo, fill=BLUE_D, anchor="lm")
    d.text((214, 140), "アズールプロミリア情報まとめ", font=f_small, fill=(90, 90, 90), anchor="lm")
    d.rectangle([0, 170, W, 230], fill=BLUE + (255,))
    f_nav = ImageFont.truetype(FONT, 28)
    x = 60
    for t in ["ニュース", "公式動画", "キャラクター", "基本情報", "掲示板"]:
        d.text((x, 200), t, font=f_nav, fill=(255, 255, 255), anchor="lm")
        x += d.textlength(t, font=f_nav) + 48

    # 本文の白い枠
    d.rectangle([60, 270, 1140, 520], fill=(255, 255, 255, 255), outline=(221, 227, 234), width=2)
    d.rectangle([60, 270, 72, 520], fill=BLUE + (255,))
    f_mid = ImageFont.truetype(FONT, 38)
    d.text((110, 330), "ゲーム媒体の記事・公式動画・アプリの更新を", font=f_mid, fill=(34, 34, 34), anchor="lm")
    d.text((110, 392), "30分おきに集めています", font=f_mid, fill=(34, 34, 34), anchor="lm")
    tags = [("ニュース", (138, 138, 138)), ("ガチャ", (228, 0, 127)), ("キャンペーン", (240, 131, 0)), ("攻略", (46, 139, 87)), ("イベント", (123, 63, 181))]
    f_tag = ImageFont.truetype(FONT, 24)
    x = 110
    for t, c in tags:
        w = d.textlength(t, font=f_tag) + 24
        d.rectangle([x, 444, x + w, 480], fill=c)
        d.text((x + w / 2, 462), t, font=f_tag, fill=(255, 255, 255), anchor="mm")
        x += w + 12

    d.rectangle([0, 560, W, H], fill=(43, 52, 64, 255))
    d.text((60, 595), DOMAIN, font=f_small, fill=(230, 235, 240), anchor="lm")
    d.text((1140, 595), "非公式ファンサイト", font=f_small, fill=(170, 180, 190), anchor="rm")
    im.convert("RGB").save(SITE / "assets" / "og.png", optimize=True)
    print("wrote og.png")


if __name__ == "__main__":
    icons()
    og()
