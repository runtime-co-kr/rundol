'use strict';

function unquote(value) {
  const text = value.trim();
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseScalar(value) {
  const text = value.trim();
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((item) => parseScalar(item));
  }
  return unquote(text);
}

function parseFrontmatter(source) {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const yaml = normalized.slice(4, end);
  const lines = yaml.split('\n');
  const data = {};
  const locations = {};
  let currentKey = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyMatch = /^([A-Za-z][A-Za-z0-9-]*):(?:\s*(.*))?$/.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1];
      locations[currentKey] = index + 2;
      const rest = keyMatch[2] || '';
      data[currentKey] = rest === '' ? [] : parseScalar(rest);
      continue;
    }
    const itemMatch = /^\s{2}-\s*(.*)$/.exec(line);
    if (itemMatch && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(parseScalar(itemMatch[1]));
    }
  }

  return {
    data,
    locations,
    body: normalized.slice(end + 5),
    bodyStartLine: yaml.split('\n').length + 3
  };
}

module.exports = { parseFrontmatter };
