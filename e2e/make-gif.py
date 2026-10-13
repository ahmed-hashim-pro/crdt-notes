"""Compose docs/converge.gif from the frames converge.spec.ts writes with RECORD=1.

    cd e2e && RECORD=1 npx playwright test && python3 make-gif.py
"""
import glob
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
frames = sorted(glob.glob(os.path.join(HERE, "frames", "*.txt")))
font_path = next((p for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                              "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"] if os.path.exists(p)), None)
big = ImageFont.truetype(font_path, 22) if font_path else ImageFont.load_default()
small = ImageFont.truetype(font_path, 15) if font_path else ImageFont.load_default()

out = []
for i, txt in enumerate(frames):
    stem = txt[:-4]
    a, b = Image.open(stem + "-a.png").convert("RGB"), Image.open(stem + "-b.png").convert("RGB")
    gap, bar, label = 10, 54, 26
    w, h = a.width + gap + b.width, bar + label + a.height
    img = Image.new("RGB", (w, h), "#24292f")
    d = ImageDraw.Draw(img)
    d.text((16, 14), f"{i + 1}. {open(txt).read().strip()}", fill="#ffffff", font=big)
    for x, name in [(0, "Browser A"), (a.width + gap, "Browser B")]:
        d.text((x + 12, bar + 4), name, fill="#d0d7de", font=small)
    img.paste(a, (0, bar + label))
    img.paste(b, (a.width + gap, bar + label))
    out.append(img.resize((w * 2 // 3, h * 2 // 3), Image.LANCZOS))

dst = os.path.join(HERE, "..", "docs", "converge.gif")
out[0].save(dst, save_all=True, append_images=out[1:], duration=3200, loop=0, optimize=True)
out[-1].save(os.path.join(HERE, "..", "docs", "converged.png"))
print(f"wrote {dst} ({len(out)} frames)")
