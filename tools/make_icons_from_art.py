# -*- coding: utf-8 -*-
"""从用户提供的 JsXray 美术图裁出方形主视觉, 生成 icons/icon{16,32,48,128}.png"""
from PIL import Image, ImageEnhance, ImageFilter
import os, sys

SRC = r"C:\Users\lzq28\.workbuddy\clipboard-images\clipboard-2026-09-17T13-12-06-991Z-80430559.png"
ICON_DIR = r"D:\HAPPY JS\icons"
PREVIEW = r"D:\HAPPY JS\icons\_preview.png"

img = Image.open(SRC).convert("RGB")
W, H = img.size
print("source size:", W, H)

# 裁剪参数(命令行可覆盖): 以眼睛为中心的正方形
cx, cy, side = float(sys.argv[1]) if len(sys.argv) > 1 else W * 0.49, \
               float(sys.argv[2]) if len(sys.argv) > 2 else H * 0.36, \
               int(sys.argv[3]) if len(sys.argv) > 3 else int(H * 0.72)

left = max(0, min(W - side, int(cx - side / 2)))
top = max(0, min(H - side, int(cy - side / 2)))
crop = img.crop((left, top, left + side, top + side))
print("crop box:", left, top, left + side, top + side)

# 轻微增强: 对比度+饱和度, 让小尺寸下更清晰
crop = ImageEnhance.Contrast(crop).enhance(1.08)
crop = ImageEnhance.Color(crop).enhance(1.15)

# 保存方形源图(供 README / 商店页复用)
crop.save(os.path.join(ICON_DIR, "source_eye.png"))

for s in (128, 48, 32, 16):
    ic = crop.resize((s, s), Image.LANCZOS)
    if s <= 48:
        ic = ic.filter(ImageFilter.UnsharpMask(radius=1.2, percent=90, threshold=2))
    ic.save(os.path.join(ICON_DIR, f"icon{s}.png"))
    print(f"icon{s}.png written")

# 预览图: 各尺寸排在原图旁
prev = Image.new("RGB", (W + side + 260, max(H, side) + 40), (10, 14, 12))
prev.paste(img, (0, 20))
prev.paste(crop, (W + 20, 20))
x = W + side + 40
for s in (128, 48, 32, 16):
    ic = crop.resize((s, s), Image.LANCZOS)
    prev.paste(ic, (x, 20))
    x += s + 24
prev.save(PREVIEW)
print("preview written")
