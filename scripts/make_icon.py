"""Генерирует иконку Termuxx 1024x1024 (оригинальный дизайн).

Запуск: python3 scripts/make_icon.py <путь_к_png>
"""
import math
import sys

from PIL import Image, ImageDraw, ImageFilter

S = 1024
SS = 4  # суперсэмплинг для гладких краёв
W = S * SS


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def background():
    img = Image.new("RGB", (W, W))
    top = (16, 24, 38)
    bottom = (4, 7, 12)
    px = img.load()
    # Диагональный градиент + мягкое свечение в углу.
    small = Image.new("RGB", (256, 256))
    sp = small.load()
    for y in range(256):
        for x in range(256):
            t = (x * 0.35 + y * 0.65) / 255
            c = lerp(top, bottom, min(1, t))
            dx, dy = (x - 70) / 256, (y - 40) / 256
            glow = max(0, 1 - math.sqrt(dx * dx + dy * dy) * 1.6) ** 2
            c = lerp(c, (22, 70, 64), glow * 0.55)
            sp[x, y] = c
    return small.resize((W, W), Image.BICUBIC)


def rounded(draw, box, r, **kw):
    draw.rounded_rectangle(box, radius=r, **kw)


def main(out):
    img = background().convert("RGBA")

    # Тонкая сетка — намёк на моноширинный терминал.
    grid = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    g = ImageDraw.Draw(grid)
    step = 64 * SS
    for i in range(0, W, step):
        g.line([(i, 0), (i, W)], fill=(120, 200, 180, 10), width=SS)
        g.line([(0, i), (W, i)], fill=(120, 200, 180, 10), width=SS)
    img = Image.alpha_composite(img, grid)

    mint = (61, 220, 151)
    mint_hi = (150, 255, 210)

    # Шеврон «❯» — толстая стрелка из двух скруглённых штрихов.
    def chevron(layer_draw, color, width):
        cx, cy = 300 * SS, 512 * SS
        arm = 150 * SS
        p1 = (cx - arm * 0.55, cy - arm)
        p2 = (cx + arm * 0.55, cy)
        p3 = (cx - arm * 0.55, cy + arm)
        layer_draw.line([p1, p2, p3], fill=color, width=width, joint="curve")
        r = width // 2
        for p in (p1, p2, p3):
            layer_draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=color)

    # Курсор-блок.
    def cursor(layer_draw, color, grow=0):
        x0, y0 = 700 * SS - grow, 420 * SS - grow
        x1, y1 = 800 * SS + grow, 610 * SS + grow
        rounded(layer_draw, [x0, y0, x1, y1], 16 * SS + grow, fill=color)

    # Свечение.
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    chevron(gd, mint + (200,), 120 * SS)
    cursor(gd, mint + (200,), 10 * SS)
    glow = glow.filter(ImageFilter.GaussianBlur(60 * SS))
    img = Image.alpha_composite(img, glow)

    # Основные формы с вертикальным градиентом.
    shape = Image.new("L", (W, W), 0)
    sd = ImageDraw.Draw(shape)
    chevron(sd, 255, 84 * SS)
    cursor(sd, 255)
    fill = Image.new("RGBA", (W, W))
    fp = Image.new("RGBA", (1, 256))
    for y in range(256):
        fp.putpixel((0, y), lerp(mint_hi, mint, y / 255) + (255,))
    fill = fp.resize((W, W), Image.BICUBIC)
    img.paste(fill, (0, 0), shape)

    # Две маленькие «x» над курсором — фирменный знак «xx».
    xs = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    xd = ImageDraw.Draw(xs)
    for i, cx in enumerate((500, 610)):
        cx *= SS
        cy = 560 * SS
        a = 36 * SS
        col = (232, 246, 240, 240)
        xd.line([(cx - a, cy - a), (cx + a, cy + a)], fill=col, width=22 * SS)
        xd.line([(cx - a, cy + a), (cx + a, cy - a)], fill=col, width=22 * SS)
    img = Image.alpha_composite(img, xs)

    img = img.resize((S, S), Image.LANCZOS).convert("RGB")
    img.save(out, "PNG")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icon.png")
