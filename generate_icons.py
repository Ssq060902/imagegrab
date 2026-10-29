# -*- coding: utf-8 -*-
"""生成「图提取 ImageGrab」扩展图标：蓝紫渐变圆角方块 + 白色下载箭头"""
from PIL import Image, ImageDraw

BLUE = (79, 124, 255)
PURPLE = (139, 92, 246)
WHITE = (255, 255, 255, 255)

OUT_DIR = r"d:\damoxing\imagegrab\extension\icons"


def make_gradient(size):
    """生成对角线性渐变（蓝 → 紫）"""
    img = Image.new("RGBA", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size - 2)
            r = int(BLUE[0] + (PURPLE[0] - BLUE[0]) * t)
            g = int(BLUE[1] + (PURPLE[1] - BLUE[1]) * t)
            b = int(BLUE[2] + (PURPLE[2] - BLUE[2]) * t)
            px[x, y] = (r, g, b, 255)
    return img


def draw_icon(size):
    s = size
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # 1) 渐变底 + 圆角裁切
    grad = make_gradient(s)
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.24), fill=255)
    canvas.paste(grad, (0, 0), mask)

    # 2) 白色下载箭头（箭头杆 + 三角头）+ 底部托盘
    d = ImageDraw.Draw(canvas)
    cx = s / 2
    stem_w = max(2, int(s * 0.11))
    stem_top = int(s * 0.22)
    stem_bottom = int(s * 0.47)
    head_h = int(s * 0.17)
    head_half = int(s * 0.19)
    tray_y = int(s * 0.72)
    tray_w = max(2, int(s * 0.09))

    # 箭头杆
    d.rectangle([cx - stem_w / 2, stem_top, cx + stem_w / 2, stem_bottom], fill=WHITE)
    # 三角头
    d.polygon(
        [(cx - head_half, stem_bottom - head_h * 0.1),
         (cx + head_half, stem_bottom - head_h * 0.1),
         (cx, stem_bottom + head_h)],
        fill=WHITE,
    )
    # 托盘（圆角横条）
    tray_half = int(s * 0.24)
    d.rounded_rectangle(
        [cx - tray_half, tray_y, cx + tray_half, tray_y + tray_w],
        radius=tray_w / 2, fill=WHITE,
    )
    return canvas


import os

os.makedirs(OUT_DIR, exist_ok=True)
for size, name in [(16, "icon16.png"), (48, "icon48.png"), (128, "icon128.png")]:
    draw_icon(size).save(os.path.join(OUT_DIR, name))
    print("saved", name)
