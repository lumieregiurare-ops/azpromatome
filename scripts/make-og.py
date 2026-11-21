"""ロゴ・ファビコン・OGP 画像を作る。

ロゴはケモミミの女の子の顔（オリジナル）。図形を並べて描き、PNG/ICO は大きく描いてから縮小、
favicon.svg は同じ図形をそのまま SVG にする。公式の絵は使わない。
文字は Windows の游ゴシック（Bold）。無い環境ではフォントのパスを書き換えて使う。

使い方: python scripts/make-og.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
FONT = "C:/Windows/Fonts/YuGothB.ttc"
DOMAIN = "azpromatome.gamelab.website"

BLUE = (31, 111, 197)
BLUE_D = (22, 79, 143)

HAIR = "#bfe0ff"
HAIR_D = "#7fb0e6"
SKIN = "#ffe9de"
EYE = "#2a5fb8"
EYE_L = "#6fb6f5"

# 64x64 の座標で描く。("e", 色, x0, y0, x1, y1) は楕円、("p", 色, [点...]) は多角形
SHAPES = [
    ("e", "#ffd6e4", 0, 0, 64, 64),  # 背景の丸
    ("p", "#1d3f72", [(14, 64), (18, 52), (32, 49), (46, 52), (50, 64)]),  # 服
    ("p", "#ffffff", [(27, 50), (32, 56), (37, 50)]),  # 襟
    ("e", HAIR_D, 11, 13, 53, 60),  # 後ろ髪
    ("p", HAIR, [(12, 25), (11, 5), (27, 13)]),  # 左の耳
    ("p", HAIR, [(52, 25), (53, 5), (37, 13)]),  # 右の耳
    ("p", "#f6b3c6", [(14, 20), (13, 10), (23, 14)]),
    ("p", "#f6b3c6", [(50, 20), (51, 10), (41, 14)]),
    ("e", SKIN, 18, 19, 46, 50),  # 顔
    ("p", HAIR, [(15, 28), (16, 15), (25, 10), (39, 10), (48, 15), (49, 28), (45, 22), (42, 29), (38, 20), (33, 27), (29, 20), (24, 29), (20, 22)]),  # 前髪
    ("p", HAIR_D, [(31, 11), (33, 11), (32, 24)]),
    ("p", HAIR_D, [(24, 14), (25.5, 13.5), (23, 25)]),
    ("p", HAIR_D, [(40, 14), (38.5, 13.5), (41, 25)]),
    ("p", HAIR, [(16, 22), (13, 50), (21, 42), (20, 28)]),  # 左の横髪
    ("p", HAIR, [(48, 22), (51, 50), (43, 42), (44, 28)]),  # 右の横髪
    ("e", EYE, 22, 30, 29, 40),  # 目
    ("e", EYE, 35, 30, 42, 40),
    ("e", EYE_L, 23, 35, 28, 40),
    ("e", EYE_L, 36, 35, 41, 40),
    ("e", "#ffffff", 23, 31, 26, 34),
    ("e", "#ffffff", 36, 31, 39, 34),
    ("e", "#ffb7c5", 18, 40, 24, 43),  # ほお
    ("e", "#ffb7c5", 40, 40, 46, 43),
    ("p", "#d9546e", [(29.5, 44), (34.5, 44), (32, 46.5)]),  # 口
    ("p", "#ffd23f", [(45, 9), (46.6, 13), (51, 13.3), (47.6, 16), (48.8, 20.5), (45, 18), (41.2, 20.5), (42.4, 16), (39, 13.3), (43.4, 13)]),  # 星の髪飾り
]


def render(size):
    s = 8  # 大きく描いてから縮める
    big = 64 * s
    im = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for sh in SHAPES:
        if sh[0] == "e":
            _, c, x0, y0, x1, y1 = sh
            d.ellipse([x0 * s, y0 * s, x1 * s, y1 * s], fill=c)
        else:
            _, c, pts = sh
            d.polygon([(x * s, y * s) for x, y in pts], fill=c)
    # 丸の外に出た部分（服・耳）を切る
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, big - 1, big - 1], fill=255)
    out = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def svg():
    parts = []
    for sh in SHAPES:
        if sh[0] == "e":
            _, c, x0, y0, x1, y1 = sh
            parts.append(f'<ellipse cx="{(x0 + x1) / 2:g}" cy="{(y0 + y1) / 2:g}" rx="{(x1 - x0) / 2:g}" ry="{(y1 - y0) / 2:g}" fill="{c}"/>')
        else:
            _, c, pts = sh
            parts.append(f'<polygon points="{" ".join(f"{x:g},{y:g}" for x, y in pts)}" fill="{c}"/>')
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath><g clip-path="url(#c)">'
        + "".join(parts)
        + "</g></svg>\n"
    )


def icons():
    (SITE / "assets").mkdir(parents=True, exist_ok=True)
    render(96).save(SITE / "assets" / "logo-mark.png", optimize=True)  # ヘッダーで 40px 表示
    render(32).save(SITE / "favicon-32.png", optimize=True)
    render(256).save(SITE / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    touch = Image.new("RGBA", (180, 180), (255, 255, 255, 255))
    touch.alpha_composite(render(164), (8, 8))
    touch.convert("RGB").save(SITE / "apple-touch-icon.png", optimize=True)
    (SITE / "favicon.svg").write_text(svg(), encoding="utf-8")
    print("wrote icons")


def og():
    W, H = 1200, 630
    im = Image.new("RGBA", (W, H), (238, 242, 246, 255))
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 10], fill=BLUE + (255,))
    d.rectangle([0, 10, W, 170], fill=(255, 255, 255, 255))
    im.alpha_composite(render(128), (60, 26))
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
    d.rectangle([60, 270, 1140, 520], fill=(255, 255, 255, 255), outline=(221, 227, 234), width=2)
    d.rectangle([60, 270, 72, 520], fill=BLUE + (255,))
    f_mid = ImageFont.truetype(FONT, 44)
    d.text((110, 340), "ニュース・公式動画・キャラ・掲示板", font=f_mid, fill=(34, 34, 34), anchor="lm")
    tags = [("ニュース", (138, 138, 138)), ("ガチャ", (228, 0, 127)), ("キャンペーン", (240, 131, 0)), ("攻略", (46, 139, 87)), ("イベント", (123, 63, 181))]
    f_tag = ImageFont.truetype(FONT, 26)
    x = 110
    for t, c in tags:
        w = d.textlength(t, font=f_tag) + 26
        d.rectangle([x, 420, x + w, 460], fill=c)
        d.text((x + w / 2, 440), t, font=f_tag, fill=(255, 255, 255), anchor="mm")
        x += w + 12
    d.rectangle([0, 560, W, H], fill=(43, 52, 64, 255))
    d.text((60, 595), DOMAIN, font=f_small, fill=(230, 235, 240), anchor="lm")
    d.text((1140, 595), "非公式ファンサイト", font=f_small, fill=(170, 180, 190), anchor="rm")
    im.convert("RGB").save(SITE / "assets" / "og.png", optimize=True)
    print("wrote og.png")


if __name__ == "__main__":
    icons()
    og()
