// Client-Side Multi-Threaded E-Book Auto-Converter & E-Ink Scan PDF Optimizer (v2.0 Multi-Core)
// Uses Dedicated Web Worker Pools + OffscreenCanvas + Precomputed 32-bit E-Ink LUT + Off-Main-Thread JSZip
// Runs 100% on PC/Phone Browser (0% CPU / 0 MB RAM overhead on Kobo!)

let cancelConvertRequested = false;
const loadedScripts = {};
const vendorBufferCache = {};
const activeWorkers = new Set();

const HW_CORES = Math.max(1, Number(navigator.hardwareConcurrency) || 4);

// Precompute 256-entry E-Ink Carta Grayscale & 32-bit RGBA LUT once (eliminates ~1.1M Math.pow calls/page!)
const EINK_GRAY_LUT = new Uint8Array(256);
const EINK_RGBA32_LUT = new Uint32Array(256);
(function initMainThreadLut() {
  const endianProbe = new Uint8Array(new Uint32Array([0x01020304]).buffer);
  const isLE = endianProbe[0] === 0x04;
  for (let i = 0; i < 256; i++) {
    let g;
    if (i >= 236) g = 255;
    else if (i <= 48) g = Math.round(i * 0.45);
    else g = Math.round(22 + Math.pow((i - 48) / 188, 1.38) * 233);
    EINK_GRAY_LUT[i] = g;
    EINK_RGBA32_LUT[i] = isLE
      ? (((0xFF << 24) | (g << 16) | (g << 8) | g) >>> 0)
      : (((g << 24) | (g << 16) | (g << 8) | 0xFF) >>> 0);
  }
})();

function spawnTrackedWorker(blobUrl) {
  const w = new Worker(blobUrl);
  activeWorkers.add(w);
  return w;
}

function killTrackedWorker(w) {
  if (!w) return;
  try { w.terminate(); } catch (_) {}
  activeWorkers.delete(w);
}

function terminateAllActiveWorkers() {
  for (const w of Array.from(activeWorkers)) {
    try { w.terminate(); } catch (_) {}
  }
  activeWorkers.clear();
}

const cancelListeners = new Set();
function requestCancelConvert() {
  cancelConvertRequested = true;
  terminateAllActiveWorkers();
  for (const fn of Array.from(cancelListeners)) {
    try { fn(); } catch (_) {}
  }
  cancelListeners.clear();
}

function getAutoThreadCount(fileSizeBytes, isPdfClone) {
  let ideal;
  if (HW_CORES >= 14) ideal = 8;
  else if (HW_CORES >= 10) ideal = 7;
  else if (HW_CORES >= 8) ideal = 6;
  else if (HW_CORES >= 4) ideal = Math.max(3, HW_CORES - 1);
  else ideal = Math.max(1, HW_CORES);

  if (isPdfClone && fileSizeBytes > 0) {
    const devMemGB = Number(navigator.deviceMemory) || 8;
    const budgetMB = devMemGB <= 4 ? 420 : (devMemGB <= 8 ? 1100 : 2000);
    const fileMB = Math.max(12, fileSizeBytes / 1048576);
    const maxByRam = Math.max(1, Math.floor(budgetMB / fileMB));
    ideal = Math.min(ideal, maxByRam);
  }
  return Math.max(1, ideal);
}

function getConfiguredWorkerCount(fileSizeBytes, isPdfClone) {
  const sel = document.getElementById('workerThreads');
  const raw = sel ? sel.value : 'auto';
  let chosen;
  if (!raw || raw === 'auto') {
    chosen = getAutoThreadCount(fileSizeBytes || 0, !!isPdfClone);
  } else if (raw === 'max') {
    chosen = Math.min(16, Math.max(2, HW_CORES >= 8 ? HW_CORES - 2 : HW_CORES));
    if (isPdfClone && fileSizeBytes > 0) {
      const fileMB = Math.max(12, fileSizeBytes / 1048576);
      chosen = Math.min(chosen, Math.max(2, Math.floor(2400 / fileMB)));
    }
  } else {
    chosen = Math.max(1, parseInt(raw, 10) || getAutoThreadCount(fileSizeBytes || 0, !!isPdfClone));
    if (isPdfClone && fileSizeBytes > 0) {
      const fileMB = Math.max(12, fileSizeBytes / 1048576);
      chosen = Math.min(chosen, Math.max(1, Math.floor(2400 / fileMB)));
    }
  }
  return Math.max(1, chosen);
}

function syncWorkerSelectors(sourceEl) {
  const val = sourceEl ? sourceEl.value : 'auto';
  const a = document.getElementById('workerThreads');
  const b = document.getElementById('optModalThreads');
  if (a && a !== sourceEl) a.value = val;
  if (b && b !== sourceEl) b.value = val;
}

function initMultiThreadUiLabels() {
  const autoN = getAutoThreadCount(30 * 1048576, true);
  const maxN = Math.min(16, Math.max(2, HW_CORES >= 8 ? HW_CORES - 2 : HW_CORES));
  for (const id of ['workerThreads', 'optModalThreads']) {
    const sel = document.getElementById(id);
    if (!sel) continue;
    for (const opt of Array.from(sel.options)) {
      if (opt.value === 'auto') {
        opt.textContent = 'Đa luồng tự động (' + autoN + ' luồng / ' + HW_CORES + ' nhân CPU)';
      } else if (opt.value === 'max') {
        opt.textContent = 'Tối đa tốc độ (' + maxN + ' luồng song song)';
      }
    }
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initMultiThreadUiLabels);
} else {
  setTimeout(initMultiThreadUiLabels, 0);
}

// Fetch vendor JS once into RAM ArrayBuffer so spawning N Web Workers sends ZERO extra HTTP requests to Kobo!
function fetchVendorBufferOnce(localUrl, cdnUrl) {
  if (vendorBufferCache[localUrl]) return vendorBufferCache[localUrl];
  vendorBufferCache[localUrl] = (async () => {
    if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
      try {
        const r = await fetch(localUrl);
        if (r && r.ok) return await r.arrayBuffer();
      } catch (_) {}
    }
    if (cdnUrl) {
      const r2 = await fetch(cdnUrl);
      if (r2 && r2.ok) return await r2.arrayBuffer();
    }
    throw new Error('Không thể tải thư viện xử lý sách: ' + localUrl);
  })();
  vendorBufferCache[localUrl].catch(() => { delete vendorBufferCache[localUrl]; });
  return vendorBufferCache[localUrl];
}

function loadScriptSequential(localUrl, cdnUrl, checkGlobal) {
  if (checkGlobal && window[checkGlobal]) return Promise.resolve();
  const key = checkGlobal || localUrl;
  if (loadedScripts[key]) return loadedScripts[key];

  loadedScripts[key] = (async () => {
    try {
      const ab = await fetchVendorBufferOnce(localUrl, cdnUrl);
      const blobUrl = URL.createObjectURL(new Blob([ab], { type: 'application/javascript' }));
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = blobUrl;
        s.onload = () => { URL.revokeObjectURL(blobUrl); resolve(); };
        s.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error('Lỗi nạp script ' + localUrl)); };
        document.head.appendChild(s);
      });
      if (checkGlobal && !window[checkGlobal]) {
        throw new Error('Thiếu biến toàn cục ' + checkGlobal);
      }
    } catch (_) {
      // Fallback to direct script element if fetch CORS blocked on local preview
      await new Promise((resolve, reject) => {
        const tryCdn = () => {
          if (!cdnUrl) return reject(new Error('Không thể tải thư viện: ' + localUrl));
          const s2 = document.createElement('script');
          s2.src = cdnUrl;
          s2.onload = () => resolve();
          s2.onerror = () => {
            delete loadedScripts[key];
            reject(new Error('Không thể nạp thư viện xử lý sách (kiểm tra mạng)'));
          };
          document.head.appendChild(s2);
        };
        if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
          const s1 = document.createElement('script');
          s1.src = localUrl;
          s1.onload = () => (!checkGlobal || window[checkGlobal]) ? resolve() : tryCdn();
          s1.onerror = tryCdn;
          document.head.appendChild(s1);
        } else {
          tryCdn();
        }
      });
    }
  })();
  return loadedScripts[key];
}

async function ensureJSZip() {
  await loadScriptSequential(
    '/vendor/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'JSZip'
  );
}

async function ensureMammoth() {
  await loadScriptSequential(
    '/vendor/mammoth.browser.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
    'mammoth'
  );
}

let pdfWorkerConfigured = false;
async function ensurePdfJsMainThread() {
  await loadScriptSequential(
    '/vendor/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    'pdfjsLib'
  );
  if (!pdfWorkerConfigured && window.pdfjsLib) {
    try {
      const wAb = await fetchVendorBufferOnce(
        '/vendor/pdf.worker.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
      );
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
        new Blob([wAb], { type: 'application/javascript' })
      );
    } catch (_) {
      const cdnWorker = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const blob = new Blob(['importScripts("' + cdnWorker + '");'], { type: 'application/javascript' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
    }
    pdfWorkerConfigured = true;
  }
}

// ============================================================================
// CACHED MULTI-CORE WORKER BLOB BUILDERS (0 extra HTTP requests per worker!)
// ============================================================================

let cachedPdfPoolWorkerUrl = null;
let cachedSpanWorkerUrl = null;
let cachedZipWorkerUrl = null;

const PDF_WORKER_PREAMBLE = `
(function() {
  self.window = self;
  if (typeof self.requestAnimationFrame !== 'function') {
    self.requestAnimationFrame = function(cb) { return setTimeout(cb, 0); };
    self.cancelAnimationFrame = function(id) { clearTimeout(id); };
  }
  if (typeof self.getComputedStyle !== 'function') {
    self.getComputedStyle = function() {
      return { getPropertyValue: function() { return ''; }, cursor: 'default' };
    };
  }
  const dummyEl = function() {
    return {
      style: {},
      classList: { add: function(){}, remove: function(){}, contains: function(){ return false; } },
      setAttribute: function(){},
      getAttribute: function(){ return ''; },
      addEventListener: function(){},
      removeEventListener: function(){},
      append: function(){},
      appendChild: function(){},
      prepend: function(){},
      remove: function(){},
      getElementsByTagName: function(){ return [dummyEl()]; },
      sheet: { cssRules: [], insertRule: function(){} }
    };
  };
  self.document = {
    baseURI: (self.location && self.location.href) ? self.location.href : 'http://localhost/',
    currentScript: null,
    documentElement: dummyEl(),
    head: dummyEl(),
    body: dummyEl(),
    fonts: self.fonts || { add: function(){}, delete: function(){}, clear: function(){} },
    createElement: function(tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        return new OffscreenCanvas(1, 1);
      }
      return dummyEl();
    },
    createElementNS: function(_ns, tag) {
      return this.createElement(tag);
    }
  };
})();
`;

const PDF_POOL_WORKER_BODY = `
(function() {
  const EINK_RGBA32 = new Uint32Array(256);
  const probe = new Uint8Array(new Uint32Array([0x01020304]).buffer);
  const isLE = probe[0] === 0x04;
  for (let i = 0; i < 256; i++) {
    let g;
    if (i >= 236) g = 255;
    else if (i <= 48) g = Math.round(i * 0.45);
    else g = Math.round(22 + Math.pow((i - 48) / 188, 1.38) * 233);
    EINK_RGBA32[i] = isLE
      ? (((0xFF << 24) | (g << 16) | (g << 8) | g) >>> 0)
      : (((g << 24) | (g << 16) | (g << 8) | 0xFF) >>> 0);
  }

  const canvasFactory = {
    create: function(w, h) {
      const cw = Math.max(1, Math.ceil(w));
      const ch = Math.max(1, Math.ceil(h));
      const canvas = new OffscreenCanvas(cw, ch);
      return { canvas: canvas, context: canvas.getContext('2d', { willReadFrequently: true }) };
    },
    reset: function(obj, w, h) {
      if (obj && obj.canvas) {
        obj.canvas.width = Math.max(1, Math.ceil(w));
        obj.canvas.height = Math.max(1, Math.ceil(h));
      }
    },
    destroy: function(obj) {
      if (obj && obj.canvas) {
        obj.canvas.width = 0;
        obj.canvas.height = 0;
        obj.canvas = null;
        obj.context = null;
      }
    }
  };

  const filterFactory = {
    addFilter: function() { return 'none'; },
    addHCMFilter: function() { return 'none'; },
    addHighlightHCMFilter: function() { return 'none'; },
    addAlphaFilter: function() { return 'none'; },
    addLuminosityFilter: function() { return 'none'; },
    destroy: function() {}
  };

  let pdfDoc = null;
  const renderCanvas = new OffscreenCanvas(1, 1);
  const outCanvas = new OffscreenCanvas(1, 1);
  const rctx = renderCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  const dctx = outCanvas.getContext('2d', { alpha: false, willReadFrequently: true });

  function cropAndEnhanceOffscreen() {
    const sw = renderCanvas.width;
    const sh = renderCanvas.height;
    const imgData = rctx.getImageData(0, 0, sw, sh);
    const d = imgData.data;

    const bx0 = Math.floor(sw * 0.012);
    const bx1 = Math.ceil(sw * 0.988);
    const by0 = Math.floor(sh * 0.012);
    const by1 = Math.ceil(sh * 0.988);

    let minX = bx1, maxX = bx0, minY = by1, maxY = by0;
    const rowHits = new Uint16Array(sh);
    const colHits = new Uint16Array(sw);

    for (let y = by0; y < by1; y += 2) {
      const rowOff = y * sw * 4;
      for (let x = bx0; x < bx1; x += 2) {
        const idx = rowOff + x * 4;
        const lum = (d[idx] * 77 + d[idx + 1] * 150 + d[idx + 2] * 29) >> 8;
        if (lum < 218) {
          rowHits[y]++;
          colHits[x]++;
        }
      }
    }

    for (let y = by0; y < by1; y += 2) {
      if (rowHits[y] >= 3) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    for (let x = bx0; x < bx1; x += 2) {
      if (colHits[x] >= 3) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
    }

    let cx = 0, cy = 0, cw = sw, ch = sh;
    if (maxX > minX + sw * 0.18 && maxY > minY + sh * 0.18) {
      const padX = Math.round(sw * 0.024);
      const padY = Math.round(sh * 0.024);
      cx = Math.max(0, minX - padX);
      cy = Math.max(0, minY - padY);
      cw = Math.min(sw - cx, (maxX - minX) + padX * 2);
      ch = Math.min(sh - cy, (maxY - minY) + padY * 2);
    }

    const MAX_W = 910;
    const MAX_H = 1230;
    const scale = Math.min(1, MAX_W / cw, MAX_H / ch);
    const tw = Math.max(64, Math.round(cw * scale));
    const th = Math.max(64, Math.round(ch * scale));

    outCanvas.width = tw;
    outCanvas.height = th;
    dctx.fillStyle = '#ffffff';
    dctx.fillRect(0, 0, tw, th);
    dctx.imageSmoothingEnabled = true;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(renderCanvas, cx, cy, cw, ch, 0, 0, tw, th);

    const outImg = dctx.getImageData(0, 0, tw, th);
    const od = outImg.data;
    const u32 = new Uint32Array(od.buffer, od.byteOffset, tw * th);
    for (let p = 0, i = 0; p < u32.length; p++, i += 4) {
      const lum = (od[i] * 77 + od[i + 1] * 150 + od[i + 2] * 29) >> 8;
      u32[p] = EINK_RGBA32[lum];
    }
    dctx.putImageData(outImg, 0, 0);
  }

  function extractStructuredLines(tc, pageH) {
    const items = [];
    let rawChars = 0;
    const sampleParts = [];
    for (const it of (tc.items || [])) {
      const s = (it.str || '');
      if (!s.trim()) continue;
      rawChars += s.length;
      if (sampleParts.length < 40) sampleParts.push(s);
      const tx = it.transform ? it.transform[4] : 0;
      const ty = it.transform ? it.transform[5] : 0;
      const fh = it.transform ? Math.hypot(it.transform[2], it.transform[3]) : (it.height || 11);
      if ((ty < pageH * 0.055 || ty > pageH * 0.945) && /^\\s*[-–—]?\\s*\\d{1,4}\\s*[-–—]?\\s*$/.test(s)) continue;
      items.push({ s: s, x: tx, y: ty, h: fh || 11 });
    }

    items.sort(function(a, b) { return Math.abs(b.y - a.y) > 3.5 ? b.y - a.y : a.x - b.x; });
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(3.5, last.h * 0.42)) {
        const gap = it.x - last.endX;
        last.text += (gap > last.h * 0.22 && !last.text.endsWith(' ') && !it.s.startsWith(' ') ? ' ' : '') + it.s;
        last.endX = Math.max(last.endX, it.x + it.s.length * it.h * 0.45);
        last.h = Math.max(last.h, it.h);
      } else {
        lines.push({ text: it.s, y: it.y, x: it.x, endX: it.x + it.s.length * it.h * 0.45, h: it.h });
      }
    }
    const medianH = lines.length
      ? lines.map(function(l) { return l.h; }).sort(function(a, b) { return a - b; })[Math.floor(lines.length / 2)]
      : 11;
    return {
      lines: lines,
      medianH: medianH,
      rawChars: rawChars,
      sampleStr: sampleParts.join(' ').slice(0, 650)
    };
  }

  self.onmessage = async function(ev) {
    const msg = ev.data || {};
    try {
      if (msg.type === 'init') {
        const task = self.pdfjsLib.getDocument({
          data: new Uint8Array(msg.pdfAb),
          isEvalSupported: false,
          disableFontFace: true,
          useSystemFonts: false,
          verbosity: 0,
          canvasFactory: canvasFactory,
          filterFactory: filterFactory,
          ownerDocument: self.document
        });
        pdfDoc = await task.promise;
        self.postMessage({ type: 'ready', numPages: pdfDoc.numPages });
      } else if (msg.type === 'flattenPage') {
        const p = msg.pageNum;
        const page = await pdfDoc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const renderScale = Math.min(2.4, Math.max(1.0, 1420 / Math.max(vp1.width, vp1.height)));
        const vp = page.getViewport({ scale: renderScale });

        renderCanvas.width = Math.max(1, Math.floor(vp.width));
        renderCanvas.height = Math.max(1, Math.floor(vp.height));
        rctx.fillStyle = '#ffffff';
        rctx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

        await page.render({ canvasContext: rctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
        cropAndEnhanceOffscreen();
        const blob = await outCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
        const jpegAb = await blob.arrayBuffer();
        const w = outCanvas.width;
        const h = outCanvas.height;
        page.cleanup();
        self.postMessage({ type: 'flattenDone', pageNum: p, width: w, height: h, jpegAb: jpegAb }, [jpegAb]);
      } else if (msg.type === 'extractTextPage') {
        const p = msg.pageNum;
        const page = await pdfDoc.getPage(p);
        const tc = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        const info = extractStructuredLines(tc, vp.height || 800);
        page.cleanup();
        self.postMessage({
          type: 'textDone',
          pageNum: p,
          lines: info.lines,
          medianH: info.medianH,
          rawChars: info.rawChars,
          sampleStr: info.sampleStr
        });
      } else if (msg.type === 'close') {
        if (pdfDoc) {
          try { await pdfDoc.destroy(); } catch (_) {}
          pdfDoc = null;
        }
        self.postMessage({ type: 'closed' });
      }
    } catch (err) {
      self.postMessage({
        type: 'error',
        pageNum: msg.pageNum || 0,
        message: (err && err.message) ? err.message : String(err)
      });
    }
  };
})();
`;

async function getPdfPoolWorkerUrl() {
  if (cachedPdfPoolWorkerUrl) return cachedPdfPoolWorkerUrl;
  const [workerAb, minAb] = await Promise.all([
    fetchVendorBufferOnce(
      '/vendor/pdf.worker.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    ),
    fetchVendorBufferOnce(
      '/vendor/pdf.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
    )
  ]);
  const blob = new Blob(
    [PDF_WORKER_PREAMBLE, '\n;\n', workerAb, '\n;\n', minAb, '\n;\n', PDF_POOL_WORKER_BODY],
    { type: 'application/javascript' }
  );
  cachedPdfPoolWorkerUrl = URL.createObjectURL(blob);
  return cachedPdfPoolWorkerUrl;
}

// Pure-JS XML-safe koboSpan + XHTML normalizer worker (spawns in <2ms across all CPU cores!)
const SPAN_WORKER_CODE = `
(function() {
  const VOID_SET = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
  const SKIP_TAGS = new Set(['pre','code','textarea','button','select','noscript','ruby','rt','rp','script','style','svg','math','head','title']);
  const NON_INLINE_PARENTS = new Set(['table','thead','tbody','tfoot','tr','colgroup','ul','ol','dl']);
  const HTML_ENTITIES = {
    nbsp:'&#160;', iexcl:'&#161;', cent:'&#162;', pound:'&#163;', curren:'&#164;', yen:'&#165;',
    brvbar:'&#166;', sect:'&#167;', uml:'&#168;', copy:'&#169;', ordf:'&#170;', laquo:'&#171;',
    not:'&#172;', shy:'&#173;', reg:'&#174;', macr:'&#175;', deg:'&#176;', plusmn:'&#177;',
    sup2:'&#178;', sup3:'&#179;', acute:'&#180;', micro:'&#181;', para:'&#182;', middot:'&#183;',
    cedil:'&#184;', sup1:'&#185;', ordm:'&#186;', raquo:'&#187;', frac14:'&#188;', frac12:'&#189;',
    frac34:'&#190;', iquest:'&#191;', times:'&#215;', divide:'&#247;', ensp:'&#8194;', emsp:'&#8195;',
    thinsp:'&#8201;', ndash:'&#8211;', mdash:'&#8212;', lsquo:'&#8216;', rsquo:'&#8217;',
    sbquo:'&#8218;', ldquo:'&#8220;', rdquo:'&#8221;', bdquo:'&#8222;', dagger:'&#8224;',
    Dagger:'&#8225;', bull:'&#8226;', hellip:'&#8230;', permil:'&#8240;', prime:'&#8242;',
    Prime:'&#8243;', lsaquo:'&#8249;', rsaquo:'&#8250;', euro:'&#8364;', trade:'&#8482;', minus:'&#8722;'
  };

  function escapeXmlAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeXmlText(txt) {
    return txt
      .replace(/&([A-Za-z][A-Za-z0-9]+);/g, function(full, name) {
        if (name === 'amp' || name === 'lt' || name === 'gt' || name === 'quot' || name === 'apos') return full;
        return HTML_ENTITIES[name] || full;
      })
      .replace(/&(?!(?:#\\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);)/g, '&amp;');
  }

  function injectKoboSpansBody(bodyInner, chapNum) {
    if (!bodyInner || bodyInner.indexOf('koboSpan') !== -1) return bodyInner;

    const kept = [];
    const stash = function(m) {
      const key = '\\x00KP' + kept.length + '\\x00';
      kept.push(m);
      return key;
    };

    let work = bodyInner
      .replace(/\\x3c!--[\\s\\S]*?--\\x3e/g, stash)
      .replace(/\\x3c!\\[CDATA\\[[\\s\\S]*?\\]\\]\\x3e/g, stash)
      .replace(/\\x3c\\?[\\s\\S]*?\\?\\x3e/g, stash)
      .replace(/\\x3c(script|style|svg|math)(?:\\s[^>]*)?\\x3e[\\s\\S]*?\\x3c\\/\\1\\s*\\x3e/gi, stash);

    const TOKEN_RE = /(<\\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\\s+(?:[^>"']|"[^"]*"|'[^']*')*)?\\s*\\/?>)/g;
    const parts = work.split(TOKEN_RE);

    const stack = ['body'];
    let skipDepth = 0;
    let paraCounter = 1;
    const out = [];

    for (let i = 0; i < parts.length; i++) {
      const tok = parts[i];
      if (!tok) continue;

      if (i % 2 === 1) {
        // XML/HTML Tag
        const mTag = tok.match(/^<(\\/?)([A-Za-z_][A-Za-z0-9_.:-]*)/);
        if (!mTag) {
          out.push(tok);
          continue;
        }
        const isClose = mTag[1] === '/';
        const rawName = mTag[2];
        const lowerName = rawName.indexOf(':') !== -1
          ? rawName.split(':').pop().toLowerCase()
          : rawName.toLowerCase();
        const isSelfClose = /\\/\\s*>$/.test(tok);

        if (VOID_SET.has(lowerName)) {
          if (isClose) continue; // drop invalid </br>, </img>, </hr>
          out.push(isSelfClose ? tok : (tok.slice(0, -1) + '/>'));
          continue;
        }

        if (!isClose) {
          if (!isSelfClose) {
            stack.push(lowerName);
            if (SKIP_TAGS.has(lowerName) || /class\\s*=\\s*["'][^"']*koboSpan/i.test(tok)) {
              skipDepth++;
            }
          }
          out.push(tok);
        } else {
          // Pop matching open tag
          for (let s = stack.length - 1; s >= 1; s--) {
            if (stack[s] === lowerName) {
              for (let k = stack.length - 1; k >= s; k--) {
                const popped = stack.pop();
                if (SKIP_TAGS.has(popped) && skipDepth > 0) skipDepth--;
              }
              break;
            }
          }
          out.push(tok);
        }
      } else {
        // Text node (may contain stashed placeholders \\x00KPn\\x00)
        if (skipDepth > 0 || NON_INLINE_PARENTS.has(stack[stack.length - 1])) {
          out.push(sanitizeXmlText(tok));
          continue;
        }
        const subChunks = tok.split(/(\\x00KP\\d+\\x00)/g);
        for (let c = 0; c < subChunks.length; c++) {
          const seg = subChunks[c];
          if (!seg) continue;
          if (c % 2 === 1) {
            out.push(seg);
            continue;
          }
          const clean = sanitizeXmlText(seg);
          if (!clean.replace(/&#160;|\\s+/g, '')) {
            out.push(clean);
            continue;
          }
          const sentences = clean.match(/[^.!?…\\n]+[.!?…]*\\s*|\\s+/g) || [clean];
          const pIdx = paraCounter++;
          let sIdx = 1;
          for (let q = 0; q < sentences.length; q++) {
            const pt = sentences[q];
            if (!pt.replace(/&#160;|\\s+/g, '')) {
              out.push(pt);
            } else {
              out.push('<span class="koboSpan" id="kobo.' + chapNum + '_' + pIdx + '.' + (sIdx++) + '">' + pt + '</span>');
            }
          }
        }
      }
    }

    let res = out.join('');
    if (kept.length > 0) {
      res = res.replace(/\\x00KP(\\d+)\\x00/g, function(_, idx) { return kept[Number(idx)] || ''; });
    }
    return res;
  }

  const enc = new TextEncoder();

  self.onmessage = function(ev) {
    const msg = ev.data || {};
    try {
      if (msg.type === 'wrapChapter') {
        const xhtmlBody = injectKoboSpansBody(msg.bodyHtml || '', msg.chapNum);
        const fullXhtml =
          '<?xml version="1.0" encoding="UTF-8"?>\\n' +
          '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\\n' +
          '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi">\\n' +
          '<head>\\n' +
          '  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>\\n' +
          '  <title>' + escapeXmlAttr(msg.title || ('Phần ' + msg.chapNum)) + '</title>\\n' +
          '  <link rel="stylesheet" type="text/css" href="style.css"/>\\n' +
          '</head>\\n' +
          '<body>\\n' + xhtmlBody + '\\n</body>\\n</html>\\n';
        const u8 = enc.encode(fullXhtml);
        self.postMessage({ type: 'chapterDone', idx: msg.idx, ab: u8.buffer }, [u8.buffer]);
      } else if (msg.type === 'transformEpubXhtml') {
        const src = msg.xhtmlStr || '';
        let outStr = src;
        if (src.indexOf('koboSpan') === -1) {
          const openMatch = src.match(/<body(?:\\s[^>]*)?>/i);
          const closeIdx = src.search(/<\\/body\\s*>/i);
          if (openMatch && closeIdx > openMatch.index) {
            const bodyStart = openMatch.index + openMatch[0].length;
            const transformed = injectKoboSpansBody(src.slice(bodyStart, closeIdx), msg.chapNum);
            outStr = src.slice(0, bodyStart) + transformed + src.slice(closeIdx);
          }
        }
        const u8 = enc.encode(outStr);
        self.postMessage({ type: 'epubXhtmlDone', idx: msg.idx, path: msg.path, ab: u8.buffer }, [u8.buffer]);
      }
    } catch (err) {
      self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
    }
  };
})();
`;

function getSpanWorkerUrl() {
  if (!cachedSpanWorkerUrl) {
    cachedSpanWorkerUrl = URL.createObjectURL(
      new Blob([SPAN_WORKER_CODE], { type: 'application/javascript' })
    );
  }
  return cachedSpanWorkerUrl;
}

// Dedicated Background JSZip Worker (keeps 100% of ZIP decompression & DEFLATE off main UI thread!)
const ZIP_WORKER_BODY = `
(function() {
  const STORE_EXT_RE = /\\.(jpe?g|png|gif|webp|avif|bmp|ttf|otf|woff2?|mp3|mp4|m4a|ogg)$/i;

  self.onmessage = async function(ev) {
    const msg = ev.data || {};
    try {
      if (msg.type === 'buildKepubFromParts') {
        const zip = new self.JSZip();
        zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
        for (const item of (msg.files || [])) {
          const useStore = item.store || STORE_EXT_RE.test(item.path);
          zip.file(
            item.path,
            item.ab ? new Uint8Array(item.ab) : (item.text || ''),
            useStore ? { compression: 'STORE' } : { compression: 'DEFLATE', compressionOptions: { level: 4 } }
          );
        }
        const outAb = await zip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' });
        self.postMessage({ type: 'zipBuilt', ab: outAb }, [outAb]);
      } else if (msg.type === 'unpackEpubForSpanPool') {
        const srcZip = await self.JSZip.loadAsync(msg.epubAb);
        self._heldZip = new self.JSZip();
        self._heldZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

        const entries = Object.keys(srcZip.files);
        const xhtmlTasks = [];
        let htmlIdx = 0;

        for (let i = 0; i < entries.length; i++) {
          const path = entries[i];
          const entry = srcZip.files[path];
          if (entry.dir || path === 'mimetype') continue;
          const lower = path.toLowerCase();

          if (lower.endsWith('.css')) {
            let css = await entry.async('string');
            css = css.replace(/(^|[;{]\\s*)(color|background-color)\\s*:[^;{}]+;?/gi, '$1');
            self._heldZip.file(path, css, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
          } else if (
            (lower.endsWith('.xhtml') || lower.endsWith('.html') || lower.endsWith('.htm')) &&
            !lower.includes('toc') && !lower.includes('nav')
          ) {
            htmlIdx++;
            const content = await entry.async('string');
            xhtmlTasks.push({ idx: xhtmlTasks.length, chapNum: htmlIdx, path: path, xhtmlStr: content });
          } else {
            const u8 = await entry.async('uint8array');
            const useStore = STORE_EXT_RE.test(lower);
            self._heldZip.file(
              path,
              u8,
              useStore ? { compression: 'STORE' } : { compression: 'DEFLATE', compressionOptions: { level: 4 } }
            );
          }
        }
        self.postMessage({ type: 'epubUnpacked', xhtmlTasks: xhtmlTasks });
      } else if (msg.type === 'finishEpubFromSpanPool') {
        const outZip = self._heldZip;
        self._heldZip = null;
        for (const ch of (msg.doneChapters || [])) {
          outZip.file(ch.path, new Uint8Array(ch.ab), {
            compression: 'DEFLATE',
            compressionOptions: { level: 4 }
          });
        }
        const outAb = await outZip.generateAsync({ type: 'arraybuffer', mimeType: 'application/epub+zip' });
        self.postMessage({ type: 'epubFinished', ab: outAb }, [outAb]);
      }
    } catch (err) {
      self._heldZip = null;
      self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
    }
  };
})();
`;

async function getZipWorkerUrl() {
  if (cachedZipWorkerUrl) return cachedZipWorkerUrl;
  const jszipAb = await fetchVendorBufferOnce(
    '/vendor/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'
  );
  cachedZipWorkerUrl = URL.createObjectURL(
    new Blob(['self.window = self;\n', jszipAb, '\n;\n', ZIP_WORKER_BODY], { type: 'application/javascript' })
  );
  return cachedZipWorkerUrl;
}

// ============================================================================
// SHARED HELPERS & FALLBACKS
// ============================================================================

function stripExt(filename) {
  return filename
    .replace(/\.kepub\.epub$/i, '')
    .replace(/\.[^.]+$/, '')
    .trim() || 'Book';
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

function htmlElementToXhtml(el) {
  const tag = el.tagName.toLowerCase();
  let attrs = '';
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      const name = a.name.toLowerCase();
      if (!/^[a-z_:][a-z0-9_.:-]*$/i.test(name)) continue;
      attrs += ' ' + name + '="' + escapeXml(a.value) + '"';
    }
  }
  if (VOID_TAGS.has(tag)) {
    return '<' + tag + attrs + '/>';
  }
  let inner = '';
  for (const ch of Array.from(el.childNodes)) {
    if (ch.nodeType === 1) inner += htmlElementToXhtml(ch);
    else if (ch.nodeType === 3) inner += escapeXml(ch.nodeValue || '');
  }
  return '<' + tag + attrs + '>' + inner + '</' + tag + '>';
}

function injectKoboSpansIntoHtmlBody(htmlFragment, chapterIdx) {
  const parser = new DOMParser();
  const doc = parser.parseFromString('<!DOCTYPE html><html><body>' + htmlFragment + '</body></html>', 'text/html');
  let paraCounter = 1;
  const skipTags = new Set(['SCRIPT', 'STYLE', 'PRE', 'CODE', 'SVG', 'MATH', 'BUTTON', 'TEXTAREA']);

  function walk(node) {
    if (!node) return;
    if (node.nodeType === 1) {
      if (skipTags.has(node.tagName)) return;
      if (node.classList && node.classList.contains('koboSpan')) return;
      for (const ch of Array.from(node.childNodes)) walk(ch);
    } else if (node.nodeType === 3) {
      const txt = node.nodeValue || '';
      if (!txt.trim()) return;
      const parts = txt.match(/[^.!?…\n]+[.!?…]*\s*|\s+/g) || [txt];
      const frag = doc.createDocumentFragment();
      const pIdx = paraCounter++;
      let sIdx = 1;
      for (const part of parts) {
        if (!part.trim()) {
          frag.appendChild(doc.createTextNode(part));
        } else {
          const sp = doc.createElement('span');
          sp.className = 'koboSpan';
          sp.id = 'kobo.' + chapterIdx + '_' + pIdx + '.' + (sIdx++);
          sp.textContent = part;
          frag.appendChild(sp);
        }
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  walk(doc.body);
  let out = '';
  for (const child of Array.from(doc.body.childNodes)) {
    if (child.nodeType === 1) out += htmlElementToXhtml(child);
    else if (child.nodeType === 3) out += escapeXml(child.nodeValue || '');
  }
  return out;
}

// Run dynamic work-stealing tasks across W SpanWorkers in parallel!
async function runSpanWorkerPool(tasks, workerMsgType, threadCount, onProgress) {
  const W = Math.max(1, Math.min(threadCount, tasks.length, 12));
  const spanUrl = getSpanWorkerUrl();
  const workers = [];
  const results = new Array(tasks.length);
  let nextIdx = 0;
  let doneCount = 0;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      cancelListeners.delete(onCancel);
      for (const w of workers) killTrackedWorker(w);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onCancel = () => fail(new Error('Đã hủy chuyển đổi'));
    cancelListeners.add(onCancel);

    if (cancelConvertRequested) return onCancel();

    const dispatchNext = (w) => {
      if (settled) return;
      if (cancelConvertRequested) return onCancel();
      if (nextIdx >= tasks.length) return;
      const t = tasks[nextIdx++];
      w.postMessage(Object.assign({ type: workerMsgType }, t));
    };

    try {
      for (let i = 0; i < W; i++) {
        const w = spawnTrackedWorker(spanUrl);
        workers.push(w);
        w.onmessage = (ev) => {
          const m = ev.data || {};
          if (m.type === 'error') return fail(new Error(m.message || 'Lỗi xử lý chương đa luồng'));
          results[m.idx] = m;
          doneCount++;
          if (onProgress) onProgress(doneCount, tasks.length, W);
          if (doneCount >= tasks.length) {
            settled = true;
            cleanup();
            resolve(results);
          } else {
            dispatchNext(w);
          }
        };
        w.onerror = (e) => fail(new Error(e.message || 'SpanWorker crash'));
        dispatchNext(w);
      }
    } catch (err) {
      fail(err);
    }
  });
}

// Package structured chapters [{ title, bodyHtml }] + optional images into a valid .kepub.epub Blob
async function packageKepubFromChapters(bookTitle, chapters, extraImages, onStatus) {
  const targetThreads = getConfiguredWorkerCount(0, false);

  const containerXml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
    '  <rootfiles>\n' +
    '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
    '  </rootfiles>\n' +
    '</container>\n';

  const styleCss =
    'body { line-height: 1.48; margin: 0; padding: 0 2%; text-align: justify; }\n' +
    'h1, h2, h3 { line-height: 1.3; text-align: left; margin: 1.1em 0 0.55em; page-break-after: avoid; }\n' +
    'p { margin: 0 0 0.55em; text-indent: 1.2em; }\n' +
    'img { max-width: 100%; height: auto; display: block; margin: 0.6em auto; }\n' +
    '.koboSpan { -webkit-text-stroke: inherit; }\n';

  const manifestItems = [
    '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '    <item id="css" href="style.css" media-type="text/css"/>'
  ];
  const spineItems = [];
  const navPoints = [];

  if (extraImages && extraImages.length) {
    extraImages.forEach((img, i) => {
      manifestItems.push('    <item id="img_' + (i + 1) + '" href="' + escapeXml(img.path) + '" media-type="' + escapeXml(img.mediaType) + '"/>');
    });
  }

  for (let i = 0; i < chapters.length; i++) {
    const chNum = String(i + 1).padStart(3, '0');
    const fname = 'ch_' + chNum + '.xhtml';
    const chTitle = chapters[i].title || ('Phần ' + (i + 1));
    manifestItems.push('    <item id="ch_' + chNum + '" href="' + fname + '" media-type="application/xhtml+xml"/>');
    spineItems.push('    <itemref idref="ch_' + chNum + '"/>');
    navPoints.push(
      '    <navPoint id="nav_' + chNum + '" playOrder="' + (i + 1) + '">\n' +
      '      <navLabel><text>' + escapeXml(chTitle) + '</text></navLabel>\n' +
      '      <content src="' + fname + '"/>\n' +
      '    </navPoint>'
    );
  }

  const bookId = 'urn:uuid:kobo-studio-' + Date.now();
  const opf =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">\n' +
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
    '    <dc:title>' + escapeXml(bookTitle) + '</dc:title>\n' +
    '    <dc:language>vi</dc:language>\n' +
    '    <dc:creator>Kobo Wireless Studio</dc:creator>\n' +
    '    <dc:identifier id="BookId">' + bookId + '</dc:identifier>\n' +
    '  </metadata>\n' +
    '  <manifest>\n' + manifestItems.join('\n') + '\n  </manifest>\n' +
    '  <spine toc="ncx">\n' + spineItems.join('\n') + '\n  </spine>\n' +
    '</package>\n';

  const ncx =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n' +
    '  <head>\n' +
    '    <meta name="dtb:uid" content="' + bookId + '"/>\n' +
    '    <meta name="dtb:depth" content="1"/>\n' +
    '  </head>\n' +
    '  <docTitle><text>' + escapeXml(bookTitle) + '</text></docTitle>\n' +
    '  <navMap>\n' + navPoints.join('\n') + '\n  </navMap>\n' +
    '</ncx>\n';

  // Multi-threaded path: parallel SpanWorkerPool + background ZipWorker
  if (typeof Worker !== 'undefined') {
    try {
      const zipUrl = await getZipWorkerUrl();
      const tasks = chapters.map((ch, i) => ({
        idx: i,
        chapNum: i + 1,
        title: ch.title || ('Phần ' + (i + 1)),
        bodyHtml: ch.bodyHtml
      }));

      const doneChaps = await runSpanWorkerPool(tasks, 'wrapChapter', targetThreads, (done, total, activeW) => {
        if (onStatus && (done === 1 || done % 4 === 0 || done === total)) {
          onStatus('Đang xử lý KePub (' + activeW + ' luồng): Chương ' + done + '/' + total + '...');
        }
      });

      if (onStatus) onStatus('Đang nén gói .kepub.epub trên luồng nền...');
      const filesMsg = [
        { path: 'META-INF/container.xml', text: containerXml },
        { path: 'OEBPS/style.css', text: styleCss },
        { path: 'OEBPS/content.opf', text: opf },
        { path: 'OEBPS/toc.ncx', text: ncx }
      ];
      const transferList = [];

      if (extraImages && extraImages.length) {
        for (const img of extraImages) {
          const copyBuf = img.bytes.buffer.slice(img.bytes.byteOffset, img.bytes.byteOffset + img.bytes.byteLength);
          filesMsg.push({ path: 'OEBPS/' + img.path, ab: copyBuf, store: true });
          transferList.push(copyBuf);
        }
      }
      for (let i = 0; i < doneChaps.length; i++) {
        const chNum = String(i + 1).padStart(3, '0');
        filesMsg.push({ path: 'OEBPS/ch_' + chNum + '.xhtml', ab: doneChaps[i].ab });
        transferList.push(doneChaps[i].ab);
      }

      const zipAb = await new Promise((resolve, reject) => {
        const zw = spawnTrackedWorker(zipUrl);
        const onCancel = () => { killTrackedWorker(zw); reject(new Error('Đã hủy chuyển đổi')); };
        cancelListeners.add(onCancel);
        zw.onmessage = (ev) => {
          cancelListeners.delete(onCancel);
          killTrackedWorker(zw);
          if (ev.data && ev.data.type === 'zipBuilt') resolve(ev.data.ab);
          else reject(new Error((ev.data && ev.data.message) || 'Lỗi đóng gói ZIP'));
        };
        zw.onerror = (e) => {
          cancelListeners.delete(onCancel);
          killTrackedWorker(zw);
          reject(new Error(e.message || 'ZipWorker crash'));
        };
        zw.postMessage({ type: 'buildKepubFromParts', files: filesMsg }, transferList);
      });

      return new Blob([zipAb], { type: 'application/epub+zip' });
    } catch (err) {
      if (cancelConvertRequested || (err && String(err.message).includes('Đã hủy'))) throw err;
      // Fallback to main thread if Worker blocked in local file:// sandbox
    }
  }

  // Fallback main-thread packager
  await ensureJSZip();
  const zip = new window.JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', containerXml, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
  zip.file('OEBPS/style.css', styleCss, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
  if (extraImages && extraImages.length) {
    for (const img of extraImages) {
      zip.file('OEBPS/' + img.path, img.bytes, { compression: 'STORE' });
    }
  }
  for (let i = 0; i < chapters.length; i++) {
    if (cancelConvertRequested) throw new Error('Đã hủy chuyển đổi');
    const chNum = String(i + 1).padStart(3, '0');
    const chTitle = chapters[i].title || ('Phần ' + (i + 1));
    const xhtmlBody = injectKoboSpansIntoHtmlBody(chapters[i].bodyHtml, i + 1);
    const xhtml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi">\n' +
      '<head>\n' +
      '  <meta http-equiv="Content-Type" content="application/xhtml+xml; charset=utf-8"/>\n' +
      '  <title>' + escapeXml(chTitle) + '</title>\n' +
      '  <link rel="stylesheet" type="text/css" href="style.css"/>\n' +
      '</head>\n' +
      '<body>\n' + xhtmlBody + '\n</body>\n</html>\n';
    zip.file('OEBPS/ch_' + chNum + '.xhtml', xhtml, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
    if (i % 8 === 7) await new Promise(r => setTimeout(r, 0));
  }
  zip.file('OEBPS/content.opf', opf, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
  zip.file('OEBPS/toc.ncx', ncx, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
  return await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

// Split a big HTML string into lightweight <= 36KB strict-XHTML chapters so 256MB RAM Kobo never lags
function splitHtmlIntoLightweightChapters(rawHtml, fallbackTitle) {
  const parser = new DOMParser();
  const doc = parser.parseFromString('<!DOCTYPE html><html><body>' + rawHtml + '</body></html>', 'text/html');
  const chapters = [];
  let curTitle = fallbackTitle || 'Phần 1';
  let curNodes = [];
  let curLen = 0;
  const MAX_CHARS = 32000;

  const flush = () => {
    if (curNodes.length === 0) return;
    chapters.push({ title: curTitle, bodyHtml: curNodes.join('\n') });
    curNodes = [];
    curLen = 0;
  };

  for (const node of Array.from(doc.body.childNodes)) {
    if (node.nodeType === 1) {
      const tag = node.tagName.toUpperCase();
      // Serialize cleanly as strict XML-safe XHTML right here so SpanWorkers run at pure-JS speed!
      const xhtmlNode = htmlElementToXhtml(node);
      if ((tag === 'H1' || tag === 'H2') && curLen > 1200) {
        flush();
        curTitle = (node.textContent || '').trim().slice(0, 90) || ('Chương ' + (chapters.length + 1));
      } else if (curLen + xhtmlNode.length > MAX_CHARS && curNodes.length > 0) {
        flush();
        curTitle = fallbackTitle + ' — Phần ' + (chapters.length + 1);
      }
      curNodes.push(xhtmlNode);
      curLen += xhtmlNode.length;
    } else if (node.nodeType === 3 && (node.nodeValue || '').trim()) {
      const p = '<p>' + escapeXml((node.nodeValue || '').trim()) + '</p>';
      curNodes.push(p);
      curLen += p.length;
    }
  }
  flush();
  if (chapters.length === 0) {
    chapters.push({ title: fallbackTitle, bodyHtml: '<p>(Tài liệu trống)</p>' });
  }
  return chapters;
}

// 1. Multi-Threaded .EPUB -> .KEPUB.EPUB (ZipWorker + Parallel SpanWorkerPool + Media STORE fast-path!)
async function convertEpubToKepub(file, onStatus) {
  const targetThreads = getConfiguredWorkerCount(file.size, false);
  const ab = await file.arrayBuffer();

  if (typeof Worker !== 'undefined') {
    let zw = null;
    try {
      const zipUrl = await getZipWorkerUrl();
      onStatus('Đang giải nén EPUB trên luồng nền...', 8);
      zw = spawnTrackedWorker(zipUrl);

      const xhtmlTasks = await new Promise((resolve, reject) => {
        const onCancel = () => { killTrackedWorker(zw); reject(new Error('Đã hủy chuyển đổi')); };
        cancelListeners.add(onCancel);
        zw.onmessage = (ev) => {
          cancelListeners.delete(onCancel);
          if (ev.data && ev.data.type === 'epubUnpacked') resolve(ev.data.xhtmlTasks || []);
          else reject(new Error((ev.data && ev.data.message) || 'Lỗi giải nén EPUB'));
        };
        zw.onerror = (e) => {
          cancelListeners.delete(onCancel);
          reject(new Error(e.message || 'ZipWorker error'));
        };
        const abCopy = ab.slice(0);
        zw.postMessage({ type: 'unpackEpubForSpanPool', epubAb: abCopy }, [abCopy]);
      });

      let doneChapters = [];
      let usedThreads = 1;
      if (xhtmlTasks.length > 0) {
        usedThreads = Math.max(1, Math.min(targetThreads, xhtmlTasks.length, 12));
        doneChapters = await runSpanWorkerPool(xhtmlTasks, 'transformEpubXhtml', usedThreads, (done, total, activeW) => {
          const pct = 15 + Math.round((done * 68) / Math.max(1, total));
          if (done === 1 || done % 4 === 0 || done === total) {
            onStatus('Đang tối ưu KePub (' + activeW + ' luồng): Chương ' + done + '/' + total + '...', pct);
          }
        });
      }

      onStatus('Đang đóng gói .kepub.epub tốc độ cao...', 90);
      const transfers = doneChapters.map(c => c.ab);
      const outAb = await new Promise((resolve, reject) => {
        const onCancel = () => { killTrackedWorker(zw); reject(new Error('Đã hủy chuyển đổi')); };
        cancelListeners.add(onCancel);
        zw.onmessage = (ev) => {
          cancelListeners.delete(onCancel);
          if (ev.data && ev.data.type === 'epubFinished') resolve(ev.data.ab);
          else reject(new Error((ev.data && ev.data.message) || 'Lỗi nén KePub'));
        };
        zw.onerror = (e) => {
          cancelListeners.delete(onCancel);
          reject(new Error(e.message || 'ZipWorker pack error'));
        };
        zw.postMessage({ type: 'finishEpubFromSpanPool', doneChapters: doneChapters }, transfers);
      });
      killTrackedWorker(zw);
      zw = null;

      return {
        blob: new Blob([outAb], { type: 'application/epub+zip' }),
        outName: stripExt(file.name) + '.kepub.epub',
        summary: 'EPUB → KePub (' + usedThreads + ' luồng)'
      };
    } catch (err) {
      if (zw) killTrackedWorker(zw);
      if (cancelConvertRequested || (err && String(err.message).includes('Đã hủy'))) throw err;
    }
  }

  // Fallback main-thread EPUB -> KePub
  await ensureJSZip();
  onStatus('Đang giải nén EPUB...', 10);
  const srcZip = await window.JSZip.loadAsync(ab);
  const outZip = new window.JSZip();
  outZip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  const storeExtRe = /\.(jpe?g|png|gif|webp|avif|bmp|ttf|otf|woff2?|mp3|mp4)$/i;

  const entries = Object.keys(srcZip.files);
  let htmlIdx = 0;
  for (let i = 0; i < entries.length; i++) {
    if (cancelConvertRequested) throw new Error('Đã hủy chuyển đổi');
    const path = entries[i];
    const entry = srcZip.files[path];
    if (entry.dir || path === 'mimetype') continue;
    const lower = path.toLowerCase();
    if (lower.endsWith('.css')) {
      let css = await entry.async('string');
      css = css.replace(/(^|[;{]\s*)(color|background-color)\s*:[^;{}]+;?/gi, '$1');
      outZip.file(path, css, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
    } else if ((lower.endsWith('.xhtml') || lower.endsWith('.html') || lower.endsWith('.htm')) && !lower.includes('toc') && !lower.includes('nav')) {
      htmlIdx++;
      onStatus('Đang tối ưu KePub trang ' + htmlIdx + '...', 20 + Math.round((i * 65) / entries.length));
      let content = await entry.async('string');
      if (!content.includes('koboSpan')) {
        const m = content.match(/(<body[^>]*>)([\s\S]*)(<\/body>)/i);
        if (m) {
          content = content.slice(0, m.index) + m[1] + injectKoboSpansIntoHtmlBody(m[2], htmlIdx) + m[3] + content.slice(m.index + m[0].length);
        }
      }
      outZip.file(path, content, { compression: 'DEFLATE', compressionOptions: { level: 4 } });
    } else {
      const u8 = await entry.async('uint8array');
      outZip.file(path, u8, storeExtRe.test(lower) ? { compression: 'STORE' } : { compression: 'DEFLATE', compressionOptions: { level: 4 } });
    }
  }
  onStatus('Đang đóng gói .kepub.epub...', 92);
  const blob = await outZip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
  return { blob, outName: stripExt(file.name) + '.kepub.epub', summary: 'EPUB → KePub chuẩn Kobo' };
}

// 2. Convert .DOCX -> .KEPUB.EPUB (direct binary image extraction + multi-threaded KePub packaging!)
async function convertDocxToKepub(file, onStatus) {
  await ensureMammoth();
  onStatus('Đang đọc tài liệu Word (.docx)...', 12);
  const ab = await file.arrayBuffer();
  const extraImages = [];
  let imgSeq = 0;

  const res = await window.mammoth.convertToHtml(
    { arrayBuffer: ab },
    {
      convertImage: window.mammoth.images.imgElement(async function(image) {
        imgSeq++;
        const ct = image.contentType || 'image/png';
        const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : (ct.includes('gif') ? 'gif' : 'png');
        const relPath = 'images/img_' + imgSeq + '.' + ext;
        let u8;
        if (typeof image.readAsArrayBuffer === 'function') {
          const imgAb = await image.readAsArrayBuffer();
          u8 = new Uint8Array(imgAb);
        } else {
          const b64 = await image.read('base64');
          const bin = atob(b64);
          u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        }
        extraImages.push({ path: relPath, bytes: u8, mediaType: ct });
        return { src: relPath };
      })
    }
  );

  const title = stripExt(file.name);
  const chapters = splitHtmlIntoLightweightChapters('<h1>' + escapeXml(title) + '</h1>\n' + (res.value || ''), title);
  const blob = await packageKepubFromChapters(title, chapters, extraImages, (m) => onStatus(m, 75));
  return { blob, outName: title + '.kepub.epub', summary: 'DOCX → KePub (' + chapters.length + ' chương)' };
}

// 3. Convert .TXT / .MD / .HTML -> .KEPUB.EPUB
async function convertTextOrHtmlToKepub(file, onStatus) {
  onStatus('Đang xử lý văn bản...', 15);
  const ab = await file.arrayBuffer();
  const u8 = new Uint8Array(ab);
  let text = '';
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
    text = new TextDecoder('utf-16le').decode(u8);
  } else if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
    text = new TextDecoder('utf-16be').decode(u8);
  } else {
    text = new TextDecoder('utf-8', { fatal: false }).decode(u8);
  }

  const title = stripExt(file.name);
  const lower = file.name.toLowerCase();
  let html = '';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const m = text.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    html = m ? m[1] : text;
  } else {
    const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
    const parts = ['<h1>' + escapeXml(title) + '</h1>'];
    for (const raw of blocks) {
      const b = raw.trim();
      if (!b) continue;
      if (/^(#{1,3}\s+|chương\s+\d+|phần\s+\d+|chapter\s+\d+)/i.test(b) && b.length < 110) {
        parts.push('<h2>' + escapeXml(b.replace(/^#{1,3}\s+/, '')) + '</h2>');
      } else {
        parts.push('<p>' + escapeXml(b).replace(/\n/g, '<br/>') + '</p>');
      }
    }
    html = parts.join('\n');
  }
  const chapters = splitHtmlIntoLightweightChapters(html, title);
  const blob = await packageKepubFromChapters(title, chapters, [], (m) => onStatus(m, 75));
  return { blob, outName: title + '.kepub.epub', summary: 'Văn bản → KePub (' + chapters.length + ' chương)' };
}

function looksLikeGarbledLegacyOrMath(sampleText) {
  if (!sampleText) return true;
  const vniHits = (sampleText.match(/(ñaõ|ñöôïc|ieân|ôû|ñieàu|ngöôøi|khoâng|nhöõng|trong\s+ñoù|æ|ø|ö|ï)/gi) || []).length;
  if (vniHits >= 8 && vniHits / Math.max(1, sampleText.length / 100) > 0.6) return true;
  const replacementHits = (sampleText.match(/\uFFFD/g) || []).length;
  if (replacementHits > sampleText.length * 0.04) return true;
  return false;
}

function detectJpegColorSpace(jpegBytes) {
  let i = 2;
  while (i + 9 < jpegBytes.length) {
    if (jpegBytes[i] !== 0xFF) { i++; continue; }
    const marker = jpegBytes[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      i += 2;
      continue;
    }
    const segLen = (jpegBytes[i + 2] << 8) | jpegBytes[i + 3];
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
      const comps = jpegBytes[i + 9];
      return comps === 1 ? '/DeviceGray' : '/DeviceRGB';
    }
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return '/DeviceRGB';
}

function buildFlatPdfFromJpegs(pages) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let pos = 0;

  const pushStr = (s) => {
    const b = enc.encode(s);
    chunks.push(b);
    pos += b.byteLength;
  };
  const pushBytes = (u8) => {
    chunks.push(u8);
    pos += u8.byteLength;
  };

  pushBytes(new Uint8Array([0x25,0x50,0x44,0x46,0x2D,0x31,0x2E,0x34,0x0A,0x25,0xE2,0xE3,0xCF,0xD3,0x0A]));

  const pageObjNums = [];
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(3 + i * 3);
  }

  offsets[1] = pos;
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  offsets[2] = pos;
  const kidsRefs = pageObjNums.map(n => n + ' 0 R').join(' ');
  pushStr('2 0 obj\n<< /Type /Pages /Count ' + pages.length + ' /Kids [' + kidsRefs + '] >>\nendobj\n');

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pObj = 3 + i * 3;
    const cObj = pObj + 1;
    const iObj = pObj + 2;

    const ptW = +(p.width * 72 / 150).toFixed(2);
    const ptH = +(p.height * 72 / 150).toFixed(2);
    const contentCmd = 'q ' + ptW + ' 0 0 ' + ptH + ' 0 0 cm /Im0 Do Q\n';
    const csName = detectJpegColorSpace(p.jpegBytes);

    offsets[pObj] = pos;
    pushStr(
      pObj + ' 0 obj\n' +
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + ptW + ' ' + ptH + '] ' +
      '/Resources << /XObject << /Im0 ' + iObj + ' 0 R >> >> ' +
      '/Contents ' + cObj + ' 0 R >>\n' +
      'endobj\n'
    );

    offsets[cObj] = pos;
    const cmdBytes = enc.encode(contentCmd);
    pushStr(cObj + ' 0 obj\n<< /Length ' + cmdBytes.byteLength + ' >>\nstream\n');
    pushBytes(cmdBytes);
    pushStr('endstream\nendobj\n');

    offsets[iObj] = pos;
    pushStr(
      iObj + ' 0 obj\n' +
      '<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height +
      ' /ColorSpace ' + csName + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpegBytes.byteLength + ' >>\n' +
      'stream\n'
    );
    pushBytes(p.jpegBytes);
    pushStr('\nendstream\nendobj\n');
  }

  const totalObjs = 2 + pages.length * 3;
  const xrefPos = pos;
  let xref = 'xref\n0 ' + (totalObjs + 1) + '\n0000000000 65535 f \n';
  for (let k = 1; k <= totalObjs; k++) {
    xref += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  }
  pushStr(xref);
  pushStr(
    'trailer\n<< /Size ' + (totalObjs + 1) + ' /Root 1 0 R >>\n' +
    'startxref\n' + xrefPos + '\n%%EOF\n'
  );

  return new Blob(chunks, { type: 'application/pdf' });
}

// Assemble extracted page line arrays into paragraphs + chapters
function assembleParagraphsFromPageResults(baseTitle, pageResults) {
  const paragraphs = ['<h1>' + escapeXml(baseTitle) + '</h1>'];
  let curPara = '';

  const flushPara = () => {
    const t = curPara.trim();
    if (t) paragraphs.push('<p>' + escapeXml(t) + '</p>');
    curPara = '';
  };

  for (let pIdx = 0; pIdx < pageResults.length; pIdx++) {
    const pg = pageResults[pIdx];
    if (!pg || !pg.lines) continue;
    const lines = pg.lines;
    const medianH = pg.medianH || 11;

    for (let li = 0; li < lines.length; li++) {
      const ln = (lines[li].text || '').trim();
      if (!ln) continue;
      const isHeading = (lines[li].h >= medianH * 1.24 && ln.length < 110) || /^(chương|phần|chapter|mục)\s+[\dIVXLCDM]+/i.test(ln);
      if (isHeading) {
        flushPara();
        paragraphs.push('<h2>' + escapeXml(ln) + '</h2>');
        continue;
      }
      const prevLine = li > 0 ? lines[li - 1] : null;
      const yGap = prevLine ? (prevLine.y - lines[li].y) : 0;
      if (yGap > medianH * 1.75 || /^[-•*–—]\s+/.test(ln)) {
        flushPara();
      }
      if (!curPara) {
        curPara = ln;
      } else if (curPara.endsWith('-') && /^[a-zà-ỹ]/i.test(ln)) {
        curPara = curPara.slice(0, -1) + ln;
      } else {
        curPara += ' ' + ln;
      }
      if (/[.!?…:"”»]$/.test(ln) && ln.length < 58) {
        flushPara();
      }
    }
  }
  flushPara();
  return paragraphs;
}

// ============================================================================
// MULTI-THREADED PDF WORKER POOL EXECUTION (OffscreenCanvas + Dynamic Stealing)
// ============================================================================

const idlePdfWorkers = [];
let idlePdfReapTimer = null;

function clearIdlePdfWorkers() {
  if (idlePdfReapTimer) {
    clearTimeout(idlePdfReapTimer);
    idlePdfReapTimer = null;
  }
  while (idlePdfWorkers.length > 0) {
    const w = idlePdfWorkers.pop();
    try { w.terminate(); } catch (_) {}
    activeWorkers.delete(w);
  }
}

function scheduleIdlePdfReap() {
  if (idlePdfReapTimer) clearTimeout(idlePdfReapTimer);
  idlePdfReapTimer = setTimeout(clearIdlePdfWorkers, 45000);
}

function borrowPdfWorker(workerUrl) {
  if (idlePdfWorkers.length > 0) {
    const w = idlePdfWorkers.pop();
    activeWorkers.add(w);
    return w;
  }
  return spawnTrackedWorker(workerUrl);
}

async function releasePdfWorkerToWarmPool(w) {
  if (!w) return;
  if (cancelConvertRequested || idlePdfWorkers.length >= 8) {
    killTrackedWorker(w);
    return;
  }
  try {
    await runWorkerRpc(w, { type: 'close' });
    w.onmessage = null;
    w.onerror = null;
    activeWorkers.delete(w);
    idlePdfWorkers.push(w);
    scheduleIdlePdfReap();
  } catch (_) {
    killTrackedWorker(w);
  }
}

let prewarmingPromise = null;
function prewarmPdfWorkerPool() {
  if (!supportsOffscreenPdfWorkers() || prewarmingPromise || idlePdfWorkers.length >= 4) return;
  prewarmingPromise = (async () => {
    try {
      const workerUrl = await getPdfPoolWorkerUrl();
      const targetWarm = Math.min(6, getConfiguredWorkerCount(25 * 1048576, true));
      while (idlePdfWorkers.length < targetWarm) {
        const w = new Worker(workerUrl);
        idlePdfWorkers.push(w);
      }
      scheduleIdlePdfReap();
    } catch (_) {
    } finally {
      prewarmingPromise = null;
    }
  })();
}

if (typeof document !== 'undefined') {
  const hookPrewarm = () => {
    const dz = document.getElementById('dropzone');
    if (dz) {
      dz.addEventListener('mouseenter', prewarmPdfWorkerPool, { passive: true });
      dz.addEventListener('touchstart', prewarmPdfWorkerPool, { passive: true });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hookPrewarm);
  else setTimeout(hookPrewarm, 0);
}

function supportsOffscreenPdfWorkers() {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function'
  );
}

function initSinglePdfWorker(workerUrl, pdfAb) {
  return new Promise((resolve, reject) => {
    const w = borrowPdfWorker(workerUrl);
    const onCancel = () => { killTrackedWorker(w); reject(new Error('Đã hủy chuyển đổi')); };
    cancelListeners.add(onCancel);

    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'ready') {
        cancelListeners.delete(onCancel);
        resolve({ worker: w, numPages: m.numPages });
      } else if (m.type === 'error') {
        cancelListeners.delete(onCancel);
        killTrackedWorker(w);
        reject(new Error(m.message || 'Lỗi khởi tạo nhân PDF'));
      }
    };
    w.onerror = (e) => {
      cancelListeners.delete(onCancel);
      killTrackedWorker(w);
      reject(new Error(e.message || 'PDF Worker crash'));
    };

    const copy = pdfAb.slice(0);
    w.postMessage({ type: 'init', pdfAb: copy }, [copy]);
  });
}

function runWorkerRpc(w, payload) {
  return new Promise((resolve, reject) => {
    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'error') reject(new Error(m.message || 'PDF Worker RPC error'));
      else resolve(m);
    };
    w.onerror = (e) => reject(new Error(e.message || 'PDF Worker RPC crash'));
    w.postMessage(payload);
  });
}

async function runPoolAcrossPages(workers, totalPages, taskType, onPageDone) {
  const results = new Array(totalPages);
  let nextPage = 1;
  let completed = 0;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cancelListeners.delete(onCancel);
      reject(err);
    };
    const onCancel = () => fail(new Error('Đã hủy chuyển đổi'));
    cancelListeners.add(onCancel);
    if (cancelConvertRequested) return onCancel();

    const assignNext = (w) => {
      if (settled) return;
      if (cancelConvertRequested) return onCancel();
      if (nextPage > totalPages) return;
      const p = nextPage++;
      w.postMessage({ type: taskType, pageNum: p });
    };

    for (const w of workers) {
      w.onmessage = (ev) => {
        if (settled) return;
        const m = ev.data || {};
        if (m.type === 'error') {
          return fail(new Error('Trang ' + (m.pageNum || '?') + ': ' + (m.message || 'Lỗi xử lý PDF')));
        }
        results[m.pageNum - 1] = m;
        completed++;
        if (onPageDone) onPageDone(completed, totalPages, workers.length, m);
        if (completed >= totalPages) {
          settled = true;
          cancelListeners.delete(onCancel);
          resolve(results);
        } else {
          assignNext(w);
        }
      };
      w.onerror = (e) => fail(new Error(e.message || 'Luồng PDF gặp sự cố'));
      assignNext(w);
    }
  });
}

async function convertPdfMultiThreaded(pdfAb, baseTitle, mode, targetThreads, onStatus) {
  const workerUrl = await getPdfPoolWorkerUrl();
  const pool = [];

  try {
    onStatus('Đang kích hoạt ' + targetThreads + ' luồng CPU xử lý PDF song song...', 3);
    // Boot ALL targetThreads workers in parallel at t=0 (reusing warm pool if available!)
    const initPromises = [];
    for (let k = 0; k < targetThreads; k++) {
      initPromises.push(initSinglePdfWorker(workerUrl, pdfAb));
    }
    const inited = await Promise.all(initPromises);
    const numPages = inited[0].numPages;

    const desiredWorkers = Math.max(1, Math.min(inited.length, numPages));
    for (let i = 0; i < inited.length; i++) {
      if (i < desiredWorkers) pool.push(inited[i].worker);
      else await releasePdfWorkerToWarmPool(inited[i].worker);
    }

    let chosenAction = 'flatten';
    if (mode !== 'pdf_flatten') {
      const sampleCount = Math.min(10, numPages);
      let totalChars = 0;
      let sampleConcat = '';
      const samplePages = [];
      for (let i = 0; i < sampleCount; i++) {
        samplePages.push(Math.max(1, Math.min(numPages, Math.floor(((i + 0.5) * numPages) / sampleCount) + 1)));
      }
      for (let off = 0; off < samplePages.length; off += pool.length) {
        if (cancelConvertRequested) throw new Error('Đã hủy chuyển đổi');
        const batch = samplePages.slice(off, off + pool.length);
        const infos = await Promise.all(
          batch.map((pNum, bi) => runWorkerRpc(pool[bi], { type: 'extractTextPage', pageNum: pNum }))
        );
        for (const info of infos) {
          totalChars += info.rawChars || 0;
          sampleConcat += ' ' + (info.sampleStr || '');
        }
      }
      const avgChars = totalChars / Math.max(1, sampleCount);
      const garbled = looksLikeGarbledLegacyOrMath(sampleConcat);
      if ((avgChars >= 160 && !garbled) || (mode === 'force_kepub' && avgChars >= 30)) {
        chosenAction = 'text';
      }
    }

    const tStart = performance.now();
    let lastUiTick = 0;

    if (chosenAction === 'flatten') {
      const rawPages = await runPoolAcrossPages(pool, numPages, 'flattenPage', (done, total, activeW) => {
        const now = performance.now();
        if (done === 1 || done === total || now - lastUiTick >= 65) {
          lastUiTick = now;
          const elapsedSec = Math.max(0.08, (now - tStart) / 1000);
          const pps = (done / elapsedSec).toFixed(1);
          const pct = Math.min(98, Math.max(6, Math.round((done * 96) / total)));
          onStatus(
            'Phẳng hóa E-Ink (' + activeW + ' luồng): ' + done + ' / ' + total + ' trang',
            pct,
            pct + '% • ' + pps + ' trang/s'
          );
        }
      });

      // Immediately close pdfDoc in every worker (freeing PDF RAM) & return warm workers to pool!
      const toRelease = pool.splice(0, pool.length);
      await Promise.all(toRelease.map(releasePdfWorkerToWarmPool));

      onStatus('Đang đóng gói PDF phẳng chuẩn E-Ink (' + numPages + ' trang)...', 99, '99%');
      const pagesOut = rawPages.map(r => ({
        width: r.width,
        height: r.height,
        jpegBytes: new Uint8Array(r.jpegAb)
      }));
      const blob = buildFlatPdfFromJpegs(pagesOut);
      const cleanBase = baseTitle.replace(/\s*\[E-Ink\]$/i, '');
      return {
        blob,
        outName: cleanBase + ' [E-Ink].pdf',
        summary: 'PDF Phẳng E-Ink (' + numPages + ' trang • ' + desiredWorkers + ' luồng)'
      };
    } else {
      const textPages = await runPoolAcrossPages(pool, numPages, 'extractTextPage', (done, total, activeW) => {
        const now = performance.now();
        if (done === 1 || done === total || now - lastUiTick >= 65) {
          lastUiTick = now;
          const elapsedSec = Math.max(0.08, (now - tStart) / 1000);
          const pps = (done / elapsedSec).toFixed(0);
          const pct = Math.min(86, Math.max(6, Math.round((done * 84) / total)));
          onStatus(
            'Trích xuất chữ PDF (' + activeW + ' luồng): ' + done + ' / ' + total + ' trang',
            pct,
            pct + '% • ' + pps + ' trang/s'
          );
        }
      });

      const toRelease = pool.splice(0, pool.length);
      await Promise.all(toRelease.map(releasePdfWorkerToWarmPool));

      const paragraphs = assembleParagraphsFromPageResults(baseTitle, textPages);
      const chapters = splitHtmlIntoLightweightChapters(paragraphs.join('\n'), baseTitle);
      const blob = await packageKepubFromChapters(baseTitle, chapters, [], (msg) => onStatus(msg, 94));
      return {
        blob,
        outName: baseTitle + '.kepub.epub',
        summary: 'PDF Chữ → KePub (' + chapters.length + ' chương • ' + desiredWorkers + ' luồng)'
      };
    }
  } finally {
    for (const w of pool) killTrackedWorker(w);
  }
}

// ============================================================================
// LUT-ACCELERATED SINGLE-THREAD FALLBACK (For legacy browsers without OffscreenCanvas)
// ============================================================================

function cropAndEnhanceEinkCanvas(srcCanvas, dstCanvas) {
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = sctx.getImageData(0, 0, sw, sh);
  const d = imgData.data;

  const bx0 = Math.floor(sw * 0.012);
  const bx1 = Math.ceil(sw * 0.988);
  const by0 = Math.floor(sh * 0.012);
  const by1 = Math.ceil(sh * 0.988);

  let minX = bx1, maxX = bx0, minY = by1, maxY = by0;
  const rowHits = new Uint16Array(sh);
  const colHits = new Uint16Array(sw);

  for (let y = by0; y < by1; y += 2) {
    const rowOff = y * sw * 4;
    for (let x = bx0; x < bx1; x += 2) {
      const idx = rowOff + x * 4;
      const lum = (d[idx] * 77 + d[idx + 1] * 150 + d[idx + 2] * 29) >> 8;
      if (lum < 218) {
        rowHits[y]++;
        colHits[x]++;
      }
    }
  }

  for (let y = by0; y < by1; y += 2) {
    if (rowHits[y] >= 3) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  for (let x = bx0; x < bx1; x += 2) {
    if (colHits[x] >= 3) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
  }

  let cx = 0, cy = 0, cw = sw, ch = sh;
  if (maxX > minX + sw * 0.18 && maxY > minY + sh * 0.18) {
    const padX = Math.round(sw * 0.024);
    const padY = Math.round(sh * 0.024);
    cx = Math.max(0, minX - padX);
    cy = Math.max(0, minY - padY);
    cw = Math.min(sw - cx, (maxX - minX) + padX * 2);
    ch = Math.min(sh - cy, (maxY - minY) + padY * 2);
  }

  const MAX_W = 910;
  const MAX_H = 1230;
  const scale = Math.min(1, MAX_W / cw, MAX_H / ch);
  const tw = Math.max(64, Math.round(cw * scale));
  const th = Math.max(64, Math.round(ch * scale));

  dstCanvas.width = tw;
  dstCanvas.height = th;
  const dctx = dstCanvas.getContext('2d', { willReadFrequently: true });
  dctx.fillStyle = '#ffffff';
  dctx.fillRect(0, 0, tw, th);
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(srcCanvas, cx, cy, cw, ch, 0, 0, tw, th);

  const outImg = dctx.getImageData(0, 0, tw, th);
  const od = outImg.data;
  const u32 = new Uint32Array(od.buffer, od.byteOffset, tw * th);
  for (let p = 0, i = 0; p < u32.length; p++, i += 4) {
    const lum = (od[i] * 77 + od[i + 1] * 150 + od[i + 2] * 29) >> 8;
    u32[p] = EINK_RGBA32_LUT[lum];
  }
  dctx.putImageData(outImg, 0, 0);
}

function canvasToJpegBytes(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) return reject(new Error('Lỗi nén ảnh JPEG trang PDF'));
      const ab = await blob.arrayBuffer();
      resolve(new Uint8Array(ab));
    }, 'image/jpeg', quality);
  });
}

async function convertPdfFallbackMainThread(pdfAb, baseTitle, mode, onStatus) {
  await ensurePdfJsMainThread();
  const loadingTask = window.pdfjsLib.getDocument({ data: new Uint8Array(pdfAb), isEvalSupported: false });
  const pdfDoc = await loadingTask.promise;

  try {
    const numPages = pdfDoc.numPages;
    let useText = false;
    if (mode !== 'pdf_flatten') {
      const sampleCount = Math.min(10, numPages);
      let totalChars = 0;
      let sampleConcat = '';
      for (let i = 0; i < sampleCount; i++) {
        const pNum = Math.max(1, Math.min(numPages, Math.floor(((i + 0.5) * numPages) / sampleCount) + 1));
        const pg = await pdfDoc.getPage(pNum);
        const tc = await pg.getTextContent();
        const pgTxt = (tc.items || []).map(x => x.str || '').join(' ').trim();
        totalChars += pgTxt.length;
        sampleConcat += ' ' + pgTxt.slice(0, 600);
        pg.cleanup();
      }
      const avgChars = totalChars / Math.max(1, sampleCount);
      const garbled = looksLikeGarbledLegacyOrMath(sampleConcat);
      if ((avgChars >= 160 && !garbled) || (mode === 'force_kepub' && avgChars >= 30)) {
        useText = true;
      }
    }

    if (!useText) {
      const renderCanvas = document.createElement('canvas');
      const outCanvas = document.createElement('canvas');
      const rctx = renderCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
      const pagesOut = [];
      const tStart = performance.now();

      for (let p = 1; p <= numPages; p++) {
        if (cancelConvertRequested) throw new Error('Đã hủy chuyển đổi');
        const pct = Math.round((p * 98) / numPages);
        const pps = (p / Math.max(0.1, (performance.now() - tStart) / 1000)).toFixed(1);
        onStatus('Phẳng hóa E-Ink (1 luồng): ' + p + ' / ' + numPages + ' trang', pct, pct + '% • ' + pps + ' trang/s');

        const page = await pdfDoc.getPage(p);
        const vp1 = page.getViewport({ scale: 1 });
        const renderScale = Math.min(2.4, Math.max(1.0, 1420 / Math.max(vp1.width, vp1.height)));
        const vp = page.getViewport({ scale: renderScale });

        renderCanvas.width = Math.max(1, Math.floor(vp.width));
        renderCanvas.height = Math.max(1, Math.floor(vp.height));
        rctx.fillStyle = '#ffffff';
        rctx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);

        await page.render({ canvasContext: rctx, viewport: vp, background: 'rgb(255,255,255)' }).promise;
        cropAndEnhanceEinkCanvas(renderCanvas, outCanvas);
        const jpegBytes = await canvasToJpegBytes(outCanvas, 0.78);
        pagesOut.push({ width: outCanvas.width, height: outCanvas.height, jpegBytes });
        page.cleanup();
        await new Promise(r => setTimeout(r, 0));
      }

      onStatus('Đang đóng gói PDF phẳng chuẩn E-Ink (' + numPages + ' trang)...', 99);
      const blob = buildFlatPdfFromJpegs(pagesOut);
      const cleanBase = baseTitle.replace(/\s*\[E-Ink\]$/i, '');
      return {
        blob,
        outName: cleanBase + ' [E-Ink].pdf',
        summary: 'PDF Phẳng E-Ink (' + numPages + ' trang, 1 lớp/trang)'
      };
    } else {
      const pageResults = [];
      for (let p = 1; p <= numPages; p++) {
        if (cancelConvertRequested) throw new Error('Đã hủy chuyển đổi');
        if (p === 1 || p % 5 === 0 || p === numPages) {
          onStatus('Trích xuất chữ PDF: Trang ' + p + ' / ' + numPages + '...', Math.round((p * 85) / numPages));
        }
        const page = await pdfDoc.getPage(p);
        const tc = await page.getTextContent();
        const vp = page.getViewport({ scale: 1 });
        const pageH = vp.height || 800;
        const items = [];
        for (const it of (tc.items || [])) {
          const s = (it.str || '');
          if (!s.trim()) continue;
          const tx = it.transform ? it.transform[4] : 0;
          const ty = it.transform ? it.transform[5] : 0;
          const fh = it.transform ? Math.hypot(it.transform[2], it.transform[3]) : (it.height || 11);
          if ((ty < pageH * 0.055 || ty > pageH * 0.945) && /^\s*[-–—]?\s*\d{1,4}\s*[-–—]?\s*$/.test(s)) continue;
          items.push({ s, x: tx, y: ty, h: fh || 11 });
        }
        items.sort((a, b) => (Math.abs(b.y - a.y) > 3.5 ? b.y - a.y : a.x - b.x));
        const lines = [];
        for (const it of items) {
          const last = lines[lines.length - 1];
          if (last && Math.abs(last.y - it.y) <= Math.max(3.5, last.h * 0.42)) {
            const gap = it.x - last.endX;
            last.text += (gap > last.h * 0.22 && !last.text.endsWith(' ') && !it.s.startsWith(' ') ? ' ' : '') + it.s;
            last.endX = Math.max(last.endX, it.x + it.s.length * it.h * 0.45);
            last.h = Math.max(last.h, it.h);
          } else {
            lines.push({ text: it.s, y: it.y, x: it.x, endX: it.x + it.s.length * it.h * 0.45, h: it.h });
          }
        }
        const medianH = lines.length ? lines.map(l => l.h).sort((a, b) => a - b)[Math.floor(lines.length / 2)] : 11;
        pageResults.push({ lines, medianH });
        page.cleanup();
      }
      const paragraphs = assembleParagraphsFromPageResults(baseTitle, pageResults);
      const chapters = splitHtmlIntoLightweightChapters(paragraphs.join('\n'), baseTitle);
      const blob = await packageKepubFromChapters(baseTitle, chapters, [], (msg) => onStatus(msg, 94));
      return {
        blob,
        outName: baseTitle + '.kepub.epub',
        summary: 'PDF Chữ → KePub (' + chapters.length + ' chương)'
      };
    }
  } finally {
    try { await pdfDoc.destroy(); } catch (_) {}
  }
}

// Master PDF router (prefers Multi-Threaded OffscreenCanvas Worker Pool)
async function convertPdfSmart(file, mode, onStatus) {
  onStatus('Đang đọc tệp PDF vào bộ nhớ đệm...', 2);
  const pdfAb = await file.arrayBuffer();
  const baseTitle = stripExt(file.name);
  const targetThreads = getConfiguredWorkerCount(pdfAb.byteLength, true);

  if (targetThreads > 1 && supportsOffscreenPdfWorkers()) {
    try {
      return await convertPdfMultiThreaded(pdfAb, baseTitle, mode, targetThreads, onStatus);
    } catch (err) {
      if (cancelConvertRequested || (err && String(err.message).includes('Đã hủy'))) {
        throw err;
      }
      console.warn('Multi-thread PDF pool fallback to main thread:', err);
    }
  }

  return await convertPdfFallbackMainThread(pdfAb, baseTitle, mode, onStatus);
}

// Entry point: maybeConvertFileForKobo(file, targetDir, mode, onStatus, forceExplicit)
async function maybeConvertFileForKobo(file, targetDir, mode, onStatus, forceExplicit) {
  if (!mode || mode === 'raw') return { file, converted: false };
  if (targetDir === '/fonts' || targetDir.includes('screensaver')) {
    return { file, converted: false };
  }

  const lower = file.name.toLowerCase();
  if (lower.endsWith('.kepub.epub') || lower.endsWith('.kepub')) {
    return { file, converted: false };
  }
  if (!forceExplicit && lower.endsWith('[e-ink].pdf') && mode === 'auto') {
    return { file, converted: false };
  }

  let res = null;
  if (lower.endsWith('.epub')) {
    res = await convertEpubToKepub(file, (m, p, sp) => onStatus(m, p, sp));
  } else if (lower.endsWith('.docx')) {
    res = await convertDocxToKepub(file, (m, p, sp) => onStatus(m, p, sp));
  } else if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.html') || lower.endsWith('.htm')) {
    res = await convertTextOrHtmlToKepub(file, (m, p, sp) => onStatus(m, p, sp));
  } else if (lower.endsWith('.pdf')) {
    res = await convertPdfSmart(file, mode, onStatus);
  } else {
    return { file, converted: false };
  }

  const outFile = new File([res.blob], res.outName, { type: res.blob.type || 'application/octet-stream' });
  return { file: outFile, converted: true, summary: res.summary };
}
