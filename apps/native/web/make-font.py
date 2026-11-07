"""The browser build's fonts. A browser has no system fonts to fall back on, so the web
build carries what the desktop finds on the system: Noto Sans TC cut to the app's own
text, the place names and Big5's 5401 common characters (report text comes from the
network), and the few symbols neither Manrope nor Noto Sans TC has.

    python3 -m venv venv && venv/bin/pip install fonttools
    venv/bin/python web/make-font.py <dir with the downloaded fonts>

Downloads (SIL OFL 1.1, the licence beside the output):
    https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf
    https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans%5Bwdth%2Cwght%5D.ttf
    https://github.com/google/fonts/raw/main/ofl/notosansmath/NotoSansMath-Regular.ttf
"""

import pathlib
import subprocess
import sys

from fontTools.ttLib import TTFont

NATIVE = pathlib.Path(__file__).resolve().parent.parent
OUT = NATIVE / "assets/fonts/web"


def app_text() -> set:
    chars = set()
    files = list((NATIVE / "src").rglob("*.rs")) + [NATIVE / "assets/default.yml"]
    # The libraries beside the app draw text too, and the place names are trem-core's data.
    files += list((NATIVE / "crates").glob("*/src/**/*.rs"))
    files += list((NATIVE / "crates/trem-core/assets/data").glob("*.json"))
    for path in files:
        chars |= set(path.read_text(encoding="utf-8"))
    chars |= {chr(c) for c in TTFont(NATIVE / "assets/fonts/NotoSansTC.ttf").getBestCmap()}
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            try:
                chars.add(bytes([hi, lo]).decode("big5"))
            except UnicodeDecodeError:
                pass
    chars |= {chr(c) for c in range(0x3000, 0x3040)}
    chars |= {chr(c) for c in range(0xFF00, 0xFFF0)}
    chars |= {chr(c) for c in range(0x20, 0x7F)}
    return {c for c in chars if not c.isspace() or c == " "}


def subset(source: pathlib.Path, text: str, name: str) -> None:
    listing = OUT / f"{name}.txt"
    listing.write_text(text, encoding="utf-8")
    subprocess.run(
        [sys.executable, "-m", "fontTools.subset", str(source), f"--text-file={listing}",
         "--layout-features=*", f"--output-file={OUT / name}"],
        check=True,
    )
    listing.unlink()


def main() -> None:
    downloads = pathlib.Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)
    subset(downloads / "NotoSansTC[wght].ttf", "".join(sorted(app_text())), "NotoSansTC-web.ttf")
    subset(downloads / "NotoSans[wdth,wght].ttf", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻", "NotoSans-web.ttf")
    subset(downloads / "NotoSansMath-Regular.ttf", "𝖬", "NotoSansMath-web.ttf")


if __name__ == "__main__":
    main()
