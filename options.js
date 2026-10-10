const DB_NAME = "xdl-file-system";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DOWNLOAD_DIR_KEY = "download-directory";

const DEFAULT_SETTINGS = {
  imageQuality: "original",
  showAlternateButton: false,
  normalizeJpeg: true,
  mergeMultipleImages: true,
  mergeLayout: "horizontal",
  mergeImageQuality: "original",
  convertShortGif: true,
  gifMaxDuration: 8,
  gifScalePercent: 100,
  gifFps: 10
};

const folderName = document.getElementById("folderName");
const folderPermission = document.getElementById("folderPermission");
const chooseFolderButton = document.getElementById("chooseFolder");
const showAlternateButton = document.getElementById("showAlternateButton");
const normalizeJpeg = document.getElementById("normalizeJpeg");
const mergeMultipleImages = document.getElementById("mergeMultipleImages");
const mergeLayout = document.getElementById("mergeLayout");
const mergeImageQuality = document.getElementById("mergeImageQuality");
const mergeControls = document.getElementById("mergeControls");
const convertShortGif = document.getElementById("convertShortGif");
const gifMaxDuration = document.getElementById("gifMaxDuration");
const gifScalePercent = document.getElementById("gifScalePercent");
const gifFps = document.getElementById("gifFps");
const gifControls = document.getElementById("gifControls");
const saveSettingsButton = document.getElementById("saveSettings");
const saveState = document.getElementById("saveState");

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putDirectoryHandle(handle) {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, DOWNLOAD_DIR_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function getDirectoryHandle() {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(DOWNLOAD_DIR_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function updateFolderStatus(handle) {
  if (!handle) {
    folderName.textContent = "未選擇";
    folderPermission.textContent = "使用瀏覽器預設下載位置";
    return;
  }

  folderName.textContent = handle.name;
  try {
    const permission = await handle.queryPermission({ mode: "readwrite" });
    folderPermission.textContent = permission === "granted"
      ? "已授權，可直接寫入"
      : "需要重新授權；請再按一次「選擇資料夾」";
  } catch (_) {
    folderPermission.textContent = "無法確認資料夾授權狀態";
  }
}

async function chooseFolder() {
  if (!("showDirectoryPicker" in window)) {
    folderPermission.textContent = "此瀏覽器不支援資料夾選擇 API";
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({
      id: "media-downloader-folder",
      mode: "readwrite"
    });

    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      folderPermission.textContent = "未授權寫入此資料夾";
      return;
    }

    await putDirectoryHandle(handle);
    await updateFolderStatus(handle);
  } catch (error) {
    if (error?.name !== "AbortError") {
      folderPermission.textContent = error?.message || "選擇資料夾失敗";
    }
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function updateGifControls() {
  const enabled = convertShortGif.checked;
  gifMaxDuration.disabled = !enabled;
  gifScalePercent.disabled = !enabled;
  gifFps.disabled = !enabled;
  gifControls.style.opacity = enabled ? "1" : ".55";
}

function updateMergeControls() {
  const enabled = mergeMultipleImages.checked;
  mergeLayout.disabled = !enabled;
  mergeImageQuality.disabled = !enabled;
  mergeControls.style.opacity = enabled ? "1" : ".55";
}

async function loadSettings() {
  const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...saved };

  const qualityRadio = document.querySelector(
    `input[name="imageQuality"][value="${settings.imageQuality}"]`
  );
  if (qualityRadio) qualityRadio.checked = true;

  showAlternateButton.checked = Boolean(settings.showAlternateButton);
  normalizeJpeg.checked = Boolean(settings.normalizeJpeg);

  mergeMultipleImages.checked = Boolean(settings.mergeMultipleImages);
  // V0.5.3: migrate all previous auto / vertical choices to one-row horizontal merge.
  mergeLayout.value = "horizontal";
  mergeImageQuality.value = settings.mergeImageQuality === "displayed" ? "displayed" : "original";
  updateMergeControls();

  convertShortGif.checked = Boolean(settings.convertShortGif);
  gifMaxDuration.value = String(clampInteger(settings.gifMaxDuration, 1, 30, 8));
  gifScalePercent.value = String(clampInteger(settings.gifScalePercent, 10, 100, 100));
  gifFps.value = String(clampInteger(settings.gifFps, 5, 30, 10));
  updateGifControls();

  try {
    const handle = await getDirectoryHandle();
    await updateFolderStatus(handle);
  } catch (_) {
    await updateFolderStatus(null);
  }
}

async function saveSettings() {
  const imageQuality =
    document.querySelector('input[name="imageQuality"]:checked')?.value || "original";

  const normalizedGifDuration = clampInteger(gifMaxDuration.value, 1, 30, 8);
  const normalizedGifScale = clampInteger(gifScalePercent.value, 10, 100, 100);
  const normalizedGifFps = clampInteger(gifFps.value, 5, 30, 10);

  gifMaxDuration.value = String(normalizedGifDuration);
  gifScalePercent.value = String(normalizedGifScale);
  gifFps.value = String(normalizedGifFps);

  await chrome.storage.local.set({
    imageQuality,
    showAlternateButton: showAlternateButton.checked,
    normalizeJpeg: normalizeJpeg.checked,
    mergeMultipleImages: mergeMultipleImages.checked,
    mergeLayout: "horizontal",
    mergeImageQuality: mergeImageQuality.value,
    convertShortGif: convertShortGif.checked,
    gifMaxDuration: normalizedGifDuration,
    gifScalePercent: normalizedGifScale,
    gifFps: normalizedGifFps
  });

  saveState.textContent = "已儲存";
  saveSettingsButton.disabled = true;
  setTimeout(() => {
    saveState.textContent = "";
    saveSettingsButton.disabled = false;
  }, 900);
}

chooseFolderButton.addEventListener("click", chooseFolder);
convertShortGif.addEventListener("change", updateGifControls);
mergeMultipleImages.addEventListener("change", updateMergeControls);

gifMaxDuration.addEventListener("change", () => {
  gifMaxDuration.value = String(clampInteger(gifMaxDuration.value, 1, 30, 8));
});
gifScalePercent.addEventListener("change", () => {
  gifScalePercent.value = String(clampInteger(gifScalePercent.value, 10, 100, 100));
});
gifFps.addEventListener("change", () => {
  gifFps.value = String(clampInteger(gifFps.value, 5, 30, 10));
});

document.querySelectorAll("[data-gif-scale]").forEach((button) => {
  button.addEventListener("click", () => {
    gifScalePercent.value = button.dataset.gifScale;
  });
});

saveSettingsButton.addEventListener("click", saveSettings);
loadSettings();
