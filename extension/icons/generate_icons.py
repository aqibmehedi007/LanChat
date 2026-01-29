"""
Generate OfficeMesh extension icons as PNG files.
Requires: pip install pillow
"""

from PIL import Image, ImageDraw
import os

# Icon sizes
SIZES = [16, 48, 128]

# Colors
BG_COLOR = (59, 130, 246)  # #3b82f6 (blue)
FG_COLOR = (255, 255, 255)  # white


def draw_icon(size):
    """Draw the OfficeMesh mesh network icon."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    scale = size / 128
    
    # Background rounded rectangle
    radius = int(20 * scale)
    draw.rounded_rectangle(
        [(0, 0), (size - 1, size - 1)],
        radius=radius,
        fill=BG_COLOR
    )
    
    # Node positions (scaled from 128x128 base)
    node_radius = int(14 * scale)
    line_width = max(1, int(6 * scale))
    
    # Node centers
    top_left = (int(38 * scale), int(48 * scale))
    top_right = (int(90 * scale), int(48 * scale))
    bottom = (int(64 * scale), int(92 * scale))
    
    # Draw connections (lines) first
    draw.line([top_left, top_right], fill=FG_COLOR, width=line_width)
    draw.line([top_left, bottom], fill=FG_COLOR, width=line_width)
    draw.line([top_right, bottom], fill=FG_COLOR, width=line_width)
    
    # Draw nodes (circles) on top
    for center in [top_left, top_right, bottom]:
        x, y = center
        draw.ellipse(
            [(x - node_radius, y - node_radius),
             (x + node_radius, y + node_radius)],
            fill=FG_COLOR
        )
    
    return img


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    
    for size in SIZES:
        img = draw_icon(size)
        filename = os.path.join(script_dir, f"icon{size}.png")
        img.save(filename, "PNG")
        print(f"Generated: {filename}")
    
    print("\nDone! Icons generated successfully.")


if __name__ == "__main__":
    main()
