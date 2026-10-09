"""Declare what no package database in this image lists, for its SBOM: the
browsers and ffmpeg Playwright downloads into PLAYWRIGHT_BROWSERS_PATH.
Each version is read from the binary itself, so the declaration cannot drift
from what is installed.

docker-build-sign adds the result to the SBOM and requires every executable
file to be covered. Usage: sbom-declare.py > declared.json
"""
import glob
import json
import os
import subprocess
import sys

ROOT = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright")
# (directory glob, binary inside it, component name, how to read the version,
#  NVD product). NVD files Chromium advisories under google:chrome.
BROWSERS = [
    ("chromium-*", "chrome-linux*/chrome", "chrome-for-testing", "--version", "google:chrome"),
    ("chromium_headless_shell-*", "chrome-headless-shell-linux*/chrome-headless-shell",
     "chrome-headless-shell", "--version", "google:chrome"),
    ("ffmpeg-*", "ffmpeg-linux", "ffmpeg", "-version", "ffmpeg:ffmpeg"),
]


def version(binary, flag):
    """'Google Chrome for Testing 151.0.7922.34' -> 151.0.7922.34;
    'ffmpeg version n7.0.1-playwright-build-1011 ...' -> 7.0.1."""
    first = subprocess.run([binary, flag], capture_output=True, text=True, check=True).stdout.splitlines()[0]
    words = first.split()
    raw = words[2] if words[0] == "ffmpeg" else words[-1]
    return raw.lstrip("n").split("-")[0]


def main():
    comps = []
    for pattern, binary, name, flag, cpe in BROWSERS:
        for directory in sorted(glob.glob(os.path.join(ROOT, pattern))):
            found = glob.glob(os.path.join(directory, binary))
            if not found:
                sys.exit(f"sbom-declare: {directory} has no {binary}")
            v = version(found[0], flag)
            comps.append({"name": name, "version": v, "purl": f"pkg:generic/{name}@{v}",
                          "cpe": f"cpe:2.3:a:{cpe}:{v}:*:*:*:*:*:*:*", "paths": [directory + "/"]})
    json.dump({"components": comps}, sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
