const DB_NAME = "xdl-file-system";
const DB_VERSION = 1;
const STORE_NAME = "handles";
const DOWNLOAD_DIR_KEY = "download-directory";
let creatingOffscreen = null;

function openHandleDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStoredDirectoryHandle() {
  const db = await openHandleDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(DOWNLOAD_DIR_KEY);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

function sanitizeFilename(name) {
  return (name || "download")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "") || "download";
}

function splitFilename(filename) {
  const index = filename.lastIndexOf(".");
  if (index <= 0) return { base: filename, ext: "" };
  return {
    base: filename.slice(0, index),
    ext: filename.slice(index)
  };
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

async function downloadToSelectedFolder(url, requestedFilename) {
  const directoryHandle = await getStoredDirectoryHandle();
  if (!directoryHandle) {
    return { ok: false, noFolder: true };
  }

  const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    return { ok: false, needsPermission: true, folderName: directoryHandle.name };
  }

  const response = await fetch(url, {
    credentials: "include",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Media request failed: HTTP ${response.status}`);
  }

  const filename = await makeUniqueFilename(directoryHandle, requestedFilename);
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();

  try {
    await response.body.pipeTo(writable);
  } catch (error) {
    try { await writable.abort(); } catch (_) {}
    throw error;
  }

  return {
    ok: true,
    filename,
    folderName: directoryHandle.name,
    target: "selected-folder"
  };
}

function downloadWithBrowser(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename: sanitizeFilename(filename),
        saveAs: false,
        conflictAction: "uniquify"
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        resolve({ ok: true, downloadId, target: "browser-downloads" });
      }
    );
  });
}

function extractMediaKey(url) {
  if (!url) return null;

  const patterns = [
    /\/(?:ext_tw_video|amplify_video)(?:_thumb)?\/(\d+)/,
    /\/tweet_video(?:_thumb)?\/([^/?#.]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function resolutionScore(url) {
  const match = url.match(/\/(\d+)x(\d+)\//);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

function normalizeVariant(variant) {
  if (!variant || typeof variant.url !== "string") return null;
  if (!variant.url.includes("video.twimg.com")) return null;

  const isMp4 = /\.mp4(?:\?|$)/i.test(variant.url) || variant.contentType === "video/mp4";
  if (!isMp4) return null;

  return {
    url: variant.url,
    bitrate: Number(variant.bitrate) || 0
  };
}

async function rememberApiVariants(tabId, mediaKey, variants, mediaType = null) {
  if (tabId < 0 || !mediaKey || !Array.isArray(variants)) return;

  const key = `xdl-api-video:${tabId}:${mediaKey}`;
  const current = await chrome.storage.session.get(key);
  const existing = Array.isArray(current[key]) ? current[key] : [];
  const merged = [...existing];

  for (const raw of variants) {
    const item = normalizeVariant(raw);
    if (!item) continue;

    const old = merged.find((entry) => entry.url === item.url);
    if (old) {
      old.bitrate = Math.max(Number(old.bitrate) || 0, item.bitrate);
    } else {
      merged.push(item);
    }
  }

  merged.sort((a, b) => {
    const bitrateDiff = (b.bitrate || 0) - (a.bitrate || 0);
    if (bitrateDiff) return bitrateDiff;
    return resolutionScore(b.url) - resolutionScore(a.url);
  });

  const writes = { [key]: merged.slice(0, 24) };
  if (mediaType === "animated_gif" || mediaType === "video") {
    writes[`xdl-media-type:${tabId}:${mediaKey}`] = mediaType;
  }

  await chrome.storage.session.set(writes);
}

async function rememberVideoResource(tabId, url) {
  if (tabId < 0 || !/\.mp4(?:\?|$)/i.test(url)) return;

  const mediaKey = extractMediaKey(url);
  if (!mediaKey) return;

  const key = `xdl-resource-video:${tabId}:${mediaKey}`;
  const current = await chrome.storage.session.get(key);
  const urls = Array.isArray(current[key]) ? current[key] : [];

  if (!urls.includes(url)) urls.push(url);
  urls.sort((a, b) => resolutionScore(b) - resolutionScore(a));

  await chrome.storage.session.set({ [key]: urls.slice(0, 24) });
}

async function probeContentLength(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store"
    });

    if (!response.ok) return 0;
    return Number(response.headers.get("content-length")) || 0;
  } catch (_) {
    return 0;
  }
}

async function chooseBestResourceCandidate(candidates) {
  const unique = [...new Set(candidates)].slice(0, 8);
  if (!unique.length) return null;

  const probed = await Promise.all(
    unique.map(async (url) => ({
      url,
      resolution: resolutionScore(url),
      size: await probeContentLength(url)
    }))
  );

  probed.sort((a, b) => {
    const aTiny = a.size > 0 && a.size < 128 * 1024;
    const bTiny = b.size > 0 && b.size < 128 * 1024;
    if (aTiny !== bTiny) return aTiny ? 1 : -1;

    const resolutionDiff = b.resolution - a.resolution;
    if (resolutionDiff) return resolutionDiff;

    return b.size - a.size;
  });

  const best = probed[0];
  if (!best) return null;
  if (best.size > 0 && best.size < 128 * 1024) return null;
  return best.url;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error("此 Chrome 版本不支援本機 GIF 轉檔");
  }

  const offscreenUrl = chrome.runtime.getURL("offscreen.html");
  let exists = false;

  if (typeof chrome.offscreen.hasDocument === "function") {
    exists = await chrome.offscreen.hasDocument();
  } else if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    exists = contexts.length > 0;
  }

  if (exists) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Convert short animated media files to GIF and merge images locally."
    }).finally(() => {
      creatingOffscreen = null;
    });
  }

  await creatingOffscreen;
}


chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId >= 0 && details.url.includes("video.twimg.com")) {
      rememberVideoResource(details.tabId, details.url).catch(() => {});
    }
  },
  { urls: ["https://video.twimg.com/*"] }
);

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DOWNLOAD_MEDIA") {
    (async () => {
      try {
        const filename = sanitizeFilename(message.filename || `media-${Date.now()}`);
        const folderResult = await downloadToSelectedFolder(message.url, filename);

        if (folderResult.ok) {
          sendResponse(folderResult);
          return;
        }

        if (folderResult.needsPermission) {
          sendResponse(folderResult);
          return;
        }

        const browserResult = await downloadWithBrowser(message.url, filename);
        sendResponse(browserResult);
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  if (message?.type === "REGISTER_VARIANTS") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (typeof tabId !== "number") {
          sendResponse({ ok: false });
          return;
        }

        await rememberApiVariants(
          tabId,
          message.mediaKey,
          message.variants,
          message.mediaType || null
        );
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  if (message?.type === "RESOLVE_VIDEO") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const mediaKey = extractMediaKey(message.posterUrl || "") || message.mediaKey || null;

        if (typeof tabId !== "number" || !mediaKey) {
          sendResponse({ ok: false, url: null, source: null, mediaType: null });
          return;
        }

        const typeKey = `xdl-media-type:${tabId}:${mediaKey}`;
        const typeData = await chrome.storage.session.get(typeKey);
        const mediaType = typeData[typeKey] || null;

        const apiKey = `xdl-api-video:${tabId}:${mediaKey}`;
        const apiData = await chrome.storage.session.get(apiKey);
        const variants = Array.isArray(apiData[apiKey]) ? [...apiData[apiKey]] : [];
        variants.sort((a, b) => {
          const bitrateDiff = (b.bitrate || 0) - (a.bitrate || 0);
          if (bitrateDiff) return bitrateDiff;
          return resolutionScore(b.url) - resolutionScore(a.url);
        });

        if (variants.length) {
          sendResponse({
            ok: true,
            url: variants[0].url,
            source: "api-variant",
            mediaType
          });
          return;
        }

        const resourceKey = `xdl-resource-video:${tabId}:${mediaKey}`;
        const resourceData = await chrome.storage.session.get(resourceKey);
        const candidates = Array.isArray(resourceData[resourceKey]) ? [...resourceData[resourceKey]] : [];
        const fallback = await chooseBestResourceCandidate(candidates);

        sendResponse({
          ok: Boolean(fallback),
          url: fallback,
          source: fallback ? "resource-fallback" : null,
          mediaType
        });
      } catch (error) {
        sendResponse({
          ok: false,
          url: null,
          source: null,
          mediaType: null,
          error: error?.message || String(error)
        });
      }
    })();

    return true;
  }

  if (message?.type === "MERGE_IMAGES") {
    (async () => {
      try {
        const items = Array.isArray(message.items) ? message.items.slice(0, 4) : [];
        if (items.length < 2) {
          sendResponse({ ok: false, error: "至少需要 2 張圖片才能合併" });
          return;
        }

        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_MERGE_IMAGES",
          items,
          layout: ["horizontal", "vertical", "grid"].includes(message.layout) ? message.layout : "grid",
          filename: sanitizeFilename(message.filename || `x-merged-${Date.now()}.jpg`)
        });

        if (result?.pendingBrowserDownload && result?.blobUrl) {
          const browserResult = await downloadWithBrowser(
            result.blobUrl,
            result.filename || message.filename || `x-merged-${Date.now()}.jpg`
          );
          sendResponse({
            ...browserResult,
            merged: Boolean(browserResult.ok),
            width: result.width,
            height: result.height,
            count: result.count
          });
          return;
        }

        sendResponse(result || { ok: false, error: "圖片合併沒有回應" });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  if (message?.type === "CONVERT_GIF") {
    (async () => {
      try {
        await ensureOffscreenDocument();
        const result = await chrome.runtime.sendMessage({
          type: "OFFSCREEN_CONVERT_GIF",
          url: message.url,
          filename: sanitizeFilename(message.filename || `x-gif-${Date.now()}.gif`),
          maxDuration: Math.min(30, Math.max(1, Number(message.maxDuration) || 8)),
          scalePercent: Math.min(100, Math.max(10, Number(message.scalePercent) || 100)),
          fps: Math.min(30, Math.max(5, Number(message.fps) || 10))
        });

        if (result?.pendingBrowserDownload && result?.blobUrl) {
          const browserResult = await downloadWithBrowser(
            result.blobUrl,
            result.filename || message.filename || `x-gif-${Date.now()}.gif`
          );
          sendResponse({
            ...browserResult,
            converted: Boolean(browserResult.ok),
            duration: result.duration,
            width: result.width,
            height: result.height,
            frames: result.frames
          });
          return;
        }

        sendResponse(result || { ok: false, error: "GIF 轉檔沒有回應" });
      } catch (error) {
        sendResponse({ ok: false, error: error?.message || String(error) });
      }
    })();

    return true;
  }

  return false;
});
