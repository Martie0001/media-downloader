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

  function makePalette() {
    const palette = new Uint8Array(256 * 3);
    let offset = 0;

    for (let r = 0; r < 8; r += 1) {
      for (let g = 0; g < 8; g += 1) {
        for (let b = 0; b < 4; b += 1) {
          palette[offset++] = Math.round((r * 255) / 7);
          palette[offset++] = Math.round((g * 255) / 7);
          palette[offset++] = Math.round((b * 255) / 3);
        }
      }
    }

    return palette;
  }

  const GLOBAL_PALETTE = makePalette();

  function rgbaToIndexed(rgba) {
    const pixels = new Uint8Array(rgba.length / 4);
    let out = 0;

    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i] >> 5;
      const g = rgba[i + 1] >> 5;
      const b = rgba[i + 2] >> 6;
      pixels[out++] = (r << 5) | (g << 2) | b;
    }

    return pixels;
  }

  function lzwEncode(indices, minCodeSize = 8) {
    if (!indices.length) return new Uint8Array(0);

    // GIF LZW allows a clear code at any time. For reliability and low
    // implementation complexity we periodically clear the dictionary before
    // the code width would need to grow beyond 9 bits. This trades some file
    // size for predictable decoding across browsers and image viewers.
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    const codeSize = minCodeSize + 1;
    const literalsPerBlock = 200;

    const output = [];
    let bitBuffer = 0;
    let bitCount = 0;

    const writeCode = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;

      while (bitCount >= 8) {
        output.push(bitBuffer & 0xff);
        bitBuffer >>>= 8;
        bitCount -= 8;
      }
    };

    writeCode(clearCode);
    let literalsSinceClear = 0;

    for (let i = 0; i < indices.length; i += 1) {
      writeCode(indices[i]);
      literalsSinceClear += 1;

      if (literalsSinceClear >= literalsPerBlock && i + 1 < indices.length) {
        writeCode(clearCode);
        literalsSinceClear = 0;
      }
    }

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
      header.u8(0xf7);
      header.u8(0);
      header.u8(0);
      header.bytes(GLOBAL_PALETTE);

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
      const indexed = rgbaToIndexed(rgba);
      this.addIndexedFrame(indexed);
    }

    addIndexedFrame(indexed) {
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
      writer.u8(0x00);

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
    rgbaToIndexed,
    lzwEncode,
    palette: GLOBAL_PALETTE
  };
})();
