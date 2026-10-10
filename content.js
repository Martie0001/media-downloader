console.log("[Media Downloader] V0.5.3 loaded");

const XDL_GROUP_CLASS = "xdl-button-group";
const XDL_BUTTON_CLASS = "xdl-button";
const XDL_BRIDGE_SOURCE = "xdl-page-hook-v040";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== XDL_BRIDGE_SOURCE || data.type !== "XDL_MEDIA_VARIANTS") return;
  if (!data.mediaKey || !Array.isArray(data.variants)) return;

  chrome.runtime.sendMessage({
    type: "REGISTER_VARIANTS",
    mediaKey: data.mediaKey,
    variants: data.variants,
    mediaType: data.mediaType || null
  }, () => {
    void chrome.runtime.lastError;
  });
});

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

let settings = { ...DEFAULT_SETTINGS };
let scanTimer = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return (name || "download")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[. ]+$/g, "") || "download";
}

function makeSvgIcon(kind) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.pointerEvents = "none";

  const path = (d) => {
    const node = document.createElementNS(ns, "path");
    node.setAttribute("d", d);
    svg.appendChild(node);
  };

  if (kind === "original") {
    path("M8 3H5a2 2 0 0 0-2 2v3");
    path("M16 3h3a2 2 0 0 1 2 2v3");
    path("M8 21H5a2 2 0 0 1-2-2v-3");
    path("M16 21h3a2 2 0 0 0 2-2v-3");
    path("M12 7v8");
    path("m9 12 3 3 3-3");
  } else if (kind === "video") {
    path("M8 5.5 16 10l-8 4.5z");
    path("M12 15v5");
    path("m9.5 17.5 2.5 2.5 2.5-2.5");
  } else if (kind === "merge") {
    path("M4 7h7v7H4z");
    path("M13 10h7v7h-7z");
    path("M7.5 17.5v3");
    path("m5.5-1 2 2-2 2");
  } else {
    path("M12 3v12");
    path("m8 11 4 4 4-4");
    path("M5 20h14");
  }

  return svg;
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

async function loadSettings() {
  const saved = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...saved };
}

function sendDownload(url, filename) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "DOWNLOAD_MEDIA", url, filename },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      }
    );
  });
}

function sendGifConversion(url, filename, maxDuration, scalePercent, fps) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      {
        type: "CONVERT_GIF",
        url,
        filename,
        maxDuration,
        scalePercent,
        fps
      },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      }
    );
  });
}

function sendImageMerge(items, layout, filename) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "MERGE_IMAGES", items, layout, filename },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false });
      }
    );
  });
}

function requestVideoFromBackground(posterUrl) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "RESOLVE_VIDEO", posterUrl },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      }
    );
  });
}

function getImageDownloadInfo(img, quality) {
  const rawUrl = img.currentSrc || img.src;
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (quality === "original" && url.hostname === "pbs.twimg.com") {
      url.searchParams.set("name", "orig");
    }

    let format = url.searchParams.get("format");
    if (!format) {
      const extension = url.pathname.match(/\.([a-zA-Z0-9]+)$/);
      if (extension) format = extension[1];
    }

    format = (format || "jpg").toLowerCase();
    if (settings.normalizeJpeg && ["jpeg", "jfif", "pjpeg"].includes(format)) {
      format = "jpg";
    }

    const pathParts = url.pathname.split("/");
    let baseName = pathParts[pathParts.length - 1] || `x-image-${Date.now()}`;
    baseName = baseName.replace(/\.[a-zA-Z0-9]+$/, "");

    return {
      url: url.toString(),
      filename: `${sanitizeFilename(baseName)}.${format}`,
      format
    };
  } catch (_) {
    return {
      url: rawUrl,
      filename: `x-image-${Date.now()}.jpg`,
      format: "jpg"
    };
  }
}

function isVideoThumbnail(img) {
  const src = img.currentSrc || img.src || "";
  return (
    src.includes("ext_tw_video_thumb") ||
    src.includes("amplify_video_thumb") ||
    src.includes("tweet_video_thumb")
  );
}

function getPosterUrl(video) {
  if (video.poster) return video.poster;
  const host =
    video.closest('[data-testid="videoPlayer"]') ||
    video.closest('[data-testid="videoComponent"]') ||
    video.parentElement;
  const img = host?.querySelector("img");
  return img?.currentSrc || img?.src || "";
}

function detectAnimatedGifFromDom(video) {
  const host =
    video.closest('[data-testid="videoPlayer"]') ||
    video.closest('[data-testid="videoComponent"]') ||
    video.parentElement;
  if (!host) return false;

  const candidates = host.querySelectorAll("span, div");
  for (const node of candidates) {
    if (node.children.length > 0) continue;
    if ((node.textContent || "").trim().toUpperCase() === "GIF") return true;
  }
  return false;
}

function findLocalVideoResource(posterUrl) {
  const mediaKey = extractMediaKey(posterUrl);
  const resources = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((url) => url.includes("video.twimg.com") && /\.mp4(?:\?|$)/i.test(url));
  if (!resources.length) return null;

  let candidates = resources;
  if (mediaKey) {
    const matching = resources.filter((url) => url.includes(mediaKey));
    if (matching.length) candidates = matching;
  }

  candidates.sort((a, b) => resolutionScore(b) - resolutionScore(a));
  return candidates[0] || null;
}

async function wakeVideo(video) {
  const wasPaused = video.paused;
  const oldMuted = video.muted;
  try {
    video.muted = true;
    await video.play();
    await sleep(850);
    if (wasPaused) video.pause();
  } catch (_) {
    // Ignore autoplay restrictions.
  } finally {
    video.muted = oldMuted;
  }
}

async function resolveVideo(video) {
  const posterUrl = getPosterUrl(video);
  let backgroundInfo = await requestVideoFromBackground(posterUrl);

  if (backgroundInfo?.url) {
    return {
      url: backgroundInfo.url,
      mediaType: backgroundInfo.mediaType || (detectAnimatedGifFromDom(video) ? "animated_gif" : null)
    };
  }

  const inferredType = backgroundInfo?.mediaType || (detectAnimatedGifFromDom(video) ? "animated_gif" : null);

  if (
    video.currentSrc &&
    video.currentSrc.startsWith("https://video.twimg.com/") &&
    /\.mp4(?:\?|$)/i.test(video.currentSrc)
  ) {
    return { url: video.currentSrc, mediaType: inferredType };
  }

  let url = findLocalVideoResource(posterUrl);
  if (url) return { url, mediaType: inferredType };

  await wakeVideo(video);
  await sleep(450);

  backgroundInfo = await requestVideoFromBackground(posterUrl);
  if (backgroundInfo?.url) {
    return {
      url: backgroundInfo.url,
      mediaType: backgroundInfo.mediaType || inferredType
    };
  }

  url = findLocalVideoResource(posterUrl);
  if (url) return { url, mediaType: backgroundInfo?.mediaType || inferredType };
  return null;
}

function getVideoFilename(url) {
  try {
    const parsed = new URL(url);
    let name = parsed.pathname.split("/").pop() || "";
    if (!name.toLowerCase().endsWith(".mp4")) name = `x-video-${Date.now()}.mp4`;
    return sanitizeFilename(name);
  } catch (_) {
    return `x-video-${Date.now()}.mp4`;
  }
}

function getGifFilename(url) {
  return getVideoFilename(url).replace(/\.mp4$/i, ".gif");
}

function ensurePositioned(container) {
  const style = window.getComputedStyle(container);
  if (style.position === "static") container.style.position = "relative";
}

function makeButton({ kind, title, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = XDL_BUTTON_CLASS;
  button.dataset.xdlKind = kind;
  button.title = title;
  button.setAttribute("aria-label", title);

  Object.assign(button.style, {
    width: "34px",
    height: "34px",
    border: "1px solid rgba(255,255,255,.22)",
    borderRadius: "999px",
    background: "rgba(15,20,25,.78)",
    color: "white",
    boxShadow: "0 4px 14px rgba(0,0,0,.25)",
    backdropFilter: "blur(8px)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    padding: "0",
    pointerEvents: "auto",
    transition: "transform .12s ease, background .12s ease, opacity .12s ease"
  });

  button.appendChild(makeSvgIcon(kind));
  button.addEventListener("mouseenter", () => {
    button.style.background = "rgba(29,155,240,.96)";
    button.style.transform = "translateY(-1px)";
  });
  button.addEventListener("mouseleave", () => {
    button.style.background = "rgba(15,20,25,.78)";
    button.style.transform = "translateY(0)";
  });
  button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;

    button.disabled = true;
    button.style.opacity = ".62";
    try {
      const result = await onClick();
      if (result?.needsPermission) {
        button.title = "下載資料夾需要重新授權；請點瀏覽器工具列的套件圖示";
        button.style.background = "rgba(244,33,46,.92)";
      } else if (!result?.ok) {
        button.title = result?.error || "下載失敗";
        button.style.background = "rgba(244,33,46,.92)";
      } else {
        button.style.background = "rgba(0,186,124,.92)";
      }
    } catch (error) {
      button.title = error?.message || "下載失敗";
      button.style.background = "rgba(244,33,46,.92)";
    }

    await sleep(850);
    button.style.opacity = "1";
    button.style.background = "rgba(15,20,25,.78)";
    button.disabled = false;
  });

  return button;
}

function makeButtonGroup(container) {
  const group = document.createElement("div");
  group.className = XDL_GROUP_CLASS;
  Object.assign(group.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    zIndex: "2147483647",
    display: "flex",
    gap: "6px",
    alignItems: "center",
    pointerEvents: "none"
  });
  container.appendChild(group);
  return group;
}

function clearInjectedControls() {
  document.querySelectorAll(`.${XDL_GROUP_CLASS}`).forEach((node) => node.remove());
}

function addImageButtons(container, img) {
  if (container.querySelector(`:scope > .${XDL_GROUP_CLASS}`)) return;
  ensurePositioned(container);
  const group = makeButtonGroup(container);

  const primaryQuality = settings.imageQuality === "displayed" ? "displayed" : "original";
  const secondaryQuality = primaryQuality === "original" ? "displayed" : "original";
  const titleFor = (quality) =>
    quality === "original" ? "下載最大可用尺寸" : "下載網頁目前顯示尺寸";

  group.appendChild(
    makeButton({
      kind: primaryQuality === "original" ? "original" : "download",
      title: titleFor(primaryQuality),
      onClick: async () => {
        const info = getImageDownloadInfo(img, primaryQuality);
        if (!info) return { ok: false, error: "找不到圖片網址" };
        return await sendDownload(info.url, info.filename);
      }
    })
  );

  if (settings.showAlternateButton) {
    group.appendChild(
      makeButton({
        kind: secondaryQuality === "original" ? "original" : "download",
        title: titleFor(secondaryQuality),
        onClick: async () => {
          const info = getImageDownloadInfo(img, secondaryQuality);
          if (!info) return { ok: false, error: "找不到圖片網址" };
          return await sendDownload(info.url, info.filename);
        }
      })
    );
  }
}

function validPhotoContainersInArticle(article) {
  return [...article.querySelectorAll('[data-testid="tweetPhoto"]')].filter((container) => {
    const nearestArticle = container.closest('article[data-testid="tweet"], article');
    if (nearestArticle !== article) return false;
    if (container.querySelector("video")) return false;
    if (container.querySelector('[data-testid="videoPlayer"]')) return false;
    const img = container.querySelector("img");
    return Boolean(img && !isVideoThumbnail(img));
  });
}

function inferMergeLayout(_containers) {
  // Multi-image downloads are intentionally stitched into one continuous row.
  // Do not mirror X's on-screen grid because a 3rd/4th image would wrap below.
  return "horizontal";
}

function mergedFilenameFrom(items) {
  const first = items[0]?.filename || `x-image-${Date.now()}.jpg`;
  const dot = first.lastIndexOf(".");
  const base = sanitizeFilename(dot > 0 ? first.slice(0, dot) : first);
  const allJpeg = items.every((item) => ["jpg", "jpeg", "jfif", "pjpeg"].includes((item.format || "").toLowerCase()));
  return `${base}-merged.${allJpeg ? "jpg" : "png"}`;
}

function addMergeButton(article) {
  if (!settings.mergeMultipleImages) return;
  const containers = validPhotoContainersInArticle(article);
  if (containers.length < 2 || containers.length > 4) return;

  const anchor = containers[0];
  let group = anchor.querySelector(`:scope > .${XDL_GROUP_CLASS}`);
  if (!group) {
    const img = anchor.querySelector("img");
    if (!img) return;
    addImageButtons(anchor, img);
    group = anchor.querySelector(`:scope > .${XDL_GROUP_CLASS}`);
  }
  if (!group || group.querySelector('[data-xdl-kind="merge"]')) return;

  group.appendChild(
    makeButton({
      kind: "merge",
      title: `合併下載這篇貼文的 ${containers.length} 張圖片`,
      onClick: async () => {
        const current = validPhotoContainersInArticle(article);
        if (current.length < 2) return { ok: false, error: "目前找不到可合併的多張圖片" };

        const quality = settings.mergeImageQuality === "displayed" ? "displayed" : "original";
        const items = current.slice(0, 4).map((container) => {
          const img = container.querySelector("img");
          return img ? getImageDownloadInfo(img, quality) : null;
        }).filter(Boolean);

        if (items.length < 2) return { ok: false, error: "無法取得足夠的圖片網址" };
        return await sendImageMerge(
          items,
          inferMergeLayout(current.slice(0, items.length)),
          mergedFilenameFrom(items)
        );
      }
    })
  );
}

function addVideoButton(container, video) {
  if (container.querySelector(`:scope > .${XDL_GROUP_CLASS}`)) return;
  ensurePositioned(container);
  const group = makeButtonGroup(container);

  group.appendChild(
    makeButton({
      kind: "video",
      title: "下載影片 / GIF",
      onClick: async () => {
        const media = await resolveVideo(video);
        if (!media?.url) {
          return { ok: false, error: "尚未取得完整 MP4。先播放影片約 1 秒，再按一次下載。" };
        }

        if (media.mediaType === "animated_gif" && settings.convertShortGif) {
          const converted = await sendGifConversion(
            media.url,
            getGifFilename(media.url),
            settings.gifMaxDuration,
            settings.gifScalePercent,
            settings.gifFps
          );

          if (converted?.ok) return converted;
          if (converted?.tooLong) return await sendDownload(media.url, getVideoFilename(media.url));

          console.warn("[XDL] GIF conversion failed; falling back to MP4", converted);
          return await sendDownload(media.url, getVideoFilename(media.url));
        }

        return await sendDownload(media.url, getVideoFilename(media.url));
      }
    })
  );
}

function scanVideos() {
  document.querySelectorAll("video").forEach((video) => {
    const container =
      video.closest('[data-testid="videoPlayer"]') ||
      video.closest('[data-testid="videoComponent"]') ||
      video.parentElement;
    if (!container) return;
    container.dataset.xdlVideo = "true";
    addVideoButton(container, video);
  });
}

function scanImages() {
  document.querySelectorAll('[data-testid="tweetPhoto"]').forEach((container) => {
    if (container.querySelector("video")) return;
    if (container.querySelector('[data-testid="videoPlayer"]')) return;
    const img = container.querySelector("img");
    if (!img || isVideoThumbnail(img)) return;
    addImageButtons(container, img);
  });
}

function scanMergeButtons() {
  document.querySelectorAll('article[data-testid="tweet"], article').forEach((article) => {
    addMergeButton(article);
  });
}

function scan() {
  scanVideos();
  scanImages();
  scanMergeButtons();
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, 180);
}

(async () => {
  await loadSettings();
  scan();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let changed = false;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (changes[key]) {
      settings[key] = changes[key].newValue;
      changed = true;
    }
  }
  if (changed) {
    clearInjectedControls();
    scheduleScan();
  }
});
