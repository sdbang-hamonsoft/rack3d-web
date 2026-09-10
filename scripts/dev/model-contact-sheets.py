"""Build review contact sheets from _preview.py PNGs (Pillow, dev-only)."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
root = Path('artifacts/renders')
font_path = '/System/Library/Fonts/Supplemental/Arial.ttf'
font = ImageFont.truetype(font_path, 24)
for kind in ['server', 'network']:
    out = Image.new('RGB', (1500, 700), '#101820')
    draw = ImageDraw.Draw(out)
    draw.text((28, 16), 'STANDARD ' + kind.upper() + ' | 1-10U', font=font, fill='white')
    for i in range(10):
        im = Image.open(root / f'standard-{kind}-{i+1}u.png').convert('RGB')
        im = im.crop((0, 230, 900, 980)).resize((284, 237))
        x, y = 12 + (i % 5) * 298, 66 + (i // 5) * 310
        out.paste(im, (x, y))
        draw.text((x+12, y+247), f'{i+1}U', font=font, fill='#c4d9e6')
    out.save(root / f'{kind}-catalog.png')
names = [('temperature-humidity-sensor', 'TEMP / HUMIDITY'), ('water-leak-sensor', 'WATER LEAK'),
         ('door', 'DOOR'), ('battery-rack', 'BATTERY RACK'), ('gas-suppression', 'GAS SUPPRESSION')]
out = Image.new('RGB', (900, 910), '#101820')
draw = ImageDraw.Draw(out)
draw.text((22, 16), 'STANDARD FACILITIES | Each view fitted separately', font=font, fill='white')
for i, (name, label) in enumerate(names):
    im = Image.open(root / f'{name}-standard.png').convert('RGB').resize((284, 347))
    x, y = (i % 3)*300+8, 65+(i//3)*410
    out.paste(im, (x, y))
    draw.text((x, y+360), label, font=ImageFont.truetype(font_path, 19), fill='#c4d9e6')
out.save(root / 'facilities-catalog.png')
