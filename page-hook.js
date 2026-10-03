(() => {
  if (window.__XDL_PAGE_HOOK_V040__) return;
  window.__XDL_PAGE_HOOK_V040__ = true;

  const SOURCE = "xdl-page-hook-v040";

  function extractMediaKey(url) {
    if (!url || typeof url !== "string") return null;

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

  function normalizedType(value) {
    const candidates = [
      value?.type,
      value?.media_type,
      value?.legacy?.type
    ];

    for (const candidate of candidates) {
      if (candidate === "animated_gif" || candidate === "video") return candidate;
    }

    return null;
  }

  function collectVariants(root) {
    const grouped = new Map();
    const seen = new WeakSet();
    const stack = [root];
    let visited = 0;

    function ensureGroup(mediaKey) {
      if (!grouped.has(mediaKey)) {
        grouped.set(mediaKey, { variants: [], mediaType: null });
      }
      return grouped.get(mediaKey);
    }

    while (stack.length && visited < 120000) {
      const value = stack.pop();
      visited += 1;

      if (!value || typeof value !== "object") continue;
      if (seen.has(value)) continue;
      seen.add(value);

      const objectType = normalizedType(value);
      const directVariants = Array.isArray(value?.video_info?.variants)
        ? value.video_info.variants
        : Array.isArray(value?.legacy?.video_info?.variants)
          ? value.legacy.video_info.variants
          : null;

      if (objectType && directVariants) {
        for (const variant of directVariants) {
          const url = typeof variant?.url === "string" ? variant.url : null;
          if (!url || !url.includes("video.twimg.com")) continue;
          const mediaKey = extractMediaKey(url);
          if (!mediaKey) continue;
          ensureGroup(mediaKey).mediaType = objectType;
        }
      }

      if (!Array.isArray(value)) {
        const url = typeof value.url === "string" ? value.url : null;
        if (url && url.includes("video.twimg.com")) {
          const isMp4 = /\.mp4(?:\?|$)/i.test(url) || value.content_type === "video/mp4";
          const isHls = /\.m3u8(?:\?|$)/i.test(url) || value.content_type === "application/x-mpegURL";

          if (isMp4 || isHls) {
            const mediaKey = extractMediaKey(url);
            if (mediaKey) {
              const item = {
                url,
                bitrate: Number(value.bitrate) || 0,
                contentType: typeof value.content_type === "string"
                  ? value.content_type
                  : (isMp4 ? "video/mp4" : "application/x-mpegURL")
              };

              const group = ensureGroup(mediaKey);
              if (!group.variants.some((entry) => entry.url === item.url)) {
                group.variants.push(item);
              }
              if (!group.mediaType && objectType) group.mediaType = objectType;
            }
          }
        }
      }

      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          const child = value[i];
          if (child && typeof child === "object") stack.push(child);
        }
      } else {
        for (const child of Object.values(value)) {
          if (child && typeof child === "object") stack.push(child);
        }
      }
    }

    for (const [mediaKey, group] of grouped.entries()) {
      group.variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      window.postMessage(
        {
          source: SOURCE,
          type: "XDL_MEDIA_VARIANTS",
          mediaKey,
          variants: group.variants,
          mediaType: group.mediaType
        },
        "*"
      );
    }
  }

  async function inspectFetchResponse(response) {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("json")) return;
      const data = await response.json();
      collectVariants(data);
    } catch (_) {
      // Never affect the X page response.
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      void inspectFetchResponse(response.clone());
    } catch (_) {}
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xdlUrl = typeof url === "string" ? url : "";
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      try {
        const contentType = this.getResponseHeader("content-type") || "";
        if (!contentType.includes("json")) return;

        if (this.responseType === "json" && this.response) {
          collectVariants(this.response);
          return;
        }

        if (this.responseType === "" || this.responseType === "text") {
          const text = this.responseText;
          if (!text) return;
          collectVariants(JSON.parse(text));
        }
      } catch (_) {}
    }, { once: true });

    return originalSend.apply(this, args);
  };
})();
