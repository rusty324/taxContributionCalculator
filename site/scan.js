// Browser-side paystub reading. PDFs with embedded text are read with pdf.js; scanned
// PDFs and photos go through Tesseract OCR. Both run locally: the libraries are
// downloaded from jsDelivr on first use, and the file itself never leaves the browser.
import { itemsToLines } from './paystub.js';

const PDFJS_VERSION = '6.3.289';
const TESSERACT_VERSION = '7.0.0';
const PDFJS = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.min.mjs`;
const PDFJS_WORKER = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/legacy/build/pdf.worker.min.mjs`;
const TESSERACT = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.esm.min.js`;
const TESSERACT_WORKER = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`;
const MAX_PAGES = 3;

let pdfjsPromise;
function loadPdfjs() {
  pdfjsPromise ||= import(PDFJS).then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    return m;
  });
  return pdfjsPromise;
}

// page.getTextContent() iterates a ReadableStream with `for await`, which Safari doesn't
// support. Read the same stream with a plain reader instead.
async function readTextItems(page) {
  const reader = page.streamTextContent().getReader();
  const items = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return items;
    items.push(...value.items);
  }
}

const isPdf = (file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

// Upscale small images and convert to high-contrast grayscale, which helps OCR on photos.
async function prepareImage(source) {
  const bmp = source instanceof HTMLCanvasElement ? source : await createImageBitmap(source);
  const w = bmp.width;
  const h = bmp.height;
  const scale = Math.min(3, Math.max(1, 2000 / Math.max(w, h)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.max(0, Math.min(255, (g - 128) * 1.4 + 128));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function ocr(images, onStatus) {
  onStatus('Loading text recognition (first time only, a few MB)…');
  const mod = await import(TESSERACT);
  const createWorker = mod.createWorker || mod.default.createWorker; // the ESM build only has a default export
  let page = 0;
  const worker = await createWorker('eng', 1, {
    workerPath: TESSERACT_WORKER,
    logger: (m) => {
      if (m.status === 'recognizing text') {
        const of = images.length > 1 ? ` (page ${page + 1} of ${images.length})` : '';
        onStatus(`Recognizing text${of}… ${Math.round(m.progress * 100)}%`);
      }
    },
  });
  try {
    // PSM 6 (one uniform block) keeps table rows together better than the default.
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const texts = [];
    for (; page < images.length; page++) {
      const { data } = await worker.recognize(await prepareImage(images[page]));
      texts.push(data.text);
    }
    return texts.join('\n');
  } finally {
    await worker.terminate();
  }
}

/** Returns { text, method: 'pdf' | 'ocr' }. */
export async function extractText(file, onStatus = () => {}) {
  if (!isPdf(file)) return { text: await ocr([file], onStatus), method: 'ocr' };

  onStatus('Reading PDF…');
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = Math.min(pdf.numPages, MAX_PAGES);
  const lines = [];
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n);
    lines.push(...itemsToLines(await readTextItems(page)));
  }
  if (lines.join('').replace(/\s/g, '').length > 40) return { text: lines.join('\n'), method: 'pdf' };

  // No usable text layer: a scanned PDF. Render each page and OCR it.
  onStatus('This PDF is a scan, rendering pages for text recognition…');
  const canvases = [];
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n);
    const viewport = page.getViewport({ scale: 2.5 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    canvases.push(canvas);
  }
  return { text: await ocr(canvases, onStatus), method: 'ocr' };
}
