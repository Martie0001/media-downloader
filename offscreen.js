const DB_NAME = "xdl-file-system";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DOWNLOAD_DIR_KEY = "download-directory";

function sanitizeFilename(name) {
  return (name || "download")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "") || "download";
}

function splitFilename(filename) {
  const index = filename.lastIndexOf(".");
  if (index <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, index), ext: filename.slice(index) };
}

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

async function getStoredDirectoryHandle() {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(DOWNLOAD_DIR_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function fileExists(directoryHandle, filename) {
  try {
    await directoryHandle.getFileHandle(filename, { create: false });
    return true;
  } catch (error) {
    if (error?.name === "NotFoundError") return false;
    throw error;
  }
}

async function makeUniqueFilename(directoryHandle, requestedName) {
  const safeName = sanitizeFilename(requestedName);
  if (!(await fileExists(directoryHandle, safeName))) return safeName;
  const { base, ext } = splitFilename(safeName);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${base} (${index})${ext}`;
    if (!(await fileExists(directoryHandle, candidate))) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

async function saveBlob(blob, requestedFilename) {
  const directoryHandle = await getStoredDirectoryHandle();

  if (directoryHandle) {
    const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") {
      const filename = await makeUniqueFilename(directoryHandle, requestedFilename);
      const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(blob);
        await writable.close();
        return { ok: true, filename, folderName: directoryHandle.name, target: "selected-folder" };
      } catch (error) {
        try { await writable.abort(); } catch (_) {}
        throw error;
      }
    }

    return { ok: false, needsPermission: true, folderName: directoryHandle.name };
  }

  const blobUrl = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  return {
    ok: true,
    pendingBrowserDownload: true,
    blobUrl,
    filename: sanitizeFilename(requestedFilename)
  };
}

function waitForEvent(target, eventName, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${eventName} 逾時`));
    }, timeoutMs);

    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("影片解碼失敗"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function seekVideo(video, time) {
  if (Math.abs(video.currentTime - time) < 0.015) return;
  const promise = waitForEvent(video, "seeked", 10000);
  video.currentTime = time;
  await promise;
}

function scaledDimensions(width, height, scalePercent) {
  if (!width || !height) return { width: 0, height: 0 };
  const scale = Math.min(1, Math.max(0.1, Number(scalePercent) / 100 || 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

async function convertMp4ToGif(url, maxDuration, scalePercent, fps) {
  const response = await fetch(url, { cache: "no-store", credentials: "include" });
  if (!response.ok) throw new Error(`GIF 來源下載失敗：HTTP ${response.status}`);

  const mp4Blob = await response.blob();
  const objectUrl = URL.createObjectURL(mp4Blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = objectUrl;

  try {
    await waitForEvent(video, "loadedmetadata", 15000);
    if (video.readyState < 2) await waitForEvent(video, "loadeddata", 15000);

    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("無法取得動圖長度");
    if (duration > maxDuration + 0.05) return { ok: false, tooLong: true, duration };

    const size = scaledDimensions(video.videoWidth, video.videoHeight, scalePercent);
    if (!size.width || !size.height) throw new Error("無法取得動圖解析度");

    const safeFps = Math.min(30, Math.max(5, Math.round(Number(fps) || 10)));
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    if (!context) throw new Error("無法建立 GIF 畫布");

    const delayCs = Math.max(2, Math.round(100 / safeFps));
    const encoder = new XDLGifEncoder.GifEncoder(size.width, size.height, delayCs);
    const frameCount = Math.max(1, Math.ceil(duration * safeFps));

    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = Math.min(frame / safeFps, Math.max(0, duration - 0.001));
      await seekVideo(video, time);
      context.drawImage(video, 0, 0, size.width, size.height);
      const image = context.getImageData(0, 0, size.width, size.height);
      encoder.addRgbaFrame(image.data);
      if (frame % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const gifBlob = encoder.finish();
    return {
      ok: true,
      blob: gifBlob,
      duration,
      width: size.width,
      height: size.height,
      frames: frameCount,
      fps: safeFps,
      scalePercent
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadBitmap(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "include" });
  if (!response.ok) throw new Error(`圖片下載失敗：HTTP ${response.status}`);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

function fitDimensions(width, height, targetWidth = null, targetHeight = null) {
  if (targetWidth != null) {
    const scale = targetWidth / width;
    return { width: targetWidth, height: Math.max(1, Math.round(height * scale)) };
  }
  if (targetHeight != null) {
    const scale = targetHeight / height;
    return { width: Math.max(1, Math.round(width * scale)), height: targetHeight };
  }
  return { width, height };
}

function drawContain(ctx, bitmap, x, y, width, height) {
  const scale = Math.min(width / bitmap.width, height / bitmap.height);
  const drawWidth = Math.max(1, Math.round(bitmap.width * scale));
  const drawHeight = Math.max(1, Math.round(bitmap.height * scale));
  const dx = x + Math.floor((width - drawWidth) / 2);
  const dy = y + Math.floor((height - drawHeight) / 2);
  ctx.drawImage(bitmap, dx, dy, drawWidth, drawHeight);
}

async function mergeImages(items, layout, requestedFilename) {
  const bitmaps = [];
  try {
    for (const item of items) bitmaps.push(await loadBitmap(item.url));
    if (bitmaps.length < 2) throw new Error("至少需要 2 張圖片才能合併");

    let canvasWidth = 0;
    let canvasHeight = 0;
    const placements = [];

    if (layout === "vertical") {
      const targetWidth = Math.max(...bitmaps.map((b) => b.width));
      let y = 0;
      for (const bitmap of bitmaps) {
        const size = fitDimensions(bitmap.width, bitmap.height, targetWidth, null);
        placements.push({ bitmap, x: 0, y, width: size.width, height: size.height, contain: false });
        y += size.height;
      }
      canvasWidth = targetWidth;
      canvasHeight = y;
    } else if (layout === "grid") {
      const columns = 2;
      const rows = Math.ceil(bitmaps.length / columns);
      const cellWidth = Math.max(...bitmaps.map((b) => b.width));
      const cellHeight = Math.max(...bitmaps.map((b) => b.height));
      canvasWidth = cellWidth * columns;
      canvasHeight = cellHeight * rows;
      bitmaps.forEach((bitmap, index) => {
        placements.push({
          bitmap,
          x: (index % columns) * cellWidth,
          y: Math.floor(index / columns) * cellHeight,
          width: cellWidth,
          height: cellHeight,
          contain: true
        });
      });
    } else {
      const targetHeight = Math.max(...bitmaps.map((b) => b.height));
      let x = 0;
      for (const bitmap of bitmaps) {
        const size = fitDimensions(bitmap.width, bitmap.height, null, targetHeight);
        placements.push({ bitmap, x, y: 0, width: size.width, height: size.height, contain: false });
        x += size.width;
      }
      canvasWidth = x;
      canvasHeight = targetHeight;
    }

    const maxSide = 16384;
    if (canvasWidth > maxSide || canvasHeight > maxSide || canvasWidth * canvasHeight > 120000000) {
      throw new Error("合併後圖片尺寸過大，請改用網頁目前顯示尺寸或分批合併");
    }

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("無法建立圖片合併畫布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const placement of placements) {
      if (placement.contain) {
        drawContain(ctx, placement.bitmap, placement.x, placement.y, placement.width, placement.height);
      } else {
        ctx.drawImage(placement.bitmap, placement.x, placement.y, placement.width, placement.height);
      }
    }

    const lower = requestedFilename.toLowerCase();
    const mime = lower.endsWith(".png") ? "image/png" : "image/jpeg";
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error("合併圖片輸出失敗")), mime, 0.95);
    });

    return { blob, width: canvasWidth, height: canvasHeight, count: bitmaps.length };
  } finally {
    for (const bitmap of bitmaps) {
      try { bitmap.close(); } catch (_) {}
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_CONVERT_GIF") {
    (async () => {
      try {
        const maxDuration = Math.min(30, Math.max(1, Number(message.maxDuration) || 8));
        const scalePercent = Math.min(100, Math.max(10, Number(message.scalePercent) || 100));
        const fps = Math.min(30, Math.max(5, Number(message.fps) || 10));
        const conversion = await convertMp4ToGif(message.url, maxDuration, scalePercent, fps);

        if (!conversion.ok) {
          sendResponse(conversion);
          return;
        }

        const saveResult = await saveBlob(conversion.blob, message.filename);
        sendResponse({
          ...saveResult,
          converted: Boolean(saveResult.ok),
          duration: conversion.duration,
          width: conversion.width,
          height: conversion.height,
          frames: conversion.frames,
          fps: conversion.fps,
          scalePercent: conversion.scalePercent
        });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  if (message?.type === "OFFSCREEN_MERGE_IMAGES") {
    (async () => {
      try {
        const items = Array.isArray(message.items) ? message.items.slice(0, 4) : [];
        // V0.5.3: merged post images always stay on a single row.
        // Force horizontal here as a second safeguard for stale settings/content scripts.
        const layout = "horizontal";
        const merged = await mergeImages(items, layout, message.filename || `x-merged-${Date.now()}.jpg`);
        const saveResult = await saveBlob(merged.blob, message.filename || `x-merged-${Date.now()}.jpg`);
        sendResponse({
          ...saveResult,
          merged: Boolean(saveResult.ok),
          width: merged.width,
          height: merged.height,
          count: merged.count
        });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();
    return true;
  }

  return false;
});
