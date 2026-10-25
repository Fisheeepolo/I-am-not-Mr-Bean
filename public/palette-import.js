/** Parse user supplied palettes without inventing missing codes or colors. */
export function parsePalette(text, filename = '') {
  if (typeof text !== 'string') throw new Error('色卡内容必须是文本。');
  const content = text.replace(/^\uFEFF/, '').trim();
  if (!content) throw new Error('色卡文件是空的，请选择包含色号和颜色的文件。');
  const fallbackName = String(filename).split(/[\\/]/).pop().replace(/\.[^.]*$/, '') || '自定义色卡';
  const extension = String(filename).match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  const useJSON = extension === 'json' || (extension !== 'csv' && /^[\[{]/.test(content));
  let rows;
  let name = fallbackName;

  if (useJSON) {
    let value;
    try { value = JSON.parse(content); }
    catch { throw new Error('JSON 格式不正确，请检查引号、逗号和括号。'); }
    if (Array.isArray(value)) rows = value;
    else if (value && typeof value === 'object' && Array.isArray(value.colors)) {
      rows = value.colors;
      if (value.name !== undefined) {
        if (typeof value.name !== 'string' || !value.name.trim()) {
          throw new Error('色卡名称 name 必须是非空文本。');
        }
        name = value.name.trim();
      }
    } else throw new Error('JSON 应为颜色数组，或包含 colors 数组的对象。');
  } else {
    const records = parseCSV(content);
    if (!records.length) throw new Error('CSV 文件中没有可读取的内容。');
    const aliases = { code: 'code', hex: 'hex', name: 'name', '色号': 'code', '颜色': 'hex', '色名': 'name' };
    const headers = records[0].map(cell => aliases[cell.trim().toLowerCase()] || null);
    for (const field of ['code', 'hex', 'name']) {
      if (headers.filter(header => header === field).length > 1) {
        throw new Error(`CSV 表头重复：${field === 'code' ? '色号' : field === 'hex' ? '颜色' : '色名'}。`);
      }
    }
    if (!headers.includes('code') || !headers.includes('hex')) {
      throw new Error('CSV 第一行必须包含 code,hex（或 色号,颜色），可选 name（色名）。');
    }
    rows = records.slice(1).map((record, index) => {
      if (record.length !== headers.length) {
        throw new Error(`CSV 第 ${index + 2} 行列数与表头不一致；含逗号的内容请用双引号包住。`);
      }
      const row = {};
      headers.forEach((header, column) => { if (header) row[header] = record[column]; });
      return row;
    });
  }

  if (rows.length < 1 || rows.length > 1000) throw new Error('色卡必须包含 1–1000 种颜色。');
  const seen = new Set();
  const colors = rows.map((row, index) => {
    const label = `第 ${index + 1} 个颜色`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`${label}必须是包含 code 和 hex 的对象。`);
    if (typeof row.code !== 'string') throw new Error(`${label}的色号 code 必须是文本。`);
    const code = row.code.trim();
    if (!/^[\p{Script=Han}A-Za-z0-9_-]{1,20}$/u.test(code)) {
      throw new Error(`${label}的色号无效：仅允许 1–20 个中英文、数字、下划线或连字符。`);
    }
    if (seen.has(code)) throw new Error(`色号「${code}」重复，请每个色号只保留一条。`);
    seen.add(code);
    if (typeof row.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(row.hex.trim())) {
      throw new Error(`色号「${code}」的颜色必须为 #RRGGBB，例如 #FFCC88。`);
    }
    const color = { code, hex: row.hex.trim().toUpperCase() };
    if (row.name !== undefined) {
      if (typeof row.name !== 'string') throw new Error(`色号「${code}」的色名 name 必须是文本。`);
      if (row.name.trim()) color.name = row.name.trim();
    }
    return color;
  });
  return { name, colors };
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishField = () => {
    row.push(field);
    field = '';
    closedQuote = false;
  };
  const finishRow = () => {
    finishField();
    // Empty physical lines are harmless; comma-only rows remain invalid data.
    if (row.length > 1 || row[0].trim()) rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === ',') finishField();
    else if (char === '\n' || char === '\r') {
      finishRow();
      if (char === '\r' && text[index + 1] === '\n') index++;
    } else if (closedQuote) {
      if (!/[ \t]/.test(char)) throw new Error('CSV 引号后的内容无效，请用逗号或换行分隔。');
    } else if (char === '"') {
      if (field.trim()) throw new Error('CSV 引号位置不正确；含双引号的字段需要整体用双引号包住。');
      field = '';
      quoted = true;
    } else field += char;
  }
  if (quoted) throw new Error('CSV 存在未闭合的双引号，请检查后重新导入。');
  finishRow();
  return rows;
}
