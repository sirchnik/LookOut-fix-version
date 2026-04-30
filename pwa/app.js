// @ts-check

import { TnefExtractor } from "../src/scripts/lookout.mjs";

/**
 * @typedef {Object} Prefs
 * @property {boolean} debug_enabled
 * @property {boolean} attach_raw_mapi
 * @property {boolean} disable_filename_character_set
 */

/** @typedef {{ file: File, url: string, selected: boolean }} ExtractedFile */
/** @typedef {{ files?: FileSystemFileHandle[] }} LaunchParamsLike */
/** @typedef {{ setConsumer(consumer: (launchParams: LaunchParamsLike) => void): void }} LaunchQueueLike */
/** @typedef {{ openFromAndroid(fileName?: string, mimeType?: string): Promise<void> }} LookoutApi */
/** @typedef {{ downloadFile?: (name: string, mimeType: string, base64Data: string) => void, openFile?: (name: string, mimeType: string, base64Data: string) => void, shareFiles?: (namesJson: string, mimeTypesJson: string, base64DataJson: string) => void }} AndroidBridge */

/** @type {Window & { AndroidBridge?: AndroidBridge, Lookout?: LookoutApi, launchQueue?: LaunchQueueLike }} */
const appWindow = window;

const fileInput = /** @type {HTMLInputElement} */ (
  document.getElementById("fileInput")
);
const downloadAllBtn = /** @type {HTMLButtonElement} */ (
  document.getElementById("downloadAllBtn")
);
const shareAllBtn = /** @type {HTMLButtonElement | null} */ (
  document.getElementById("shareAllBtn")
);
const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const resultsEl = /** @type {HTMLElement} */ (
  document.getElementById("results")
);
const dropzone = /** @type {HTMLElement} */ (
  document.getElementById("dropzone")
);
const isAndroidApp =
  new URLSearchParams(window.location.search).get("android") === "1";
const isDevServer = ["127.0.0.1", "localhost"].includes(
  window.location.hostname,
);

if (isAndroidApp) {
  document.body.classList.add("android-app");
}

/** @type {File | null} */
let selectedFile = null;
/** @type {ExtractedFile[]} */
let extractedFiles = [];

/** @type {Prefs} */
const PREF_DEFAULTS = {
  debug_enabled: false,
  attach_raw_mapi: false,
  disable_filename_character_set: false,
};

const PREF_STORAGE_PREFIX = "lookout.pref.";
const USER_OPTIONS = /** @type {Array<keyof Prefs>} */ (
  Object.keys(PREF_DEFAULTS)
);

/** @type {Prefs} */
const prefs = { ...PREF_DEFAULTS };

/**
 * @param {keyof Prefs} name
 * @returns {boolean}
 */
function readPref(name) {
  try {
    const value = localStorage.getItem(`${PREF_STORAGE_PREFIX}${name}`);
    if (value === null) {
      return PREF_DEFAULTS[name];
    }
    return value === "true";
  } catch {
    return PREF_DEFAULTS[name];
  }
}

/**
 * @param {keyof Prefs} name
 * @param {boolean} value
 */
function writePref(name, value) {
  try {
    localStorage.setItem(
      `${PREF_STORAGE_PREFIX}${name}`,
      String(Boolean(value)),
    );
  } catch {
    // Ignore storage failures (private mode / disabled storage).
  }
}

function setupPreferences() {
  USER_OPTIONS.forEach((name) => {
    const checkbox = /** @type {HTMLInputElement | null} */ (
      document.getElementById(`${name}_check`)
    );
    if (!checkbox) {
      return;
    }

    const currentValue = readPref(name);
    prefs[name] = currentValue;
    checkbox.checked = currentValue;

    checkbox.addEventListener("change", (event) => {
      const target = /** @type {HTMLInputElement} */ (event.currentTarget);
      const nextValue = Boolean(target.checked);
      prefs[name] = nextValue;
      writePref(name, nextValue);
    });
  });
}

/**
 * @param {number} size
 * @returns {string}
 */
function formatBytes(size) {
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = size;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

/**
 * @param {string} message
 * @param {boolean} [isError=false]
 */
function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function hasAndroidShareSupport() {
  const bridge = appWindow.AndroidBridge;
  return isAndroidApp && bridge && typeof bridge.shareFiles === "function";
}

const MIME_BY_EXTENSION = {
  avif: "image/avif",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ics: "text/calendar",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  mht: "multipart/related",
  mhtml: "multipart/related",
  msg: "application/vnd.ms-outlook",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  zip: "application/zip",
};

/**
 * @param {File | null | undefined} file
 * @returns {string}
 */
function fixFilenames(file) {
  const fileName = (file && file.name) || "attachment.bin";
  if (fileName === "NaN.html") {
    return "message.html";
  }
  return fileName;
}

/**
 * @param {string} fileName
 * @param {string | undefined} fileType
 * @returns {string}
 */
function guessMimeType(fileName, fileType) {
  const currentType = (fileType || "").toLowerCase();
  if (currentType && currentType !== "application/binary") {
    return fileType;
  }

  const match = /\.([^.\\/]+)$/.exec(fileName || "");
  if (!match) {
    return currentType === "application/binary"
      ? "application/octet-stream"
      : fileType || "application/octet-stream";
  }

  const extension = match[1].toLowerCase();
  return (
    MIME_BY_EXTENSION[extension] ||
    (currentType === "application/binary"
      ? "application/octet-stream"
      : fileType || "application/octet-stream")
  );
}

/**
 * @param {File[]} files
 * @returns {Promise<File[]>}
 */
async function reprocessExtractedFiles(files) {
  const processedFiles = [];

  for (const file of files) {
    const fileName = fixFilenames(file);
    const mimeType = guessMimeType(fileName, file && file.type);
    const bytes = await file.arrayBuffer();
    processedFiles.push(
      new File([bytes], fileName, {
        type: mimeType,
        lastModified: file.lastModified,
      }),
    );
  }

  return processedFiles;
}

/**
 * @param {File} file
 * @param {number} idx
 * @returns {boolean}
 */
function isFirstMessageHtmlFile(file, idx) {
  if (idx !== 0) {
    return false;
  }
  const name = file.name.toLowerCase();
  return name === "message.html";
}

/**
 * @returns {File[]}
 */
function getSelectedExtractedFiles() {
  return extractedFiles
    .filter((item) => item.selected)
    .map((item) => item.file);
}

function updateShareAllButtonState() {
  if (!shareAllBtn) {
    return;
  }

  const canUseShareAll = hasAndroidShareSupport();
  shareAllBtn.hidden = !canUseShareAll;

  if (!canUseShareAll) {
    shareAllBtn.disabled = true;
    return;
  }

  const files = getSelectedExtractedFiles();
  shareAllBtn.disabled = files.length === 0 || !hasAndroidShareSupport();
}

function updateDownloadAllButtonState() {
  const files = getSelectedExtractedFiles();
  downloadAllBtn.disabled = files.length === 0;
}

function resetResults() {
  extractedFiles.forEach((item) => URL.revokeObjectURL(item.url));
  extractedFiles = [];
  resultsEl.innerHTML = "";
  updateDownloadAllButtonState();
  updateShareAllButtonState();
}

/**
 * @param {File[]} files
 */
function renderResults(files) {
  resetResults();

  if (!files.length) {
    setStatus("No embedded files were found in this winmail.dat.", true);
    return;
  }

  const frag = document.createDocumentFragment();
  extractedFiles = files.map((file, idx) => {
    const url = URL.createObjectURL(file);
    const normalizedName = fixFilenames(file);
    const shouldSelect = !isFirstMessageHtmlFile(file, idx);

    const li = document.createElement("li");
    li.className = "result-item";

    const selectLabel = document.createElement("label");
    selectLabel.className = "result-select";
    const checkbox = /** @type {HTMLInputElement} */ (
      document.createElement("input")
    );
    checkbox.type = "checkbox";
    checkbox.checked = shouldSelect;
    checkbox.setAttribute("aria-label", `Select ${normalizedName}`);
    selectLabel.append(checkbox);

    const meta = document.createElement("div");
    meta.className = "result-meta";
    const name = document.createElement("strong");
    name.textContent = normalizedName;
    const details = document.createElement("small");
    details.textContent = `${file.type || "application/octet-stream"} • ${formatBytes(file.size)}`;
    meta.append(name, details);

    const link = document.createElement("a");
    link.className = "download-link";
    link.href = url;
    link.download = normalizedName;
    link.textContent = "Download";
    link.addEventListener("click", async (event) => {
      if (!isAndroidApp) {
        return;
      }
      event.preventDefault();
      try {
        await saveFileViaAndroid(file);
      } catch (error) {
        setStatus(`Download failed: ${error.message || error}`, true);
      }
    });

    const actions = document.createElement("div");
    actions.className = "result-actions";
    actions.append(link);

    if (isAndroidApp) {
      const openBtn = document.createElement("button");
      openBtn.className = "open-btn";
      openBtn.type = "button";
      openBtn.textContent = "Open";
      openBtn.addEventListener("click", async () => {
        try {
          await openFileViaAndroid(file);
        } catch (error) {
          setStatus(`Open failed: ${error.message || error}`, true);
        }
      });

      actions.append(openBtn);
    }

    if (hasAndroidShareSupport()) {
      const shareBtn = document.createElement("button");
      shareBtn.className = "share-btn";
      shareBtn.type = "button";
      shareBtn.textContent = "Share";
      shareBtn.addEventListener("click", async () => {
        try {
          await shareFiles([file]);
        } catch (error) {
          if (error && error.name === "AbortError") {
            return;
          }
          setStatus(`Share failed: ${error.message || error}`, true);
        }
      });

      actions.append(shareBtn);
    }

    li.append(selectLabel, meta, actions);
    frag.append(li);

    const entry = { file, url, selected: shouldSelect };

    checkbox.addEventListener("change", (event) => {
      const target = /** @type {HTMLInputElement} */ (event.currentTarget);
      entry.selected = Boolean(target.checked);
      updateDownloadAllButtonState();
      updateShareAllButtonState();
    });

    return entry;
  });

  resultsEl.append(frag);
  updateDownloadAllButtonState();
  updateShareAllButtonState();
  setStatus(
    `Extracted ${files.length} attachment${files.length === 1 ? "" : "s"}.`,
  );
}

/**
 * @param {File | null} file
 */
function setSelectedFile(file) {
  selectedFile = file || null;
  resetResults();

  if (selectedFile) {
    setStatus(
      `Selected: ${selectedFile.name} (${formatBytes(selectedFile.size)})`,
    );
    void extractFromSelectedFile();
  } else {
    setStatus("No file selected.");
  }
}

async function extractFromSelectedFile() {
  if (!selectedFile) {
    return;
  }

  setStatus("Extracting attachments...");

  try {
    const extractor = new TnefExtractor();
    /**
     * @type {File[]}
     */
    const files = await extractor.parse(selectedFile, {}, { ...prefs });
    const reprocessedFiles = await reprocessExtractedFiles(files || []);
    renderResults(reprocessedFiles);
  } catch (error) {
    setStatus(`Extraction failed: ${error.message || error}`, true);
  }
}

/**
 * @param {string | undefined} fileName
 * @param {string | undefined} mimeType
 * @returns {Promise<void>}
 */
async function openFromAndroid(fileName, mimeType) {
  try {
    const response = await fetch("./input", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Unable to read the source file (${response.status}).`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    const file = new File([bytes], fileName || "winmail.dat", {
      type:
        mimeType ||
        response.headers.get("content-type") ||
        "application/octet-stream",
    });

    setSelectedFile(file);
  } catch (error) {
    setStatus(`Extraction failed: ${error.message || error}`, true);
  }
}

/**
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => {
      reject(reader.error || new Error("Unable to encode file."));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * @param {File} file
 * @returns {Promise<void>}
 */
async function saveFileViaAndroid(file) {
  if (
    !appWindow.AndroidBridge ||
    typeof appWindow.AndroidBridge.downloadFile !== "function"
  ) {
    throw new Error("Android download bridge is unavailable.");
  }

  const base64Data = await fileToBase64(file);
  appWindow.AndroidBridge.downloadFile(
    file.name || "attachment.bin",
    file.type || "application/octet-stream",
    base64Data,
  );
}

/**
 * @param {File} file
 * @returns {Promise<void>}
 */
async function openFileViaAndroid(file) {
  if (
    !appWindow.AndroidBridge ||
    typeof appWindow.AndroidBridge.openFile !== "function"
  ) {
    throw new Error("Android open bridge is unavailable.");
  }

  const base64Data = await fileToBase64(file);
  appWindow.AndroidBridge.openFile(
    file.name || "attachment.bin",
    file.type || "application/octet-stream",
    base64Data,
  );
}

/**
 * @param {File[]} files
 * @returns {Promise<void>}
 */
async function shareFiles(files) {
  if (!files.length) {
    return;
  }

  if (hasAndroidShareSupport()) {
    const names = [];
    const mimeTypes = [];
    const base64DataList = [];

    for (const file of files) {
      names.push(file.name || "attachment.bin");
      mimeTypes.push(file.type || "application/octet-stream");
      base64DataList.push(await fileToBase64(file));
    }

    appWindow.AndroidBridge.shareFiles(
      JSON.stringify(names),
      JSON.stringify(mimeTypes),
      JSON.stringify(base64DataList),
    );
    return;
  }

  throw new Error("Sharing is not supported on this device.");
}

async function downloadAll() {
  const selectedFiles = getSelectedExtractedFiles();
  if (!selectedFiles.length) {
    setStatus("Select at least one attachment.", true);
    return;
  }

  if (isAndroidApp) {
    try {
      for (const file of selectedFiles) {
        await saveFileViaAndroid(file);
      }
      return;
    } catch (error) {
      setStatus(`Download failed: ${error.message || error}`, true);
      return;
    }
  }

  selectedFiles.forEach((file, idx) => {
    const a = document.createElement("a");
    const fileEntry = extractedFiles.find((item) => item.file === file);
    if (!fileEntry) {
      return;
    }
    a.href = fileEntry.url;
    a.download = file.name || `attachment-${idx + 1}.bin`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });
}

function setupDropzone() {
  ["dragenter", "dragover"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragover");
    });
  });

  ["dragleave", "drop"].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
    });
  });

  dropzone.addEventListener("drop", (event) => {
    const droppedFiles = event.dataTransfer && event.dataTransfer.files;
    const file = droppedFiles && droppedFiles[0];
    if (file) {
      setSelectedFile(file);
    }
  });
}

async function setupPwaIntegrations() {
  if (!isAndroidApp && !isDevServer && "serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (error) {
      setStatus(
        `Service worker registration failed: ${error.message || error}`,
        true,
      );
    }
  }

  if (appWindow.launchQueue) {
    appWindow.launchQueue.setConsumer(async (launchParams) => {
      const launchFiles = launchParams.files;
      const handle = launchFiles && launchFiles[0];
      if (!handle) {
        return;
      }
      const file = await handle.getFile();
      setSelectedFile(file);
    });
  }
}

fileInput.addEventListener("change", (event) => {
  const target = /** @type {HTMLInputElement} */ (event.currentTarget);
  const files = target.files;
  setSelectedFile((files && files[0]) || null);
});

downloadAllBtn.addEventListener("click", downloadAll);

if (shareAllBtn) {
  shareAllBtn.addEventListener("click", async () => {
    try {
      const selectedFiles = getSelectedExtractedFiles();
      if (!selectedFiles.length) {
        setStatus("Select at least one attachment.", true);
        return;
      }
      await shareFiles(selectedFiles);
    } catch (error) {
      if (error && error.name === "AbortError") {
        return;
      }
      setStatus(`Share failed: ${error.message || error}`, true);
    }
  });
}

setupDropzone();
setupPreferences();
setupPwaIntegrations();
updateShareAllButtonState();

appWindow.Lookout = {
  openFromAndroid,
};
