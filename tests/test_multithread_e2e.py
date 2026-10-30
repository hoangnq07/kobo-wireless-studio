import http.server
import io
import json
import subprocess
import tempfile
import threading
import zipfile
from pathlib import Path

import shutil

ROOT_DIR = Path(__file__).resolve().parent.parent
DIST_HTML = ROOT_DIR / "dist" / "studio_standalone.html"
VENDOR_DIR = ROOT_DIR / "dist" / "kobo_overlay" / ".adds" / "tools" / "vendor"


def find_browser() -> str:
    for cand in (
        shutil.which("google-chrome"),
        shutil.which("chromium"),
        shutil.which("chrome"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ):
        if cand and Path(cand).exists():
            return str(cand)
    raise SystemExit("Headless Chromium / Chrome / Edge is required to run E2E tests.")


CHROME = find_browser()
# Minimal valid 8x8 grayscale JPEG for synthetic multi-page scanned PDF generation
TINY_GRAY_JPG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707070909"
    "080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30"
    "313434341f27393d38323c2e333432ffc0000b080008000801011100ffc4001f0000010501"
    "0101010101000000000000000102030405060708090a0bffc400b510000201030302040305"
    "0504040000017d01020300041105122131410613516107227114328191a1082342b1c11552"
    "d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a5354"
    "55565758595a636465666768696a737475767778797a838485868788898a92939495969798"
    "999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9"
    "dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00d2cf20ffd9"
)
j1 = TINY_GRAY_JPG
j2 = TINY_GRAY_JPG


def jpg_wh(b: bytes):
    i = 2
    while i < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        m = b[i + 1]
        if m in (0xC0, 0xC1, 0xC2):
            h = (b[i + 5] << 8) | b[i + 6]
            w = (b[i + 7] << 8) | b[i + 8]
            comps = b[i + 9]
            return w, h, ("/DeviceGray" if comps == 1 else "/DeviceRGB")
        l = (b[i + 2] << 8) | b[i + 3]
        i += 2 + l
    return 600, 800, "/DeviceRGB"


def build_test_pdf(num_pages: int, rich_text: bool = False) -> bytes:
    objs = []
    kids = []
    for p in range(1, num_pages + 1):
        c_id = 6 + (p - 1) * 2
        p_id = c_id + 1
        kids.append(f"{p_id} 0 R")
    kids_str = " ".join(kids)
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(f"<< /Type /Pages /Count {num_pages} /Kids [{kids_str}] >>".encode())
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    w1, h1, cs1 = jpg_wh(j1)
    w2, h2, cs2 = jpg_wh(j2)
    objs.append(
        f"<< /Type /XObject /Subtype /Image /Width {w1} /Height {h1} /ColorSpace {cs1} /BitsPerComponent 8 /Filter /DCTDecode /Length {len(j1)} >>\nstream\n".encode()
        + j1
        + b"\nendstream"
    )
    objs.append(
        f"<< /Type /XObject /Subtype /Image /Width {w2} /Height {h2} /ColorSpace {cs2} /BitsPerComponent 8 /Filter /DCTDecode /Length {len(j2)} >>\nstream\n".encode()
        + j2
        + b"\nendstream"
    )

    for p in range(1, num_pages + 1):
        im_ref = 4 if (p % 2 == 1) else 5
        if rich_text:
            lines = [f"BT /F1 18 Tf 72 750 Td (Chapter {p} Multi Core Engine) Tj ET"]
            for ln in range(20):
                y = 710 - ln * 26
                lines.append(
                    f"BT /F1 11 Tf 72 {y} Td (Sentence one on line {ln+1} of page {p}. Sentence two verifies fast worker pool text extraction!) Tj ET"
                )
            st = ("\n".join(lines)).encode("latin1")
        else:
            st = b"q 430 0 0 610 82 115 cm /Im0 Do Q\n"
        c_id = 6 + (p - 1) * 2
        objs.append(f"<< /Length {len(st)} >>\nstream\n".encode() + st + b"\nendstream")
        objs.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 {im_ref} 0 R >> >> /Contents {c_id} 0 R >>".encode()
        )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offs = [0]
    for idx, body in enumerate(objs, 1):
        offs.append(len(out))
        out.extend(f"{idx} 0 obj\n".encode() + body + b"\nendobj\n")
    xref_pos = len(out)
    out.extend(f"xref\n0 {len(objs)+1}\n0000000000 65535 f \n".encode())
    for o in offs[1:]:
        out.extend(f"{o:010d} 00000 n \n".encode())
    out.extend(f"trailer\n<< /Size {len(objs)+1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode())
    return bytes(out)


scan_pdf_bytes = build_test_pdf(200, rich_text=False)
text_pdf_bytes = build_test_pdf(64, rich_text=True)

epub_buf = io.BytesIO()
with zipfile.ZipFile(epub_buf, "w") as zf:
    zf.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    zf.writestr(
        "META-INF/container.xml",
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    )
    zf.writestr(
        "OEBPS/style.css",
        "body { color: #666666; line-height: 1.5; } p { color: rgb(90,90,90); margin: 0; }",
    )
    zf.writestr("OEBPS/cover.jpg", j1, compress_type=zipfile.ZIP_STORED)
    for c in range(1, 25):
        xh = f"""<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chap {c}</title><link rel="stylesheet" href="style.css"/></head>
<body>
  <h1>Chương {c}&nbsp;&mdash;&nbsp;Kiểm thử Đa Luồng</h1>
  <p>Câu thứ nhất của chương {c}! Câu thứ hai có ký tự &amp; và dấu &ldquo;ngoặc kép&rdquo;.<br>Dòng sau thẻ br tự đóng.</p>
  <img src="cover.jpg" alt="test">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="0" y="5">Do not wrap SVG</text></svg>
  <table><tr><td>Ô bảng 1. Câu hai.</td></tr></table>
</body></html>"""
        zf.writestr(f"OEBPS/ch{c}.xhtml", xh, compress_type=zipfile.ZIP_DEFLATED)
epub_bytes = epub_buf.getvalue()

vendor_hits = {}
report_result = {}
done_event = threading.Event()

studio_html = DIST_HTML.read_text(encoding="utf-8")
test_driver_js = """
<script>
window.addEventListener('load', async () => {
  const report = { errors: [] };
  window.onerror = (m, s, l) => report.errors.push(m + ' @' + l);
  try {
    report.hwCores = navigator.hardwareConcurrency;
    report.offscreen = supportsOffscreenPdfWorkers();

    const scanBlob = await (await fetch('/__test/scan.pdf')).blob();
    const scanFile = new File([scanBlob], 'HeavyScanBook.pdf', { type: 'application/pdf' });

    // Warm up vendor fetch once so benchmark compares pure 1-thread vs 8-thread CPU execution!
    await getPdfPoolWorkerUrl();
    await ensurePdfJsMainThread();

    // 1) Benchmark 1-thread flatten (200 pages)
    document.getElementById('workerThreads').value = '1';
    const t1_0 = performance.now();
    const res1 = await maybeConvertFileForKobo(scanFile, '/Books', 'pdf_flatten', () => {}, true);
    const ms1 = Math.round(performance.now() - t1_0);

    // 2) Benchmark 8-thread flatten cold (200 pages)
    document.getElementById('workerThreads').value = '8';
    let lastSpeed = '';
    const t8_0 = performance.now();
    const res8 = await maybeConvertFileForKobo(scanFile, '/Books', 'pdf_flatten', (msg, pct, sp) => {
      if (sp && sp.includes('trang/s')) lastSpeed = sp;
    }, true);
    const ms8Cold = Math.round(performance.now() - t8_0);

    // 2B) Benchmark 8-thread flatten warm (200 pages - warm pool reused!)
    const t8w_0 = performance.now();
    await maybeConvertFileForKobo(scanFile, '/Books', 'pdf_flatten', (msg, pct, sp) => {
      if (sp && sp.includes('trang/s')) lastSpeed = sp;
    }, true);
    const ms8Warm = Math.round(performance.now() - t8w_0);

    // Verify flattened 8-thread PDF opens cleanly in pdfjsLib and has all 48 pages
    const flatAb = await res8.file.arrayBuffer();
    const verDoc = await window.pdfjsLib.getDocument({ data: new Uint8Array(flatAb) }).promise;
    const flatPages = verDoc.numPages;
    const vpCheck = (await verDoc.getPage(24)).getViewport({ scale: 1 });
    await verDoc.destroy();

    // 3) Test 8-thread Text PDF -> .kepub.epub + strict XML validation
    const txtPdfBlob = await (await fetch('/__test/text.pdf')).blob();
    const txtPdfFile = new File([txtPdfBlob], 'CleanTextBook.pdf', { type: 'application/pdf' });
    const resTxtPdf = await maybeConvertFileForKobo(txtPdfFile, '/Books', 'auto', () => {}, true);
    await ensureJSZip();
    const zTxt = await window.JSZip.loadAsync(await resTxtPdf.file.arrayBuffer());
    let txtXmlErrors = 0;
    let txtSpanCount = 0;
    for (const k of Object.keys(zTxt.files)) {
      if (k.endsWith('.xhtml')) {
        const s = await zTxt.files[k].async('string');
        const d = new DOMParser().parseFromString(s, 'application/xhtml+xml');
        if (d.querySelector('parsererror')) txtXmlErrors++;
        txtSpanCount += d.getElementsByClassName('koboSpan').length;
      }
    }

    // 4) Test 8-thread messy EPUB -> .kepub.epub + strict XML validation
    const epubBlob = await (await fetch('/__test/messy.epub')).blob();
    const epubFile = new File([epubBlob], 'MessyBook.epub', { type: 'application/epub+zip' });
    const resEpub = await maybeConvertFileForKobo(epubFile, '/Books', 'auto', () => {}, true);
    const epubOutAb = await resEpub.file.arrayBuffer();
    const epubHeaderAscii = new TextDecoder().decode(new Uint8Array(epubOutAb, 30, 28));
    const zEp = await window.JSZip.loadAsync(epubOutAb);
    let epubXmlErrors = 0;
    let epubSpanCount = 0;
    let svgUntouched = false;
    let cssCleaned = false;
    for (const k of Object.keys(zEp.files)) {
      if (k.endsWith('.css')) {
        const c = await zEp.files[k].async('string');
        cssCleaned = !c.includes('#666666') && !c.includes('rgb(90,90,90)');
      }
      if (k.endsWith('.xhtml')) {
        const s = await zEp.files[k].async('string');
        const d = new DOMParser().parseFromString(s, 'application/xhtml+xml');
        if (d.querySelector('parsererror')) {
          epubXmlErrors++;
          report.errors.push('XML error in ' + k + ': ' + d.querySelector('parsererror').textContent);
        }
        epubSpanCount += d.getElementsByClassName('koboSpan').length;
        const svgEl = d.getElementsByTagName('svg')[0];
        if (svgEl && svgEl.getElementsByClassName('koboSpan').length === 0) svgUntouched = true;
      }
    }

    // 5) Test instant Cancel mid-flight on 8 workers
    const tCancel0 = performance.now();
    let cancelCaught = false;
    const pCancel = maybeConvertFileForKobo(scanFile, '/Books', 'pdf_flatten', (msg, pct) => {
      if (pct && pct >= 8 && !cancelConvertRequested) requestCancelConvert();
    }, true);
    try { await pCancel; } catch (ce) { cancelCaught = String(ce.message).includes('Đã hủy'); }
    const cancelMs = Math.round(performance.now() - tCancel0);
    cancelConvertRequested = false;

    Object.assign(report, {
      ok: true,
      ms1Thread: ms1,
      ms8Cold: ms8Cold,
      ms8Warm: ms8Warm,
      speedupCold: +(ms1 / Math.max(1, ms8Cold)).toFixed(2),
      speedupWarm: +(ms1 / Math.max(1, ms8Warm)).toFixed(2),
      lastSpeedLabel: lastSpeed,
      flatOutName: res8.file.name,
      flatSummary: res8.summary,
      flatOutBytes: res8.file.size,
      flatPages,
      flatPage24Size: [Math.round(vpCheck.width), Math.round(vpCheck.height)],
      txtPdfSummary: resTxtPdf.summary,
      txtXmlErrors,
      txtSpanCount,
      epubSummary: resEpub.summary,
      epubHeaderAscii,
      epubXmlErrors,
      epubSpanCount,
      svgUntouched,
      cssCleaned,
      cancelCaught,
      cancelMs,
      leakedWorkers: activeWorkers.size
    });
  } catch (err) {
    report.ok = false;
    report.fatal = err && err.stack ? err.stack : String(err);
  }
  await fetch('/__report', { method: 'POST', body: JSON.stringify(report) });
});
</script>
"""

last_body_idx = studio_html.rfind("</body>")
test_html_bytes = (studio_html[:last_body_idx] + test_driver_js + "\n" + studio_html[last_body_idx:]).encode("utf-8")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(test_html_bytes)
        elif self.path.startswith("/api/list"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true,"dir":"/Books","items":[]}')
        elif self.path.startswith("/vendor/"):
            vname = self.path.split("/vendor/")[1].split("?")[0]
            vendor_hits[vname] = vendor_hits.get(vname, 0) + 1
            data = (VENDOR_DIR / vname).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/__test/scan.pdf":
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.end_headers()
            self.wfile.write(scan_pdf_bytes)
        elif self.path == "/__test/text.pdf":
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.end_headers()
            self.wfile.write(text_pdf_bytes)
        elif self.path == "/__test/messy.epub":
            self.send_response(200)
            self.send_header("Content-Type", "application/epub+zip")
            self.end_headers()
            self.wfile.write(epub_bytes)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/__report":
            ln = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(ln)
            report_result.update(json.loads(body.decode("utf-8")))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            done_event.set()


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()

with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as udir:
    proc = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            f"--user-data-dir={udir}",
            f"http://127.0.0.1:{port}/",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    done_event.wait(timeout=45)
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()

srv.shutdown()
print("VENDOR HTTP HITS:", vendor_hits)
print("E2E REPORT:", json.dumps(report_result, indent=2, ensure_ascii=False))
assert report_result.get("ok") and not report_result.get("errors"), f"E2E test failed: {report_result}"
