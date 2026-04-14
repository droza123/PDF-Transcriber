/**
 * Polyfills for newer Uint8Array methods used by pdfjs-dist v5.x.
 * These are part of the TC39 "Uint8Array to/from base64 and hex" proposal
 * and may not be available in older browsers or Electron versions.
 */

if (typeof Uint8Array.prototype.toHex !== 'function') {
  Uint8Array.prototype.toHex = function (): string {
    let hex = '';
    for (let i = 0; i < this.length; i++) {
      hex += this[i].toString(16).padStart(2, '0');
    }
    return hex;
  };
}

if (typeof Uint8Array.fromHex !== 'function') {
  Uint8Array.fromHex = function (hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new SyntaxError('Invalid hex string');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      const parsed = parseInt(hex.slice(i, i + 2), 16);
      if (Number.isNaN(parsed)) throw new SyntaxError('Invalid hex string');
      bytes[i / 2] = parsed;
    }
    return bytes;
  };
}

if (typeof Uint8Array.prototype.toBase64 !== 'function') {
  Uint8Array.prototype.toBase64 = function (): string {
    let binary = '';
    for (let i = 0; i < this.length; i++) {
      binary += String.fromCharCode(this[i]);
    }
    return btoa(binary);
  };
}

if (typeof Uint8Array.fromBase64 !== 'function') {
  Uint8Array.fromBase64 = function (base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };
}
