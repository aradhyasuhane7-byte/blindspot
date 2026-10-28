'use strict';

/** Minimal RFC 4180-safe CSV builder (commas, quotes, newlines; formula-guard). */
function escape(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/"/g, '""');
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')
    || s.startsWith('=') || s.startsWith('+') || s.startsWith('@')) {
    s = '"' + s + '"';
  }
  return s;
}

class CsvBuilder {
  constructor() { this.lines = []; }

  row(cells) {
    this.lines.push((cells || []).map(escape).join(','));
    return this;
  }

  build() {
    return this.lines.length ? this.lines.join('\n') + '\n' : '';
  }
}

function cleanToken(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9_-]/g, '-');
}

module.exports = { escape, CsvBuilder, cleanToken };
