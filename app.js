/* PDF 維修單自動判讀工具
 *
 * 目前只擷取：
 * 1. 聯絡人
 * 2. SR單號
 * 3. 機器型號
 * 4. 序號
 * 5. 客戶維修單號
 * 6. 故障現象
 * 7. 檢測說明
 * 8. 品名
 *
 * PDF.js：文字型 PDF 直接擷取。
 * Tesseract.js：若文字太少，對 PDF 頁面做 OCR。
 */

const FIELD_DEFS = [
  { key: "contact", label: "聯絡人", type: "input" },
  { key: "srNumber", label: "SR單號", type: "input" },
  { key: "model", label: "機器型號", type: "input" },
  { key: "serial", label: "序號", type: "input" },
  { key: "customerRepairNo", label: "客戶維修單號", type: "input" },
  { key: "problem", label: "故障現象", type: "textarea" },
  { key: "inspection", label: "檢測說明", type: "textarea" },
  { key: "products", label: "品名", type: "textarea" }
];

const state = {
  pdfjs: null,
  files: [],
  currentIndex: 0,
  pdfDoc: null,
  currentPage: 1,
  currentFile: null,
  fields: emptyFields(),
  rawText: "",
  ocrUsed: false
};

function emptyFields() {
  return {
    contact: "",
    srNumber: "",
    model: "",
    serial: "",
    customerRepairNo: "",
    problem: "",
    inspection: "",
    products: ""
  };
}

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function setStatus(text) {
  $("statusPill").textContent = text;
}

function normalizeText(text) {
  let normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // PDF 文字擷取可能把中文欄位拆成：
  // 「聯 絡 人」、「故 障 現 象」、「檢 測 說 明」
  // 把中文字之間不必要的空白移除
  let previous;

  do {
    previous = normalized;

    normalized = normalized.replace(
      /([\u3400-\u4dbf\u4e00-\u9fff])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff])/g,
      "$1"
    );

  } while (normalized !== previous);

  return normalized;
}

function cleanValue(value) {
  if (!value) return "";
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1]) return cleanValue(m[1]);
  }
  return "";
}

/* 以欄位標題為起點，抓到下一個指定標題以前。 */
function sectionBetween(text, starts, ends) {
  const startPattern = starts.map(escapeRegExp).join("|");
  const endPattern = ends.map(escapeRegExp).join("|");

  const re = new RegExp(
    "(?:" + startPattern + ")\\s*[:：]?\\s*([\\s\\S]*?)(?=(?:" + endPattern + ")|$)",
    "i"
  );

  const m = text.match(re);
  return cleanValue(m?.[1] || "");
}

function parseQuotation(text) {
  const normalized = normalizeText(text);
  const fields = emptyFields();

  fields.contact = firstMatch(normalized, [
  /聯絡人\s*[:：]\s*(.*?)(?=\s+報價日期\s*[:：]?)/i,
  /聯絡人\s*[:：]\s*(.*?)(?=\s+(?:統一編號|公司地址|承辦人員|公司電話)\s*[:：]?)/i
]);

  fields.srNumber = firstMatch(normalized, [
    /SR\s*單號\s*[:：]\s*([A-Z0-9-]+)/i,
    /SR單號\s*[:：]\s*([A-Z0-9-]+)/i
  ]);

  fields.customerRepairNo = firstMatch(normalized, [
    /客戶維修單號\s*[:：]\s*([A-Z0-9-]+)/i
  ]);

  /*
   * 範例格式：
   * PA768-QA6FRMDG.
   * UTA21520240227
   *
   * 機器型號取 PA768。
   */
  const machineBlock = normalized.match(
    /(?:機器品號\s*\/\s*序號|機器品號|機器型號)\s*([\s\S]{0,180})/i
  );

  if (machineBlock) {
    const block = machineBlock[1];
    const modelMatch = block.match(/\b(PA\d+)-/i);
    if (modelMatch) fields.model = modelMatch[1];

    const serialMatch = block.match(
      /\bPA\d+-[A-Z0-9.-]+\s+([A-Z0-9][A-Z0-9._-]{5,})\b/i
    );
    if (serialMatch) fields.serial = serialMatch[1];
  }

  if (!fields.model) {
    const modelMatch = normalized.match(/\b(PA\d+)-[A-Z0-9.-]+/i);
    if (modelMatch) fields.model = modelMatch[1];
  }

  if (!fields.serial) {
    const serialMatch = normalized.match(
      /\bPA\d+-[A-Z0-9.-]+\s*\n\s*([A-Z0-9][A-Z0-9._-]{5,})\b/i
    );
    if (serialMatch) fields.serial = serialMatch[1];
  }

  /*
   * 故障現象與檢測說明：
   * 這裡使用標題邊界，避免把後面的表格一起吃進來。
   */
  fields.problem = sectionBetween(
    normalized,
    ["故障現象"],
    ["檢測說明", "客戶維修單號", "客戶維修確認", "No."]
  );

  fields.inspection = sectionBetween(
    normalized,
    ["檢測說明"],
    ["客戶維修單號", "客戶維修確認", "No.", "料號"]
  );

  /*
   * 品名：
   * 從「品名」表頭之後，抓表格資料列。
   * 優先從常見格式中抓：
   * 料號 + 品名 + EA + 數量
   */
  const productNames = [];
  const lines = normalized.split("\n").map(x => x.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(
      /^\s*\d+\s+([A-Z0-9.-]+)\s+(.+?)\s+(?:EA|PCS|SET|個|件)\s+\d+(?:\s+[\d,]+)?(?:\s+[\d,]+)?\s*$/i
    );
    if (m) {
      const name = cleanValue(m[2]);
      if (name && !/^(品名|單位|數量|單價|金額)$/i.test(name)) {
        productNames.push(name);
      }
    }
  }

  /*
   * 如果 PDF 文字排序讓整列被拆開，再用固定的料號樣式 + 後續內容
   * 做第二次嘗試。
   */
  if (productNames.length === 0) {
    const tableStart = normalized.search(/料\s*號\s+品\s*名/i);
    if (tableStart >= 0) {
      const tableText = normalized.slice(tableStart);
      const candidates = [
        "上蓋模組",
        "玻璃保護貼",
        "厚電池",
        "庫內維修"
      ];

      for (const name of candidates) {
        if (tableText.includes(name)) productNames.push(name);
      }
    }
  }

  fields.products = [...new Set(productNames)].join("\n");

  return fields;
}

function renderFields() {
  const container = $("resultFields");
  container.innerHTML = "";

  for (const def of FIELD_DEFS) {
    const row = document.createElement("div");
    row.className = "field-row";

    const label = document.createElement("label");
    label.className = "field-label";
    label.textContent = def.label;

    const el = document.createElement(def.type === "textarea" ? "textarea" : "input");
    el.className = def.type === "textarea" ? "field-textarea" : "field-input";
    el.id = `field-${def.key}`;
    el.value = state.fields[def.key] || "";
    el.dataset.key = def.key;

    el.addEventListener("input", () => {
      state.fields[def.key] = el.value;
    });

    row.appendChild(label);
    row.appendChild(el);
    container.appendChild(row);
  }
}

function getEditedFields() {
  const result = {};
  for (const def of FIELD_DEFS) {
    result[def.key] = $(`field-${def.key}`)?.value ?? "";
  }
  return result;
}

function buildResultText() {
  const f = getEditedFields();

  return [
    `聯絡人：${f.contact}`,
    `SR單號：${f.srNumber}`,
    `機器型號：${f.model}`,
    `序號：${f.serial}`,
    `客戶維修單號：${f.customerRepairNo}`,
    "",
    "故障現象：",
    f.problem,
    "",
    "檢測說明：",
    f.inspection,
    "",
    "品名：",
    f.products
  ].join("\n").trim();
}

async function copyResult() {
  const text = buildResultText();

  if (!text) {
    showToast("目前沒有可複製的結果");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast("已複製判讀結果");
  } catch (error) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
    showToast("已複製判讀結果");
  }
}

function downloadResult() {
  const text = buildResultText();
  if (!text) {
    showToast("目前沒有可下載的結果");
    return;
  }

  const fileBase = state.currentFile
    ? state.currentFile.name.replace(/\.pdf$/i, "")
    : "PDF判讀結果";

  const blob = new Blob(["\ufeff", text], {
    type: "text/plain;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileBase}_判讀結果.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  showToast("TXT 已下載");
}

async function loadPdfJs() {
  if (state.pdfjs) return state.pdfjs;

  try {
    state.pdfjs = await import(
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs"
    );

    state.pdfjs.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

    return state.pdfjs;
  } catch (error) {
    console.error(error);
    throw new Error("無法載入 PDF.js。請確認網路連線。");
  }
}

async function extractPdfText(pdf) {
  let allText = "";

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
    const page = await pdf.getPage(pageNo);
    const content = await page.getTextContent();

    const pageText = content.items
  .map(item => `${item.str || ""}${item.hasEOL ? "\n" : " "}`)
  .join("");

    allText += `\n--- 第 ${pageNo} 頁 ---\n${pageText}\n`;
  }

  return normalizeText(allText);
}

async function renderPage(pageNo) {
  if (!state.pdfDoc) return;

  state.currentPage = Math.max(1, Math.min(pageNo, state.pdfDoc.numPages));

  const page = await state.pdfDoc.getPage(state.currentPage);
  const viewport = page.getViewport({ scale: 1.45 });
  const canvas = $("pdfCanvas");
  const context = canvas.getContext("2d");

  canvas.width = viewport.width;
  canvas.height = viewport.height;

  $("viewerEmpty").classList.add("hidden");

  await page.render({
    canvasContext: context,
    viewport
  }).promise;

  $("pageLabel").textContent =
    `第 ${state.currentPage} / ${state.pdfDoc.numPages} 頁`;

  $("prevPageBtn").disabled = state.currentPage <= 1;
  $("nextPageBtn").disabled = state.currentPage >= state.pdfDoc.numPages;
}

async function ocrPdf(pdf) {
  if (!window.Tesseract) {
    throw new Error("OCR 模組尚未載入。");
  }

  const worker = await Tesseract.createWorker("chi_tra+eng", 1, {
    logger: message => {
      if (message.status === "recognizing text" && message.progress) {
        setStatus(`OCR ${Math.round(message.progress * 100)}%`);
      }
    }
  });

  let result = "";

  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      setStatus(`OCR 第 ${pageNo} / ${pdf.numPages} 頁`);

      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({ scale: 2.0 });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      const context = canvas.getContext("2d");
      await page.render({
        canvasContext: context,
        viewport
      }).promise;

      const { data } = await worker.recognize(canvas);
      result += `\n--- 第 ${pageNo} 頁 ---\n${data.text}\n`;
    }
  } finally {
    await worker.terminate();
  }

  return normalizeText(result);
}

async function processFile(file) {
  if (!file || file.type !== "application/pdf") {
    showToast("請選擇 PDF 檔案");
    return;
  }

  state.currentFile = file;
  state.fields = emptyFields();
  state.rawText = "";
  state.ocrUsed = false;

  $("fileName").textContent = file.name;
  $("fileMeta").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $("toolbar").classList.remove("hidden");
  $("workspace").classList.remove("hidden");
  $("batchCard").classList.toggle("hidden", state.files.length <= 1);

  setStatus("讀取 PDF…");

  try {
    const pdfjs = await loadPdfJs();
    const buffer = await file.arrayBuffer();

    state.pdfDoc = await pdfjs.getDocument({
      data: buffer
    }).promise;

    await renderPage(1);

    let text = await extractPdfText(state.pdfDoc);

    /*
     * 如果擷取到的文字太少，視為掃描 PDF，改走 OCR。
     * 閾值可依實際文件調整。
     */
    if (text.replace(/[\s-]/g, "").length < 80) {
      state.ocrUsed = true;
      setStatus("文字不足，啟動 OCR…");
      text = await ocrPdf(state.pdfDoc);
    }

    state.rawText = text;
    state.fields = parseQuotation(text);

    renderFields();
    $("rawText").textContent = text;

    const filled = FIELD_DEFS.filter(d => state.fields[d.key]?.trim()).length;
    $("confidenceBadge").textContent =
      state.ocrUsed
        ? `OCR・${filled}/${FIELD_DEFS.length} 欄位`
        : `文字擷取・${filled}/${FIELD_DEFS.length} 欄位`;

    setStatus("判讀完成");
    showToast(`判讀完成：${filled}/${FIELD_DEFS.length} 個欄位有資料`);
  } catch (error) {
    console.error(error);
    setStatus("判讀失敗");
    $("confidenceBadge").textContent = "判讀失敗";
    showToast(error.message || "PDF 判讀失敗");
  }
}

function addFiles(fileList) {
  const pdfs = [...fileList].filter(
    file => file.type === "application/pdf" || /\.pdf$/i.test(file.name)
  );

  if (!pdfs.length) {
    showToast("沒有找到 PDF 檔案");
    return;
  }

  state.files = pdfs;
  state.currentIndex = 0;
  renderFileList();
  processFile(state.files[0]);
}

function renderFileList() {
  const list = $("fileList");
  list.innerHTML = "";

  state.files.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = `file-item ${index === state.currentIndex ? "active" : ""}`;

    const name = document.createElement("div");
    name.className = "file-item-name";
    name.textContent = `${index + 1}. ${file.name}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "開啟";
    btn.addEventListener("click", () => {
      state.currentIndex = index;
      renderFileList();
      processFile(file);
    });

    item.appendChild(name);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function clearAll() {
  state.files = [];
  state.currentIndex = 0;
  state.pdfDoc = null;
  state.currentFile = null;
  state.fields = emptyFields();
  state.rawText = "";
  state.ocrUsed = false;

  $("pdfInput").value = "";
  $("toolbar").classList.add("hidden");
  $("workspace").classList.add("hidden");
  $("batchCard").classList.add("hidden");
  $("resultFields").innerHTML = "";
  $("rawText").textContent = "";
  $("confidenceBadge").textContent = "待判讀";
  $("fileList").innerHTML = "";
  $("viewerEmpty").classList.remove("hidden");
  $("pageLabel").textContent = "第 1 / 1 頁";
  $("pdfCanvas").getContext("2d").clearRect(
    0, 0,
    $("pdfCanvas").width,
    $("pdfCanvas").height
  );
  setStatus("尚未載入");
  showToast("已清除");
}

$("chooseBtn").addEventListener("click", () => $("pdfInput").click());

$("pdfInput").addEventListener("change", event => {
  addFiles(event.target.files);
});

$("dropZone").addEventListener("dragover", event => {
  event.preventDefault();
  $("dropZone").classList.add("dragover");
});

$("dropZone").addEventListener("dragleave", () => {
  $("dropZone").classList.remove("dragover");
});

$("dropZone").addEventListener("drop", event => {
  event.preventDefault();
  $("dropZone").classList.remove("dragover");
  addFiles(event.dataTransfer.files);
});

$("copyBtn").addEventListener("click", copyResult);
$("downloadBtn").addEventListener("click", downloadResult);
$("clearBtn").addEventListener("click", clearAll);

$("prevPageBtn").addEventListener("click", () => {
  renderPage(state.currentPage - 1);
});

$("nextPageBtn").addEventListener("click", () => {
  renderPage(state.currentPage + 1);
});

$("rawToggleBtn").addEventListener("click", () => {
  $("rawText").classList.toggle("hidden");
});
