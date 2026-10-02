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

  // PDF 可能把欄位標題拆成「聯 絡 人」，
  // 只針對已知標題還原，不要把所有中文字中間的空白都刪掉。
  const headers = [
    [/聯\s*絡\s*人/g, "聯絡人"],
    [/報\s*價\s*日\s*期/g, "報價日期"],
    [/統\s*一\s*編\s*號/g, "統一編號"],
    [/公\s*司\s*地\s*址/g, "公司地址"],
    [/承\s*辦\s*人\s*員/g, "承辦人員"],
    [/公\s*司\s*電\s*話/g, "公司電話"],
    [/SR\s*單\s*號/g, "SR單號"],
    [/客\s*戶\s*維\s*修\s*單\s*號/g, "客戶維修單號"],
    [/機\s*器\s*品\s*號/g, "機器品號"],
    [/序\s*號/g, "序號"],
    [/故\s*障\s*現\s*象/g, "故障現象"],
    [/檢\s*測\s*說\s*明/g, "檢測說明"]
  ];

  for (const [pattern, replacement] of headers) {
    normalized = normalized.replace(pattern, replacement);
  }

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

  /*
   * 1. 聯絡人
   *
   * PDF 有可能變成：
   * 聯絡人 : 羅東中山二 - 智取店報價日期 : 2026-10-01
   *
   * 也可能變成：
   * 聯絡人 : 羅東中山二 - 智取店
   * 報價日期 : 2026-10-01
   *
   * 所以直接抓「聯絡人」到「報價日期」之前，
   * 不要求中間一定有空白或換行。
   */
  fields.contact = firstMatch(normalized, [
    /聯絡人\s*[:：]?\s*(.*?)\s*報價日期\s*[:：]/i
  ]);

  /*
   * 如果上面仍抓不到，再從聯絡人後面抓，
   * 並把報價日期切掉。
   */
  if (!fields.contact) {
    const contactMatch = normalized.match(
      /聯絡人\s*[:：]?\s*(.{1,50}?)(?=報價日期|統一編號|公司地址|承辦人員|公司電話|SR單號)/i
    );

    if (contactMatch) {
      fields.contact = cleanValue(contactMatch[1]);
    }
  }

  /*
   * 2. SR單號
   */
  fields.srNumber = firstMatch(normalized, [
    /SR\s*單號\s*[:：]?\s*([0-9]+)/i,
    /SR單號\s*[:：]?\s*([A-Z0-9-]+)/i
  ]);

  /*
   * 3. 機器型號
   *
   * 直接找 PA 開頭的型號。
   * 例如 PA768-QA6FRMDG.
   * → PA768
   */
  const modelMatch = normalized.match(
    /\b(PA\d+)-[A-Z0-9.-]+/i
  );

  if (modelMatch) {
    fields.model = modelMatch[1];
  }

  /*
   * 4. 序號
   *
   * 這份 PDF 的序號格式是：
   * UTA21520240227
   *
   * 不再要求它一定要緊跟在機器品號後面。
   * 這樣可以避免 PDF 表格排序造成抓不到。
   */
  const serialMatch = normalized.match(
    /\b(UTA[A-Z0-9]{6,})\b/i
  );

  if (serialMatch) {
    fields.serial = serialMatch[1];
  }

  /*
   * 如果未來遇到不是 UTA 開頭的序號，
   * 再使用 PA 型號後面的第二組英數字作備援。
   */
  if (!fields.serial) {
    const machineMatch = normalized.match(
      /\bPA\d+-[A-Z0-9.-]+\s+([A-Z0-9][A-Z0-9._-]{5,})\b/i
    );

    if (machineMatch) {
      fields.serial = machineMatch[1];
    }
  }

  /*
   * 5. 客戶維修單號
   *
   * PDF：
   * 客戶維修單號：PA768-RR2606250146
   *
   * 只要：
   * RR2606250146
   */
  fields.customerRepairNo = firstMatch(normalized, [
    /客戶維修單號\s*[:：]?\s*[A-Z0-9]+\s*-\s*(RR[A-Z0-9-]+)/i
  ]);

  /*
   * 備援：
   * 直接找文件裡的 RR 開頭流水號。
   */
  if (!fields.customerRepairNo) {
    const rrMatch = normalized.match(
      /\b(RR\d{6,})\b/i
    );

    if (rrMatch) {
      fields.customerRepairNo = rrMatch[1];
    }
  }

  /*
   * 6. 故障現象 / 檢測說明
   *
   * 這份 PDF 的表格實際內容：
   *
   * PA768-QA6FRMDG.
   * UTA21520240227
   * 9/29 側邊全部按鈕可以使用，但螢幕無法滑動與點擊。
   * 1.上蓋邊框多處凹陷損傷 2.電池不良 報價更換
   *
   * 因為 PDF.js 可能改變換行，
   * 不再依賴「故障現象」和「檢測說明」的位置。
   *
   * 改成：
   * 先找到序號
   * → 往後找第一個「1.」
   * → 1. 前面 = 故障現象
   * → 1. 開始 = 檢測說明
   */

  if (fields.serial) {
    const serialIndex = normalized.indexOf(fields.serial);

    if (serialIndex >= 0) {
      let afterSerial = normalized.slice(
        serialIndex + fields.serial.length
      );

      /*
       * 停在「客戶維修單號」以前，
       * 避免抓到下面的其他文字。
       */
      const repairIndex = afterSerial.search(
        /客戶維修單號/i
      );

      if (repairIndex >= 0) {
        afterSerial = afterSerial.slice(0, repairIndex);
      }

      afterSerial = afterSerial.trim();

      /*
       * 找檢測說明的第一個「1.」
       *
       * 支援：
       * 1.上蓋
       * 1. 上蓋
       * 空白或換行後的 1.
       */
      const inspectionMatch = afterSerial.match(
        /(?:^|\s)(1\.\s*)/
      );

      if (inspectionMatch) {
        const inspectionIndex = inspectionMatch.index;

        /*
         * 如果 match 從空白開始，
         * 把真正的「1.」位置算出來。
         */
        let startIndex = inspectionIndex;

        if (afterSerial[startIndex] !== "1") {
          startIndex += afterSerial
            .slice(startIndex)
            .indexOf("1");
        }

        fields.problem = cleanValue(
          afterSerial.slice(0, startIndex)
        );

        fields.inspection = cleanValue(
          afterSerial.slice(startIndex)
        );
      } else {
        /*
         * 沒有找到 1. 時，
         * 整段先放故障現象。
         */
        fields.problem = cleanValue(afterSerial);
      }
    }
  }

  /*
   * 7. 如果上面的表格方式沒有抓到，
   * 再直接從「9/29」這類日期開始抓故障現象。
   */
  if (!fields.problem) {
    const problemMatch = normalized.match(
      /\b(9\/\d{1,2}\s+.*?)(?=\s*1\.)/i
    );

    if (problemMatch) {
      fields.problem = cleanValue(problemMatch[1]);
    }
  }

  /*
   * 8. 如果檢測說明仍然沒有，
   * 直接抓「1.」到客戶維修單號之前。
   */
  if (!fields.inspection) {
    const inspectionMatch = normalized.match(
      /(\b1\.\s*.*?)(?=\s*客戶維修單號)/i
    );

    if (inspectionMatch) {
      fields.inspection = cleanValue(
        inspectionMatch[1]
      );
    }
  }

  /*
   * 9. 品名
   */
  const productNames = [];

  const lines = normalized
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  for (const line of lines) {
    const m = line.match(
      /^\s*\d+\s+([A-Z0-9.-]+)\s+(.+?)\s+(?:EA|PCS|SET|個|件)\s+\d+(?:\s+[\d,]+)?(?:\s+[\d,]+)?\s*$/i
    );

    if (m) {
      const name = cleanValue(m[2]);

      if (
        name &&
        !/^(品名|單位|數量|單價|金額)$/i.test(name)
      ) {
        productNames.push(name);
      }
    }
  }

  /*
   * 10. 品名備援
   */
  if (productNames.length === 0) {
    const candidates = [
      "上蓋模組",
      "玻璃保護貼",
      "厚電池",
      "庫內維修"
    ];

    for (const name of candidates) {
      if (normalized.includes(name)) {
        productNames.push(name);
      }
    }
  }

  fields.products = [
    ...new Set(productNames)
  ].join("\n");

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
