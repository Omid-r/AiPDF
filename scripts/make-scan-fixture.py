"""Build a realistic *scanned* PDF fixture: page images only, zero text operators.

Used to test the Direct Editor's OCR path — the case where a page has no
extractable text at all and nothing is editable until it has been recognised.
"""
import os
import random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '.fixtures')
os.makedirs(OUT, exist_ok=True)

DPI = 300
W, H = int(8.27 * DPI), int(11.69 * DPI)  # A4

LINES = [
    ("SCANNED INVOICE", 34, True),
    ("", 12, False),
    ("Invoice number:  INV-2026-0148", 15, False),
    ("Date of issue:   14 October 2026", 15, False),
    ("Customer:        Manjay Dangol", 15, False),
    ("", 12, False),
    ("This page contains no text objects at all. It is a picture of a", 15, False),
    ("printed document, exactly as a flatbed scanner or a phone camera", 15, False),
    ("would produce it. Any editor that only looks for text operators", 15, False),
    ("will find nothing here and will appear to be broken.", 15, False),
    ("", 12, False),
    ("Description                              Qty        Amount", 15, True),
    ("Direct Editor integration                  1        1,250.00", 15, False),
    ("Offline OCR engine                         1          480.00", 15, False),
    ("", 12, False),
    ("Total due:                                            1,730.00", 16, True),
]

def find_font(size, bold):
    """Best available TrueType face, or the built-in bitmap font."""
    candidates = []
    windir = os.environ.get('WINDIR', r'C:\Windows')
    fonts = os.path.join(windir, 'Fonts')
    names = (['arialbd.ttf', 'seguisb.ttf', 'DejaVuSans-Bold.ttf'] if bold
             else ['arial.ttf', 'segoeui.ttf', 'DejaVuSans.ttf'])
    for n in names:
        p = os.path.join(fonts, n)
        if os.path.exists(p):
            candidates.append(p)
    for p in candidates:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()

def render(seed=7):
    rnd = random.Random(seed)
    img = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(img)
    y = int(0.9 * DPI)
    x = int(0.9 * DPI)
    for text, pt, bold in LINES:
        size = max(8, int(pt * DPI / 72))
        font = find_font(size, bold)
        if text:
            # Tiny per-line skew: a sheet is never perfectly square on the glass.
            d.text((x + rnd.randint(-2, 2), y + rnd.randint(-1, 1)), text, font=font, fill=18)
        y += int(size * 1.65)
    # Scanner artefacts: soft focus, speckle, and a slight grey cast.
    img = img.filter(ImageFilter.GaussianBlur(0.7))
    px = img.load()
    for _ in range(W * H // 900):
        i, j = rnd.randrange(W), rnd.randrange(H)
        v = px[i, j]
        px[i, j] = max(0, min(255, v + rnd.randint(-38, 24)))
    return img.convert('RGB')

if __name__ == '__main__':
    img = render()
    path = os.path.join(OUT, 'scan-page.png')
    img.save(path, 'PNG')
    print('wrote', path, img.size)
