(() => {
  class ByteWriter {
    constructor() {
      this.data = [];
    }

    u8(value) {
      this.data.push(value & 0xff);
    }

    u16(value) {
      this.u8(value);
      this.u8(value >> 8);
    }

    ascii(text) {
      for (let i = 0; i < text.length; i += 1) this.u8(text.charCodeAt(i));
    }

    bytes(bytes) {
      for (let i = 0; i < bytes.length; i += 1) this.u8(bytes[i]);
    }

    toUint8Array() {
      return Uint8Array.from(this.data);
    }
  }

  const HISTOGRAM_SIZE = 16 * 16 * 16;
  const MAX_COLORS = 256;

  function clampByte(value) {
    if (value < 0) return 0;
    if (value > 255) return 255;
    return value;
  }

  function histogramKey(r, g, b) {
    return ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  }

  function buildHistogram(rgba) {
    const counts = new Uint32Array(HISTOGRAM_SIZE);
    const sumR = new Uint32Array(HISTOGRAM_SIZE);
    const sumG = new Uint32Array(HISTOGRAM_SIZE);
    const sumB = new Uint32Array(HISTOGRAM_SIZE);

    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i];
      const g = rgba[i + 1];
      const b = rgba[i + 2];
      const key = histogramKey(r, g, b);
      counts[key] += 1;
      sumR[key] += r;
      sumG[key] += g;
      sumB[key] += b;
    }

    const entries = [];
    for (let key = 0; key < HISTOGRAM_SIZE; key += 1) {
      const count = counts[key];
      if (!count) continue;
      entries.push({
        key,
        count,
        r: sumR[key] / count,
        g: sumG[key] / count,
        b: sumB[key] / count
      });
    }
    return entries;
  }

  function getBoxStats(entries) {
    let minR = 255;
    let minG = 255;
    let minB = 255;
    let maxR = 0;
    let maxG = 0;
    let maxB = 0;
    let total = 0;

    for (const entry of entries) {
      if (entry.r < minR) minR = entry.r;
      if (entry.g < minG) minG = entry.g;
      if (entry.b < minB) minB = entry.b;
      if (entry.r > maxR) maxR = entry.r;
      if (entry.g > maxG) maxG = entry.g;
      if (entry.b > maxB) maxB = entry.b;
      total += entry.count;
    }

    const rangeR = maxR - minR;
    const rangeG = maxG - minG;
    const rangeB = maxB - minB;
    const maxRange = Math.max(rangeR, rangeG, rangeB);

    return {
      rangeR,
      rangeG,
      rangeB,
      total,
      score: maxRange * Math.sqrt(Math.max(1, total))
    };
  }

  function splitBox(entries) {
    if (entries.length <= 1) return null;

    const stats = getBoxStats(entries);
    let channel = "r";
    if (stats.rangeG >= stats.rangeR && stats.rangeG >= stats.rangeB) channel = "g";
    else if (stats.rangeB >= stats.rangeR && stats.rangeB >= stats.rangeG) channel = "b";

    const sorted = [...entries].sort((a, b) => a[channel] - b[channel]);
    const target = stats.total / 2;
    let cumulative = 0;
    let splitAt = 1;

    for (let i = 0; i < sorted.length - 1; i += 1) {
      cumulative += sorted[i].count;
      if (cumulative >= target) {
        splitAt = i + 1;
        break;
      }
    }

    if (splitAt <= 0 || splitAt >= sorted.length) splitAt = Math.floor(sorted.length / 2);
    return [sorted.slice(0, splitAt), sorted.slice(splitAt)];
  }

  function medianCut(entries, maxColors = MAX_COLORS) {
    if (!entries.length) return [{ r: 0, g: 0, b: 0 }];

    const boxes = [entries];

    while (boxes.length < maxColors) {
      let bestIndex = -1;
      let bestScore = -1;

      for (let i = 0; i < boxes.length; i += 1) {
        const box = boxes[i];
        if (box.length <= 1) continue;
        const score = getBoxStats(box).score;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = i;
        }
      }

      if (bestIndex < 0) break;
      const split = splitBox(boxes[bestIndex]);
      if (!split || !split[0].length || !split[1].length) break;
      boxes.splice(bestIndex, 1, split[0], split[1]);
    }

    return boxes.map((box) => {
      let total = 0;
      let r = 0;
      let g = 0;
      let b = 0;

      for (const entry of box) {
        total += entry.count;
        r += entry.r * entry.count;
        g += entry.g * entry.count;
        b += entry.b * entry.count;
      }

      if (!total) return { r: 0, g: 0, b: 0 };
      return {
        r: Math.round(r / total),
        g: Math.round(g / total),
        b: Math.round(b / total)
      };
    });
  }

  function makePaletteBytes(colors) {
    const palette = new Uint8Array(MAX_COLORS * 3);
    for (let i = 0; i < Math.min(colors.length, MAX_COLORS); i += 1) {
      palette[i * 3] = colors[i].r;
      palette[i * 3 + 1] = colors[i].g;
      palette[i * 3 + 2] = colors[i].b;
    }
    return palette;
  }

  function buildNearestLookup(colors) {
    const lookup = new Uint8Array(HISTOGRAM_SIZE);

    for (let key = 0; key < HISTOGRAM_SIZE; key += 1) {
      const r = ((key >> 8) & 0x0f) * 17;
      const g = ((key >> 4) & 0x0f) * 17;
      const b = (key & 0x0f) * 17;
      let bestIndex = 0;
      let bestDistance = Infinity;

      for (let i = 0; i < colors.length; i += 1) {
        const dr = r - colors[i].r;
        const dg = g - colors[i].g;
        const db = b - colors[i].b;
        // Slightly favor green accuracy because human vision is more sensitive to it.
        const distance = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = i;
        }
      }

      lookup[key] = bestIndex;
    }

    return lookup;
  }

  function ditherToIndexed(rgba, width, height, colors, nearestLookup) {
    const indexed = new Uint8Array(width * height);
    let currentError = new Float32Array((width + 2) * 3);
    let nextError = new Float32Array((width + 2) * 3);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelOffset = (y * width + x) * 4;
        const errorOffset = (x + 1) * 3;

        const r = clampByte(rgba[pixelOffset] + currentError[errorOffset]);
        const g = clampByte(rgba[pixelOffset + 1] + currentError[errorOffset + 1]);
        const b = clampByte(rgba[pixelOffset + 2] + currentError[errorOffset + 2]);

        const paletteIndex = nearestLookup[histogramKey(r, g, b)];
        const color = colors[paletteIndex];
        indexed[y * width + x] = paletteIndex;

        const er = r - color.r;
        const eg = g - color.g;
        const eb = b - color.b;

        // Floyd-Steinberg error diffusion.
        let o = (x + 2) * 3;
        currentError[o] += er * (7 / 16);
        currentError[o + 1] += eg * (7 / 16);
        currentError[o + 2] += eb * (7 / 16);

        o = x * 3;
        nextError[o] += er * (3 / 16);
        nextError[o + 1] += eg * (3 / 16);
        nextError[o + 2] += eb * (3 / 16);

        o = (x + 1) * 3;
        nextError[o] += er * (5 / 16);
        nextError[o + 1] += eg * (5 / 16);
        nextError[o + 2] += eb * (5 / 16);

        o = (x + 2) * 3;
        nextError[o] += er * (1 / 16);
        nextError[o + 1] += eg * (1 / 16);
        nextError[o + 2] += eb * (1 / 16);
      }

      const swap = currentError;
      currentError = nextError;
      nextError = swap;
      nextError.fill(0);
    }

    return indexed;
  }

  function quantizeFrame(rgba, width, height) {
    const entries = buildHistogram(rgba);
    const colors = medianCut(entries, MAX_COLORS);
    const nearestLookup = buildNearestLookup(colors);
    return {
      indexed: ditherToIndexed(rgba, width, height, colors, nearestLookup),
      palette: makePaletteBytes(colors),
      colors
    };
  }

  function lzwEncode(indices, minCodeSize = 8) {
    if (!indices.length) return new Uint8Array(0);

    // Keep the stream at 9 bits and clear the dictionary before a 10-bit
    // code would be required. This is standards-compliant GIF LZW, gives
    // useful dictionary compression, and avoids the very inefficient
    // literal-only stream used in V0.5.1.
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    const codeSize = minCodeSize + 1;
    const dictionaryLimit = (1 << codeSize) - 1;
    const output = [];
    let bitBuffer = 0;
    let bitCount = 0;
    let nextCode = endCode + 1;
    let dictionary = new Map();

    const writeCode = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) {
        output.push(bitBuffer & 0xff);
        bitBuffer >>>= 8;
        bitCount -= 8;
      }
    };

    const resetDictionary = () => {
      dictionary = new Map();
      nextCode = endCode + 1;
    };

    writeCode(clearCode);
    let prefix = indices[0];

    for (let i = 1; i < indices.length; i += 1) {
      const suffix = indices[i];
      const key = (prefix << 8) | suffix;
      const found = dictionary.get(key);

      if (found !== undefined) {
        prefix = found;
        continue;
      }

      writeCode(prefix);

      if (nextCode < dictionaryLimit) {
        dictionary.set(key, nextCode);
        nextCode += 1;
      } else {
        writeCode(clearCode);
        resetDictionary();
      }

      prefix = suffix;
    }

    writeCode(prefix);
    writeCode(endCode);
    if (bitCount > 0) output.push(bitBuffer & 0xff);
    return Uint8Array.from(output);
  }

  function writeSubBlocks(writer, data) {
    let offset = 0;
    while (offset < data.length) {
      const size = Math.min(255, data.length - offset);
      writer.u8(size);
      writer.bytes(data.subarray(offset, offset + size));
      offset += size;
    }
    writer.u8(0);
  }

  class GifEncoder {
    constructor(width, height, delayCs = 10) {
      this.width = width;
      this.height = height;
      this.delayCs = Math.max(1, Math.round(delayCs));
      this.parts = [];
      this.finished = false;

      const header = new ByteWriter();
      header.ascii("GIF89a");
      header.u16(width);
      header.u16(height);
      // No global color table. Each frame gets its own adaptive 256-color palette.
      header.u8(0x70);
      header.u8(0);
      header.u8(0);

      header.u8(0x21);
      header.u8(0xff);
      header.u8(0x0b);
      header.ascii("NETSCAPE2.0");
      header.u8(0x03);
      header.u8(0x01);
      header.u16(0);
      header.u8(0x00);

      this.parts.push(header.toUint8Array());
    }

    addRgbaFrame(rgba) {
      if (this.finished) throw new Error("GIF encoder already finished");
      if (rgba.length !== this.width * this.height * 4) {
        throw new Error("GIF frame size does not match encoder dimensions");
      }

      const frame = quantizeFrame(rgba, this.width, this.height);
      this.addIndexedFrame(frame.indexed, frame.palette);
    }

    addIndexedFrame(indexed, palette) {
      const writer = new ByteWriter();

      writer.u8(0x21);
      writer.u8(0xf9);
      writer.u8(0x04);
      writer.u8(0x00);
      writer.u16(this.delayCs);
      writer.u8(0x00);
      writer.u8(0x00);

      writer.u8(0x2c);
      writer.u16(0);
      writer.u16(0);
      writer.u16(this.width);
      writer.u16(this.height);
      // Local color table flag + 256-entry table.
      writer.u8(0x87);
      writer.bytes(palette);

      writer.u8(8);
      const compressed = lzwEncode(indexed, 8);
      writeSubBlocks(writer, compressed);

      this.parts.push(writer.toUint8Array());
    }

    finish() {
      if (!this.finished) {
        this.parts.push(Uint8Array.of(0x3b));
        this.finished = true;
      }
      return new Blob(this.parts, { type: "image/gif" });
    }
  }

  globalThis.XDLGifEncoder = {
    GifEncoder,
    quantizeFrame,
    lzwEncode
  };
})();
