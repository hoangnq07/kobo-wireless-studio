import shutil
import os
import re
import subprocess
import unicodedata
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT_DIR / "src"
DIST_DIR = ROOT_DIR / "dist"
BASE_HTML = (SRC_DIR / "studio_base.html").read_text(encoding="utf-8")
CONVERTER_JS = (SRC_DIR / "converter_engine.js").read_text(encoding="utf-8")

# 1. Inject extra CSS for multi-threaded converter bar, thread selector, cancel button, and optimize action pill
EXTRA_CSS = """
/* Auto-Converter Multi-Thread Studio Controls */
.badge-proto { white-space: nowrap; flex-shrink: 0; }
.conv-bar {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 10px 12px;
  margin-bottom: 11px;
  border-radius: var(--radius-md);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  min-width: 0;
  max-width: 100%;
}
.conv-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.conv-title-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  min-width: 0;
}
.conv-select {
  padding: 6px 9px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--ink);
  font-size: 12px;
  font-family: inherit;
  font-weight: 550;
  outline: none;
  cursor: pointer;
  min-width: 0;
  max-width: 100%;
  text-overflow: ellipsis;
}
.conv-select.mode-select {
  width: 100%;
}
.conv-select.thread-select {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.conv-select:focus { border-color: var(--accent); }
.btn.opt-btn {
  color: var(--accent);
  border-color: var(--accent-border);
  background: var(--accent-soft);
}
.btn.opt-btn:hover {
  background: var(--accent);
  color: #ffffff;
  border-color: var(--accent);
}
.prog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  padding-top: 1px;
}
th.col-acts { width: 234px; }
@media (max-width: 680px) {
  th.col-acts { width: 146px; }
}
.modal-opt-row {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.chk-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink);
  cursor: pointer;
}
.chk-row input { width: 15px; height: 15px; accent-color: var(--accent); cursor: pointer; }
"""

html = BASE_HTML.replace("</style>", EXTRA_CSS + "\n</style>", 1)

# 2. Inject crisp vector SVG icons (#ico-zap, #ico-cpu) into sprite
EXTRA_SVGS = """  <symbol id="ico-zap" viewBox="0 0 24 24">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
  </symbol>
  <symbol id="ico-cpu" viewBox="0 0 24 24">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
    <rect x="9" y="9" width="6" height="6"/>
    <line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/>
    <line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/>
    <line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/>
    <line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>
  </symbol>
</svg>"""
html = html.replace("</svg>", EXTRA_SVGS, 1)

# 3. Upgrade HTTP Upload Card with Multi-Thread Auto-Convert Bar, updated chips, and cancelable conversion progress
OLD_UPLOAD_INNER = """      <div class="card-hdr">
        <h2 class="card-title">
          <svg class="ico" style="color:var(--accent)"><use href="#ico-upload"/></svg>
          Tải sách lên qua trình duyệt
        </h2>
        <span class="badge-proto">HTTP :8080</span>
      </div>

      <input type="file" id="fileInput" multiple style="display:none">
      <div class="dropzone" id="dropzone" onclick="document.getElementById('fileInput').click()">
        <div class="dz-icon-wrap">
          <svg class="ico ico-xl"><use href="#ico-upload"/></svg>
        </div>
        <div class="dz-headline">Kéo thả tệp vào đây hoặc <span>chọn từ thiết bị</span></div>
        <div class="dz-sub">Truyền luồng trực tiếp qua mạng LAN nội bộ, không giới hạn dung lượng tệp</div>
        <div class="dz-formats">
          <span class="fmt-chip">.KEPUB.EPUB</span>
          <span class="fmt-chip">.EPUB</span>
          <span class="fmt-chip">.PDF</span>
          <span class="fmt-chip">.MOBI</span>
          <span class="fmt-chip">.TTF / .OTF</span>
        </div>
        <div class="target-chip">Thư mục đích hiện tại: <code id="uploadTargetLabel">/Books</code></div>
      </div>

      <div class="prog-box" id="progBox">
        <div class="prog-meta">
          <span id="progName">Đang chuẩn bị tải lên...</span>
          <span class="prog-speed" id="progSpeed">0%</span>
        </div>
        <div class="prog-track"><div class="prog-bar" id="progBar"></div></div>
      </div>"""

NEW_UPLOAD_INNER = """      <div class="card-hdr">
        <h2 class="card-title">
          <svg class="ico" style="color:var(--accent)"><use href="#ico-zap"/></svg>
          Tải sách lên &amp; Tối ưu E-Ink
        </h2>
        <span class="badge-proto">Đa nhân • HTTP :8080</span>
      </div>

      <div class="conv-bar">
        <div class="conv-row">
          <div class="conv-title-wrap">
            <svg class="ico ico-sm" style="color:var(--accent)"><use href="#ico-cpu"/></svg>
            <span>Bộ chuyển đổi trên trình duyệt:</span>
          </div>
          <select id="workerThreads" class="conv-select thread-select" onchange="syncWorkerSelectors(this)" title="Số luồng Web Worker chạy song song trên CPU máy tính / điện thoại">
            <option value="auto" selected>Đa luồng tự động (Khuyên dùng)</option>
            <option value="max">Tối đa tốc độ (Đa nhân cực đại)</option>
            <option value="8">8 luồng song song</option>
            <option value="4">4 luồng song song</option>
            <option value="2">2 luồng (Tiết kiệm RAM)</option>
            <option value="1">1 luồng (Đơn luồng)</option>
          </select>
        </div>
        <select id="convertMode" class="conv-select mode-select" title="Trình duyệt tự chuyển đổi song song trên nhiều nhân CPU trước khi truyền sang Kobo">
          <option value="auto" selected>Tự động thông minh (DOCX/EPUB/PDF chữ → KEPUB • PDF Scan → Phẳng E-Ink)</option>
          <option value="pdf_flatten">Luôn phẳng hóa PDF Scan (1 lớp ảnh/trang • Cắt lề • Chống lag &amp; lỗi 137)</option>
          <option value="force_kepub">Ép trích xuất chữ sang .KEPUB.EPUB</option>
          <option value="raw">Giữ nguyên tệp gốc (Không chuyển đổi)</option>
        </select>
      </div>

      <input type="file" id="fileInput" multiple style="display:none">
      <div class="dropzone" id="dropzone" onclick="document.getElementById('fileInput').click()">
        <div class="dz-icon-wrap">
          <svg class="ico ico-xl"><use href="#ico-upload"/></svg>
        </div>
        <div class="dz-headline">Kéo thả sách vào đây hoặc <span>chọn từ máy tính / điện thoại</span></div>
        <div class="dz-sub">Xử lý song song đa luồng (<strong>Web Workers + OffscreenCanvas</strong>): chuyển <strong>.DOCX / .EPUB / .TXT → .KEPUB</strong> &amp; phẳng hóa <strong>PDF Scan</strong> siêu tốc</div>
        <div class="dz-formats">
          <span class="fmt-chip">.PDF → E-INK ĐA LUỒNG</span>
          <span class="fmt-chip">.DOCX → KEPUB</span>
          <span class="fmt-chip">.EPUB → KEPUB</span>
          <span class="fmt-chip">.TXT / .MD → KEPUB</span>
          <span class="fmt-chip">.KEPUB.EPUB</span>
        </div>
        <div class="target-chip">Thư mục đích hiện tại: <code id="uploadTargetLabel">/Books</code></div>
      </div>

      <div class="prog-box" id="progBox">
        <div class="prog-meta">
          <span id="progName">Đang chuẩn bị xử lý...</span>
          <div class="prog-actions">
            <span class="prog-speed" id="progSpeed">0%</span>
            <button type="button" class="btn btn-sm ghost-danger" id="cancelConvBtn" style="display:none;padding:2px 7px" onclick="requestCancelConvert()">Hủy</button>
          </div>
        </div>
        <div class="prog-track"><div class="prog-bar" id="progBar"></div></div>
      </div>"""

assert OLD_UPLOAD_INNER in html, "Could not locate OLD_UPLOAD_INNER"
html = html.replace(OLD_UPLOAD_INNER, NEW_UPLOAD_INNER, 1)

# 4. Update screensaver quick-tab to /.adds/koreader/screensavers
html = html.replace(
    'data-dir="/.kobo/screensaver" onclick="goDir(\'/.kobo/screensaver\')"',
    'data-dir="/.adds/koreader/screensavers" onclick="goDir(\'/.adds/koreader/screensavers\')"',
)
html = html.replace(
    "btn.classList.toggle('active', btn.getAttribute('data-dir') === dir);",
    "const bd = btn.getAttribute('data-dir'); btn.classList.toggle('active', bd === dir || (bd === '/.adds/koreader/screensavers' && dir === '/.kobo/screensaver'));",
)

# 5. Add Optimize Modal for 1-click multi-threaded optimization of existing Kobo files
assert 'th class="col-acts"' in html, "Expected col-acts class on table header"

OPT_MODAL_HTML = """<!-- Optimize Existing Kobo File Modal -->
<div class="modal-backdrop" id="optModal" onclick="if(event.target===this)closeOptModal()">
  <div class="modal-card" style="max-width:468px">
    <div class="modal-hdr">
      <h3 class="modal-title" style="color:var(--accent)">
        <svg class="ico"><use href="#ico-zap"/></svg>
        Tối ưu sách đa luồng ngay trên Kobo
      </h3>
      <button class="icon-btn" style="width:28px;height:28px" onclick="closeOptModal()">
        <svg class="ico ico-sm"><use href="#ico-x"/></svg>
      </button>
    </div>
    <div class="modal-body">
      Trình duyệt sẽ tải <code id="optModalFile" style="font-weight:600;color:var(--ink)"></code> qua Wi-Fi, huy động nhiều nhân CPU để tối ưu song song rồi chép bản mượt trở lại Kobo:
      <div class="modal-opt-row">
        <label style="font-size:12px;font-weight:600;color:var(--ink-secondary)">Phương thức tối ưu:</label>
        <select id="optModalMode" class="conv-select" style="width:100%">
          <option value="auto">Tự động thông minh (Khuyên dùng)</option>
          <option value="pdf_flatten">Phẳng hóa PDF Scan E-Ink (Gộp 1 ảnh/trang • Cắt lề • Chống lỗi 137)</option>
          <option value="force_kepub">Trích xuất văn bản sang .KEPUB.EPUB</option>
        </select>
        <label style="font-size:12px;font-weight:600;color:var(--ink-secondary);margin-top:2px">Số luồng CPU xử lý song song:</label>
        <select id="optModalThreads" class="conv-select thread-select" style="width:100%" onchange="syncWorkerSelectors(this)">
          <option value="auto" selected>Đa luồng tự động (Khuyên dùng)</option>
          <option value="max">Tối đa tốc độ (Đa nhân cực đại)</option>
          <option value="8">8 luồng song song</option>
          <option value="4">4 luồng song song</option>
          <option value="2">2 luồng (Tiết kiệm RAM)</option>
          <option value="1">1 luồng (Đơn luồng)</option>
        </select>
        <label class="chk-row">
          <input type="checkbox" id="optSaveToBooks" checked>
          <span>Lưu bản đã tối ưu vào thẳng <code>/Books</code></span>
        </label>
        <label class="chk-row">
          <input type="checkbox" id="optDeleteOrig">
          <span>Xóa tệp gốc nặng sau khi tạo bản mới thành công</span>
        </label>
      </div>
    </div>
    <div class="modal-ftr">
      <button class="btn" onclick="closeOptModal()">Hủy bỏ</button>
      <button class="btn primary" onclick="confirmOptimizeExisting()">
        <svg class="ico ico-sm"><use href="#ico-zap"/></svg>
        Bắt đầu tối ưu đa luồng
      </button>
    </div>
  </div>
</div>

<script>"""

html = html.replace("<script>", OPT_MODAL_HTML, 1)

# 6. Add [Tối ưu] button in renderTable() for convertible files & wire pipelined handleFiles + optimizeExisting
OLD_FILE_ROW_ACTS = """        '<td class="acts"><div class="acts-inner">' +
          '<a class="btn btn-sm" href="' + dlUrl + '" title="Tải tệp về máy">' +
            '<svg class="ico ico-sm"><use href="#ico-download"/></svg><span>Tải</span>' +
          '</a>' +
          '<button class="btn btn-sm ghost-danger" onclick="askDelete(' + safeRelJs + ', false)" title="Xóa tệp">' +
            '<svg class="ico ico-sm"><use href="#ico-trash"/></svg><span>Xóa</span>' +
          '</button>' +
        '</div></td>' +"""

NEW_FILE_ROW_ACTS = """        '<td class="acts"><div class="acts-inner">' +
          (canOptimizeItem(it.name) ? (
            '<button class="btn btn-sm opt-btn" onclick="openOptModal(' + safeRelJs + ')" title="Chuyển đổi đa luồng sang KEPUB hoặc phẳng hóa PDF Scan chống lag">' +
              '<svg class="ico ico-sm"><use href="#ico-zap"/></svg><span>Tối ưu</span>' +
            '</button>'
          ) : '') +
          '<a class="btn btn-sm" href="' + dlUrl + '" title="Tải tệp về máy">' +
            '<svg class="ico ico-sm"><use href="#ico-download"/></svg><span>Tải</span>' +
          '</a>' +
          '<button class="btn btn-sm ghost-danger" onclick="askDelete(' + safeRelJs + ', false)" title="Xóa tệp">' +
            '<svg class="ico ico-sm"><use href="#ico-trash"/></svg><span>Xóa</span>' +
          '</button>' +
        '</div></td>' +"""

assert OLD_FILE_ROW_ACTS in html, "Could not locate OLD_FILE_ROW_ACTS"
html = html.replace(OLD_FILE_ROW_ACTS, NEW_FILE_ROW_ACTS, 1)

OLD_HANDLE_FILES = """function uploadSingleFile(file, idx, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = '/api/upload?dir=' + encodeURIComponent(currentDir) + '&name=' + encodeURIComponent(file.name);
    const t0 = Date.now();
    xhr.open('POST', url, true);
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded * 100) / e.total);
        const dt = Math.max(0.1, (Date.now() - t0) / 1000);
        const speed = fmtSize(e.loaded / dt) + '/s';
        document.getElementById('progBar').style.width = pct + '%';
        document.getElementById('progName').textContent =
          '[' + idx + '/' + total + '] ' + file.name + ' (' + fmtSize(e.loaded) + ' / ' + fmtSize(e.total) + ')';
        document.getElementById('progSpeed').textContent = pct + '% • ' + speed;
      }
    };
    xhr.onload = function() {
      try {
        const resp = JSON.parse(xhr.responseText || '{}');
        if (xhr.status === 200 && resp.ok) resolve(resp);
        else reject(new Error(resp.error || ('Mã lỗi HTTP ' + xhr.status)));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = function() { reject(new Error('Ngắt kết nối mạng Wi-Fi khi đang truyền tệp')); };
    xhr.send(file);
  });
}

async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0 || uploading) return;
  uploading = true;
  const files = Array.from(fileList);
  const progBox = document.getElementById('progBox');
  progBox.style.display = 'block';
  let okCount = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      document.getElementById('progBar').style.width = '0%';
      await uploadSingleFile(files[i], i + 1, files.length);
      okCount++;
    }
    showToast('Đã truyền hoàn tất ' + okCount + ' tệp vào ' + currentDir, false);
  } catch (e) {
    showToast('Lỗi truyền tệp: ' + e.message, true);
  } finally {
    uploading = false;
    document.getElementById('fileInput').value = '';
    setTimeout(() => { progBox.style.display = 'none'; }, 1600);
    loadDir(currentDir);
  }
}"""

NEW_HANDLE_FILES = CONVERTER_JS + """

function canOptimizeItem(name) {
  if (currentDir === '/fonts' || currentDir.includes('screensaver')) return false;
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.kepub.epub') || lower.endsWith('.kepub') || lower.endsWith('[e-ink].pdf')) return false;
  return lower.endsWith('.pdf') || lower.endsWith('.docx') || lower.endsWith('.epub') || lower.endsWith('.txt') || lower.endsWith('.md');
}

function uploadSingleFileToDir(file, targetDir, idx, total, bgStatusFn) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = '/api/upload?dir=' + encodeURIComponent(targetDir) + '&name=' + encodeURIComponent(file.name);
    const t0 = Date.now();
    xhr.open('POST', url, true);
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded * 100) / e.total);
        const dt = Math.max(0.1, (Date.now() - t0) / 1000);
        const speed = fmtSize(e.loaded / dt) + '/s';
        const bgNote = bgStatusFn ? bgStatusFn() : '';
        document.getElementById('progBar').style.width = pct + '%';
        document.getElementById('progName').textContent =
          '[' + idx + '/' + total + '] Đang chép sang Kobo: ' + file.name + ' (' + fmtSize(e.loaded) + ' / ' + fmtSize(e.total) + ')' +
          (bgNote ? (' • ' + bgNote) : '');
        document.getElementById('progSpeed').textContent = pct + '% • ' + speed;
      }
    };
    xhr.onload = function() {
      try {
        const resp = JSON.parse(xhr.responseText || '{}');
        if (xhr.status === 200 && resp.ok) resolve(resp);
        else reject(new Error(resp.error || ('Mã lỗi HTTP ' + xhr.status)));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = function() { reject(new Error('Ngắt kết nối mạng Wi-Fi khi đang truyền tệp')); };
    xhr.send(file);
  });
}

// Pipelined Multi-File Queue: Pre-converts Book (i+1) across CPU Workers WHILE Book (i) uploads over Wi-Fi!
async function handleFiles(fileList) {
  if (!fileList || fileList.length === 0 || uploading) return;
  uploading = true;
  cancelConvertRequested = false;

  const files = Array.from(fileList);
  const dstDir = currentDir;
  const mode = (document.getElementById('convertMode') || {}).value || 'auto';
  const progBox = document.getElementById('progBox');
  const cancelBtn = document.getElementById('cancelConvBtn');
  progBox.style.display = 'block';

  let okCount = 0;
  let convNotes = [];
  let foregroundStage = 'convert';
  let foregroundIdx = 0;
  let bgPrefetchHint = '';

  const startConversionAt = (idx) => {
    if (idx >= files.length) return null;
    return maybeConvertFileForKobo(files[idx], dstDir, mode, (msg, pct, speedLabel) => {
      if (foregroundStage === 'convert' && foregroundIdx === idx) {
        document.getElementById('progName').textContent = '[' + (idx + 1) + '/' + files.length + '] ' + msg;
        if (pct != null) {
          document.getElementById('progBar').style.width = pct + '%';
          document.getElementById('progSpeed').textContent = speedLabel || (pct + '%');
        }
      } else {
        bgPrefetchHint = 'Đang xử lý trước tệp ' + (idx + 1) + '/' + files.length + (pct != null ? (' (' + pct + '%)') : '');
      }
    }, false);
  };

  try {
    let currentConvPromise = startConversionAt(0);

    for (let i = 0; i < files.length; i++) {
      if (cancelConvertRequested) throw new Error('Đã hủy chuyển đổi');
      foregroundStage = 'convert';
      foregroundIdx = i;
      cancelBtn.style.display = 'inline-flex';
      document.getElementById('progBar').style.width = '4%';
      document.getElementById('progSpeed').textContent = 'Đa luồng...';

      const convRes = await currentConvPromise;
      bgPrefetchHint = '';
      if (convRes.converted && convRes.summary) convNotes.push(convRes.summary);

      // Immediately launch background CPU conversion for next file while Wi-Fi uploads current file!
      const nextConvPromise = (i + 1 < files.length && !cancelConvertRequested)
        ? startConversionAt(i + 1)
        : null;
      // Suppress unhandled rejection if upload fails while nextConvPromise is running
      if (nextConvPromise) nextConvPromise.catch(() => {});

      foregroundStage = 'upload';
      if (!nextConvPromise) cancelBtn.style.display = 'none';
      document.getElementById('progBar').style.width = '0%';
      await uploadSingleFileToDir(convRes.file, dstDir, i + 1, files.length, () => bgPrefetchHint);
      okCount++;

      currentConvPromise = nextConvPromise;
    }

    const extra = convNotes.length ? (' (' + convNotes.slice(0, 3).join(', ') + (convNotes.length > 3 ? '...' : '') + ')') : '';
    showToast('Hoàn tất ' + okCount + ' tệp vào ' + dstDir + extra, false);
  } catch (e) {
    requestCancelConvert();
    showToast('Lỗi xử lý / truyền tệp: ' + e.message, true);
  } finally {
    cancelBtn.style.display = 'none';
    uploading = false;
    document.getElementById('fileInput').value = '';
    setTimeout(() => { progBox.style.display = 'none'; }, 2000);
    loadDir(currentDir);
  }
}

let pendingOptPath = null;
function openOptModal(relPath) {
  if (uploading) return;
  pendingOptPath = relPath;
  const fname = relPath.split('/').pop() || relPath;
  if (fname.toLowerCase().endsWith('.pdf') && typeof prewarmPdfWorkerPool === 'function') {
    prewarmPdfWorkerPool();
  }
  document.getElementById('optModalFile').textContent = fname;
  const sel = document.getElementById('optModalMode');
  if (fname.toLowerCase().endsWith('.pdf') && relPath.includes('PDF_Ban_Scan')) {
    sel.value = 'pdf_flatten';
  } else {
    sel.value = 'auto';
  }
  syncWorkerSelectors(document.getElementById('workerThreads'));
  document.getElementById('optModal').classList.add('open');
}

function closeOptModal() {
  pendingOptPath = null;
  document.getElementById('optModal').classList.remove('open');
}

async function confirmOptimizeExisting() {
  if (!pendingOptPath || uploading) return;
  const relPath = pendingOptPath;
  const fname = relPath.split('/').pop() || 'book.pdf';
  const mode = document.getElementById('optModalMode').value || 'auto';
  syncWorkerSelectors(document.getElementById('optModalThreads'));
  const saveToBooks = document.getElementById('optSaveToBooks').checked;
  const deleteOrig = document.getElementById('optDeleteOrig').checked;
  closeOptModal();

  uploading = true;
  cancelConvertRequested = false;
  const progBox = document.getElementById('progBox');
  const cancelBtn = document.getElementById('cancelConvBtn');
  progBox.style.display = 'block';
  try {
    document.getElementById('progName').textContent = 'Đang tải tệp gốc từ Kobo về trình duyệt: ' + fname + '...';
    document.getElementById('progSpeed').textContent = 'Đang tải...';
    document.getElementById('progBar').style.width = '8%';

    const dlRes = await fetch('/api/download?path=' + encodeURIComponent(relPath));
    if (!dlRes.ok) throw new Error('Không thể tải tệp từ Kobo (HTTP ' + dlRes.status + ')');
    const blob = await dlRes.blob();
    const srcFile = new File([blob], fname, { type: blob.type || 'application/octet-stream' });

    cancelBtn.style.display = 'inline-flex';
    const dstDir = saveToBooks ? '/Books' : currentDir;
    const convRes = await maybeConvertFileForKobo(srcFile, dstDir, mode, (msg, pct, speedLabel) => {
      document.getElementById('progName').textContent = msg;
      if (pct != null) {
        document.getElementById('progBar').style.width = pct + '%';
        document.getElementById('progSpeed').textContent = speedLabel || (pct + '%');
      }
    }, true);
    cancelBtn.style.display = 'none';

    await uploadSingleFileToDir(convRes.file, dstDir, 1, 1, null);

    if (deleteOrig && (dstDir !== currentDir || convRes.file.name !== fname)) {
      await fetch('/api/delete?path=' + encodeURIComponent(relPath), { method: 'POST' });
    }
    showToast('Đã tối ưu đa luồng xong: ' + convRes.file.name + ' → ' + dstDir, false);
    loadDir(dstDir);
  } catch (e) {
    requestCancelConvert();
    showToast('Lỗi tối ưu tệp: ' + e.message, true);
  } finally {
    cancelBtn.style.display = 'none';
    uploading = false;
    setTimeout(() => { progBox.style.display = 'none'; }, 2200);
  }
}"""

assert OLD_HANDLE_FILES in html, "Could not locate OLD_HANDLE_FILES"
html = html.replace(OLD_HANDLE_FILES, NEW_HANDLE_FILES, 1)

# 7. Strict Verification: Zero Emojis, Balanced SVG, Valid JS Syntax
emojis_found = []
for ch in html:
    cp = ord(ch)
    if (
        0x1F300 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0xFE00 <= cp <= 0xFE0F
        or (unicodedata.category(ch) == "So" and cp > 0x2200 and ch not in ("↑", "↓", "→", "•", "—"))
    ):
        emojis_found.append((ch, hex(cp), unicodedata.name(ch, "?")))

assert not emojis_found, f"Emojis detected: {emojis_found}"
assert html.count("<svg") == html.count("</svg>"), "Unbalanced <svg>!"
assert html.count("<symbol") == html.count("</symbol>"), "Unbalanced <symbol>!"
assert "]====]" not in html, "Forbidden Lua string delimiter!"

m_js = re.search(r"<script>(.*)</script>", html, re.S)
assert m_js
assert html.lower().count("<script") == 1 and html.lower().count("</script") == 1, "HTML5 script tag collision!"
assert "<!--" not in m_js.group(1), "HTML comment opener inside inline script!"
tmp_js = DIST_DIR / "_tmp_verify_studio_conv.js"
DIST_DIR.mkdir(parents=True, exist_ok=True)
tmp_js.write_text(m_js.group(1), encoding="utf-8")
if shutil.which("node"):
    rn = subprocess.run(["node", "--check", str(tmp_js)], capture_output=True, text=True)
    assert rn.returncode == 0, f"JS syntax error: {rn.stderr}"
tmp_js.unlink(missing_ok=True)
print("[PASS] Zero emojis + Balanced SVG + JS syntax check passed!")

standalone_path = DIST_DIR / "studio_standalone.html"
standalone_path.write_bytes(html.replace("\r\n", "\n").encode("utf-8"))

server_tpl = (SRC_DIR / "server_base.lua").read_text(encoding="utf-8")
assert "__STUDIO_INDEX_HTML__" in server_tpl, "Missing __STUDIO_INDEX_HTML__ placeholder in server_base.lua"
new_lua = server_tpl.replace("__STUDIO_INDEX_HTML__", html, 1)

assert 'pcall(lfs.chdir, "/tmp")' in new_lua, "Missing chdir /tmp fix!"
assert "local function handle_vendor(" in new_lua, "Missing /vendor/ static handler!"
assert "/.adds/koreader/screensavers" in new_lua, "Missing screensaver sync!"
assert 'path_part == "/api/reload"' in new_lua, "Missing /api/reload hot-swap route!"

out_lua = DIST_DIR / "kobo_overlay" / ".adds" / "tools" / "webfiles.lua"
out_lua.parent.mkdir(parents=True, exist_ok=True)
out_lua.write_bytes(new_lua.replace("\r\n", "\n").encode("utf-8"))
print(f"Built {out_lua.relative_to(ROOT_DIR)} ({out_lua.stat().st_size:,} bytes) & {standalone_path.relative_to(ROOT_DIR)} successfully!")
