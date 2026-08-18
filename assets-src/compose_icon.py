"""合成 DeepSeek Harness 桌面客户端图标:深蓝圆角方底 + 青色渐变鲸鱼 + 辉光"""
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
RADIUS = int(SIZE * 0.22)  # 圆角半径

BG_TOP = (16, 34, 66)      # #102242 深海军蓝
BG_BOTTOM = (8, 24, 48)    # #081830
WHALE_TOP = (125, 211, 252)   # #7dd3fc 亮青
WHALE_BOTTOM = (14, 165, 233) # #0ea5e9 品牌青
GLOW_COLOR = (34, 211, 238)   # #22d3ee


def vertical_gradient(size, top, bottom):
    img = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / (size - 1)
        img.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img.resize((size, size))


def rounded_mask(size, radius):
    mask = Image.new('L', (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def main():
    # --- 背景: 竖向渐变 + 圆角 ---
    bg = vertical_gradient(SIZE, BG_TOP, BG_BOTTOM).convert('RGBA')

    # 中心柔和辉光, 让底色不太闷
    glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([SIZE * 0.18, SIZE * 0.14, SIZE * 0.82, SIZE * 0.78],
               fill=(*GLOW_COLOR, 46))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    bg = Image.alpha_composite(bg, glow)

    mask = rounded_mask(SIZE, RADIUS)
    bg.putalpha(mask)

    # --- 鲸鱼: 取 alpha, 染成竖向青色渐变 ---
    whale = Image.open('whale-1024.png').convert('RGBA')
    alpha = whale.split()[3]
    tint = vertical_gradient(SIZE, WHALE_TOP, WHALE_BOTTOM).convert('RGBA')
    tint.putalpha(alpha)

    # 缩放到画布 62%, 居中略偏上
    w = int(SIZE * 0.62)
    tint = tint.resize((w, w), Image.LANCZOS)
    x = (SIZE - w) // 2
    y = int((SIZE - w) * 0.46)

    # 鲸鱼辉光(放大模糊的一层, 低透明度)
    halo = tint.copy()
    ha = halo.split()[3].point(lambda v: int(v * 0.55))
    halo.putalpha(ha)
    halo = halo.filter(ImageFilter.GaussianBlur(28))
    bg.alpha_composite(halo, (x, y))

    bg.alpha_composite(tint, (x, y))

    # --- 输出 ---
    bg.save('../build/icon.png')
    bg.save('../resources/icon.png')
    bg.save('icon-1024.png')
    bg.save('../build/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print('icon.png / icon.ico / resources/icon.png 已生成')


if __name__ == '__main__':
    main()
