from pathlib import Path
import shutil
import zipfile

SOURCE_ROOT = Path(__file__).resolve().parent
OUTPUT_ROOT = Path.cwd() / "four-flavours-pos"
OUTPUT_ZIP = Path.cwd() / "four-flavours-pos.zip"

if OUTPUT_ROOT.exists():
    shutil.rmtree(OUTPUT_ROOT)
if OUTPUT_ZIP.exists():
    OUTPUT_ZIP.unlink()

for src in SOURCE_ROOT.rglob("*"):
    if not src.is_file():
        continue
    rel = src.relative_to(SOURCE_ROOT)
    if rel.name == Path(__file__).name:
        continue
    if rel.parts and rel.parts[0] == OUTPUT_ROOT.name:
        continue
    dst = OUTPUT_ROOT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(src.read_bytes())

(OUTPUT_ROOT / "assets" / "images").mkdir(parents=True, exist_ok=True)
(OUTPUT_ROOT / "assets" / "icons").mkdir(parents=True, exist_ok=True)

with zipfile.ZipFile(OUTPUT_ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    for path in OUTPUT_ROOT.rglob("*"):
        if path.is_file():
            z.write(path, path.relative_to(OUTPUT_ROOT.parent))

print(f"Created: {OUTPUT_ROOT.resolve()}")
print(f"ZIP:     {OUTPUT_ZIP.resolve()}")
