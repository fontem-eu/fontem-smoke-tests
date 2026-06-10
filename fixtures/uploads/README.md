# Upload smoke-test fixtures

Used by `STORY-UPLOAD-*` tests in `tests/smoke.spec.js`.

## Files

| File                  | Purpose                                                |
|-----------------------|--------------------------------------------------------|
| `good-photo.jpg`      | 1024×768 JPEG, ~80 KB — happy path                     |
| `good-chart.svg`      | Inline SVG `<rect>` + `<circle>`, no script — happy    |
| `evil-script.svg`     | SVG with `<script>`, `onclick`, `javascript:` href     |
| `bad-mime.png`        | A `.png` filename but the bytes are plain text         |
| `polyglot.jpg`        | A JPEG with `SECRET_PAYLOAD` appended after EOI        |
| `too-many-pixels.png` | 8001×100 PNG — over the per-side dimension cap         |
| `too-big.jpg`         | JPEG padded with trailing bytes past the 20 MB cap     |
| `eicar.com`           | The 68-byte EICAR test string (industry-standard AV    |
|                       | test fixture; NOT real malware). Triggers ClamAV.      |

The EICAR string is the EICAR Standard Anti-Virus Test File — the
ASCII string AV vendors agree to detect by convention. It is
explicitly not harmful and is the canonical way to verify an AV
pipeline works without shipping real malware. Reference:
https://en.wikipedia.org/wiki/EICAR_test_file
