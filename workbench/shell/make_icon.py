from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# rounded square plate
r = int(S * 0.22)
plate = (0, 0, S - 1, S - 1)
d.rounded_rectangle(plate, radius=r, fill=(17, 20, 24, 255))

# diamond ring (the ◈ mark)
cx = cy = S / 2
outer = S * 0.30
inner = S * 0.155
def diamond(rad):
    return [(cx, cy - rad), (cx + rad, cy), (cx, cy + rad), (cx - rad, cy)]

ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
rd.polygon(diamond(outer), fill=(143, 187, 232, 255))
rd.polygon(diamond(inner), fill=(0, 0, 0, 0))
img.alpha_composite(ring)

# soft inner highlight diamond
rd2 = ImageDraw.Draw(img)
rd2.polygon(diamond(S * 0.075), fill=(143, 187, 232, 255))

img.save("resources/icon.png")
img.save("resources/icon.ico", sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("ok", img.size)
