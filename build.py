"""
OfficeMesh — Desktop App Build Script
======================================
Run this from the repo root:

    python build.py

What it does:
  1. Generates app icons (PNG + ICO) from scratch using Pillow
  2. Installs desktop/node_modules if needed
  3. Runs electron-builder to produce the NSIS installer
  4. The installer will:
       - Install OfficeMesh to Program Files
       - Create a Desktop shortcut  ← automatically
       - Create a Start Menu shortcut
  5. Opens the dist/ folder when done

Requirements:
  - Python 3.8+
  - Node.js + npm
  - Pillow  (pip install pillow)
  - electron-builder is installed as a dev dependency (handled by npm install)
"""

import os
import sys
import subprocess
import shutil
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────
ROOT        = Path(__file__).parent.resolve()
DESKTOP_DIR = ROOT / "desktop"
ASSETS_DIR  = DESKTOP_DIR / "assets"
DIST_DIR    = DESKTOP_DIR / "dist"

# ── Step 1: Check dependencies ────────────────────────────────────

def check_deps():
    print("\n[1/5] Checking dependencies...")

    # Node.js
    if not shutil.which("node"):
        sys.exit("ERROR: Node.js not found. Install from https://nodejs.org")
    node_ver = subprocess.check_output(["node", "--version"], text=True).strip()
    print(f"  ✓ Node.js {node_ver}")

    # npm
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    if not shutil.which(npm_cmd):
        sys.exit("ERROR: npm not found.")
    npm_ver = subprocess.check_output([npm_cmd, "--version"], text=True).strip()
    print(f"  ✓ npm {npm_ver}")

    # Pillow
    try:
        from PIL import Image, ImageDraw, ImageFont
        print("  ✓ Pillow")
    except ImportError:
        sys.exit("ERROR: Pillow not installed. Run: python -m pip install pillow")

    # Python
    print(f"  ✓ Python {sys.version.split()[0]}")

# ── Step 2: Generate icons ────────────────────────────────────────

def generate_icons():
    print("\n[2/5] Generating app icons...")
    from PIL import Image, ImageDraw

    ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    def draw_icon(size):
        """Draw the OfficeMesh hexagon logo at the given pixel size."""
        img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        pad    = size * 0.08
        cx, cy = size / 2, size / 2
        r      = (size / 2) - pad

        # Background circle
        draw.ellipse([pad, pad, size - pad, size - pad],
                     fill=(26, 29, 46, 255))

        # Hexagon (⬡) — 6 points
        import math
        hex_pts = []
        for i in range(6):
            angle = math.radians(60 * i - 30)
            hex_pts.append((
                cx + r * 0.62 * math.cos(angle),
                cy + r * 0.62 * math.sin(angle),
            ))
        draw.polygon(hex_pts, outline=(232, 168, 56, 255), fill=None)
        # Draw outline with width by drawing slightly smaller filled + outline
        draw.polygon(hex_pts, outline=(232, 168, 56, 255))

        # Inner hexagon fill (amber, smaller)
        inner_pts = []
        for i in range(6):
            angle = math.radians(60 * i - 30)
            inner_pts.append((
                cx + r * 0.38 * math.cos(angle),
                cy + r * 0.38 * math.sin(angle),
            ))
        draw.polygon(inner_pts, fill=(232, 168, 56, 200))

        # Thicker outline — draw polygon border manually
        for i in range(len(hex_pts)):
            p1 = hex_pts[i]
            p2 = hex_pts[(i + 1) % len(hex_pts)]
            draw.line([p1, p2], fill=(232, 168, 56, 255), width=max(2, size // 32))

        return img

    # PNG icons for renderer/tray
    for size in [16, 32, 48, 64, 128, 256, 512]:
        img  = draw_icon(size)
        path = ASSETS_DIR / f"icon{size}.png"
        img.save(path, "PNG")
        print(f"  ✓ icon{size}.png")

    # Tray icon (22px, white-ish for dark taskbar)
    tray = draw_icon(22)
    tray.save(ASSETS_DIR / "tray-icon.png", "PNG")
    print("  ✓ tray-icon.png")

    # ICO file (multi-size, required by electron-builder for Windows)
    ico_sizes = [16, 32, 48, 64, 128, 256]
    ico_imgs  = [draw_icon(s) for s in ico_sizes]
    ico_path  = ASSETS_DIR / "icon.ico"
    ico_imgs[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_imgs[1:],
    )
    print("  ✓ icon.ico  (multi-size: 16/32/48/64/128/256)")

# ── Step 2b: Install Python server deps ──────────────────────────

def install_server_deps():
    print("\n[2b/5] Installing Python server dependencies...")
    reqs = ROOT / "server" / "requirements.txt"
    if not reqs.exists():
        print("  ⚠ requirements.txt not found, skipping")
        return
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(reqs), "--quiet"],
    )
    if result.returncode == 0:
        print("  ✓ aiohttp, python-socketio installed")
    else:
        print("  ⚠ pip install had warnings (may still work)")

# ── Step 3: npm install ───────────────────────────────────────────

def npm_install():
    print("\n[3/5] Installing Node dependencies...")
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    node_modules = DESKTOP_DIR / "node_modules" / "electron"

    if node_modules.exists():
        print("  ✓ node_modules already present, skipping install")
        return

    result = subprocess.run(
        [npm_cmd, "install"],
        cwd=DESKTOP_DIR,
    )
    if result.returncode != 0:
        sys.exit("ERROR: npm install failed.")
    print("  ✓ Dependencies installed")

# ── Step 4: Run electron-builder ─────────────────────────────────

def build_electron():
    print("\n[4/5] Building Electron installer...")
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"

    # Clean previous dist
    if DIST_DIR.exists():
        print("  Cleaning previous dist/...")
        shutil.rmtree(DIST_DIR)

    result = subprocess.run(
        [npm_cmd, "run", "build"],
        cwd=DESKTOP_DIR,
    )
    if result.returncode != 0:
        sys.exit("ERROR: electron-builder failed. Check output above.")

    # Find the produced installer
    installers = list(DIST_DIR.glob("*.exe"))
    if not installers:
        sys.exit("ERROR: No .exe found in dist/ after build.")

    installer = installers[0]
    size_mb   = installer.stat().st_size / (1024 * 1024)
    print(f"\n  ✓ Installer: {installer.name}  ({size_mb:.1f} MB)")
    return installer

# ── Step 5: Open dist folder ──────────────────────────────────────

def open_dist(installer_path):
    print("\n[5/5] Opening output folder...")
    if sys.platform == "win32":
        # Open Explorer and select the installer file
        subprocess.Popen(["explorer", "/select,", str(installer_path)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(installer_path.parent)])
    else:
        subprocess.Popen(["xdg-open", str(installer_path.parent)])

# ── Main ──────────────────────────────────────────────────────────

def main():
    print("=" * 55)
    print("  OfficeMesh Desktop — Build Script")
    print("=" * 55)

    check_deps()
    generate_icons()
    install_server_deps()
    npm_install()
    installer = build_electron()
    open_dist(installer)

    print("\n" + "=" * 55)
    print("  BUILD COMPLETE")
    print(f"  Installer: desktop/dist/{installer.name}")
    print()
    print("  The installer will:")
    print("    • Install OfficeMesh to Program Files")
    print("    • Create a Desktop shortcut automatically")
    print("    • Create a Start Menu entry")
    print("=" * 55)

if __name__ == "__main__":
    main()
