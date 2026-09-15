from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def main() -> None:
    destination = Path("/tmp/aman-pdf-ocr-smoke")
    destination.mkdir(parents=True, exist_ok=True)

    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 52)
    image = Image.new("RGB", (1800, 280), "white")
    draw = ImageDraw.Draw(image)
    draw.text((70, 90), "AMAN OCR SMOKE 4827", fill="black", font=font)
    image.save(destination / "scan.png")
    image.save(destination / "scan.pdf", "PDF", resolution=150.0)


if __name__ == "__main__":
    main()
