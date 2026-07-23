/**
 * Единый парсер грида BPM (content script + executeScript).
 * globalThis.__bpmCollectTasks() → { tasks, pagerTotal, hidden }
 */
(function () {
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseInstanceName(raw) {
    const text = (raw || '').trim();
    if (!text) return { client: '', address: '' };
    if (looksLikeSosValue(text) || looksLikeDate(text) || isTargetTitle(text)) {
      return { client: '', address: '' };
    }

    const conn = text.match(
      /^Подключение\s+[\"«`'“](.+?)[\"»`'”]\s+по\s+ТЭО/i
    );
    if (conn) return { client: conn[1].trim(), address: '' };

    let cleaned = text
      .replace(/\s*\[[\d]+\]\s*$/, '')
      .replace(/\s+(RIAS|KRUS)-[\w.-]+\s*$/i, '')
      .trim();

    const parts = cleaned
      .split(/\.\s+/)
      .map((p) => p.trim())
      .filter(Boolean);

    const orgRe =
      /(ООО|ОАО|АО|ПАО|ЗАО|ИП|Общество с ограниченной|АКЦИОНЕРН|ПУБЛИЧН|ГОСУДАРСТВЕНН)/i;
    const addressRe =
      /(Санкт-Петербург|Ленинград|ул\.|улица|пр-кт|проспект|ш\.|шоссе|пер\.|наб\.|, \d)/i;

    let client = '';
    let address = '';

    for (const part of parts) {
      if (!client && orgRe.test(part)) client = part;
      else if (!address && addressRe.test(part)) address = part;
    }

    if (!client && !address && parts.length >= 2) {
      if (addressRe.test(parts[0])) {
        address = parts[0];
        client = parts.slice(1).join('. ');
      } else {
        client = parts[0];
        address = parts.slice(1).join('. ');
      }
    } else if (!client && address && parts.length >= 2) {
      client = parts.find((p) => p !== address) || '';
    } else if (client && !address && parts.length >= 2) {
      address = parts.find((p) => p !== client && addressRe.test(p)) || '';
    }

    if (!client && !address && !looksLikeSosValue(cleaned)) client = cleaned;

    if (looksLikeSosValue(client)) client = '';
    if (looksLikeSosValue(address)) address = '';

    return {
      client: client.replace(/\.+$/, '').trim(),
      address: address.replace(/\.+$/, '').trim()
    };
  }

  function parsePageDate(dateStr) {
    if (!dateStr) return null;
    const clean = dateStr.trim();
    const months = {
      янв: 0,
      фев: 1,
      мар: 2,
      апр: 3,
      мая: 4,
      май: 4,
      июн: 5,
      июл: 6,
      авг: 7,
      сен: 8,
      окт: 9,
      ноя: 10,
      дек: 11
    };

    const rusMatch = clean.match(
      /(\d{1,2})\s+([а-я]{3,})\.?\s+(\d{4})\s*г?\.?,?\s*(\d{1,2}):(\d{2}):(\d{2})/i
    );
    if (rusMatch) {
      const month = months[rusMatch[2].toLowerCase().substring(0, 3)];
      if (month === undefined) return null;
      return new Date(
        parseInt(rusMatch[3], 10),
        month,
        parseInt(rusMatch[1], 10),
        parseInt(rusMatch[4], 10) || 0,
        parseInt(rusMatch[5], 10) || 0,
        parseInt(rusMatch[6], 10) || 0
      ).getTime();
    }

    const dotMatch = clean.match(
      /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/
    );
    if (dotMatch) {
      return new Date(
        parseInt(dotMatch[3], 10),
        parseInt(dotMatch[2], 10) - 1,
        parseInt(dotMatch[1], 10),
        parseInt(dotMatch[4], 10),
        parseInt(dotMatch[5], 10),
        parseInt(dotMatch[6], 10)
      ).getTime();
    }

    const isoMatch = clean.match(
      /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/
    );
    if (isoMatch) {
      return new Date(
        parseInt(isoMatch[1], 10),
        parseInt(isoMatch[2], 10) - 1,
        parseInt(isoMatch[3], 10),
        parseInt(isoMatch[4], 10),
        parseInt(isoMatch[5], 10),
        parseInt(isoMatch[6], 10)
      ).getTime();
    }

    return null;
  }

  function extractDateFromText(text) {
    if (!text) return null;
    const patterns = [
      /(\d{1,2}\s+[а-я]{3,}\.?\s+\d{4}\s*г?\.?,?\s*\d{1,2}:\d{2}:\d{2})/i,
      /(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}:\d{2})/,
      /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  let columnMapCache;

  function cellText(el) {
    return (el?.innerText || el?.textContent || '').trim();
  }

  function getColClassKey(el) {
    const cls = String(el?.className || '');
    const m = cls.match(/\bui-grid-col[A-Za-z0-9_-]+\b/);
    return m ? m[0] : null;
  }

  function getRowCells(row) {
    // Только целые ячейки грида — не .ng-binding (ломает индексы колонок)
    const uiCells = row.querySelectorAll(':scope > .ui-grid-cell, .ui-grid-cell');
    if (uiCells.length) {
      const list = Array.from(uiCells);
      // Уникальные по col-классу / порядку
      const seen = new Set();
      const out = [];
      for (const cell of list) {
        const key = getColClassKey(cell) || `i${out.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cell);
      }
      if (out.length) return out;
    }
    return Array.from(
      row.querySelectorAll('td, .grid-cell, .dgrid-cell, .cell')
    );
  }

  function looksLikeDate(s) {
    const t = (s || '').trim();
    return (
      /\d{1,2}\s+[а-яё]{3,}\.?\s+\d{4}/i.test(t) ||
      /\d{2}\.\d{2}\.\d{4}/.test(t) ||
      /\d{4}-\d{2}-\d{2}/.test(t)
    );
  }

  function looksLikeSosValue(s) {
    const t = String(s || '').trim();
    if (!t || t.length > 100 || looksLikeDate(t)) return false;
    const low = t.toLowerCase().replace(/\s+/g, ' ');
    if (/\bp2mp\b|\bp2p\b|p2mp|p2p/i.test(t)) return true;
    if (/\bдроп\b|\bdrop\b/i.test(low) || low.includes('дроп')) return true;
    if (
      low.includes('волс') ||
      low.includes('vols') ||
      low.includes('оптоволок') ||
      low.includes('медн') ||
      low.includes('медь') ||
      low.includes('кабел') ||
      low.includes('copper') ||
      low.includes('радио') ||
      low.includes('схема 1') ||
      low.includes('сх.1')
    ) {
      return true;
    }
    // Короткое значение колонки СОС: «ВОЛС», «Медь», «ДРОП» и т.п.
    if (t.length <= 40 && !t.includes('прз') && !t.includes('фрз') && !t.includes('пкм')) {
      if (
        /^(волс|медь|медный|copper|cu|radio|радио|дроп|drop)\b/i.test(t)
      ) {
        return true;
      }
    }
    return false;
  }

  function headerTextMatchesInstanceCreated(text) {
    const t = (text || '').toLowerCase().replace(/\s+/g, ' ');
    return (
      t.includes('дата создания экземпляра') ||
      t.includes('создания экземпляра') ||
      (t.includes('создан') && t.includes('экземпляр'))
    );
  }

  function headerTextMatchesReceived(text) {
    const t = (text || '').toLowerCase().replace(/\s+/g, ' ');
    return (
      t.includes('дата получения') ||
      t.includes('получения задачи')
    );
  }

  function headerTextMatchesSos(text) {
    const t = (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (t === 'сос') return true;
    if (/^сос(\s|$|:|\(|—|-)/.test(t)) return true;
    return (
      t.includes('схема подключ') ||
      t.includes('схема соединения') ||
      t.includes('схема соедин')
    );
  }

  function buildColumnMap() {
    if (columnMapCache) return columnMapCache;

    const byKey = {};
    const byIndex = [];

    const headerCells = document.querySelectorAll(
      [
        '.ui-grid-header-cell',
        '.ui-grid-header .ui-grid-cell',
        '.taskGridRow.header .ui-grid-cell',
        '.taskGridRow.heading .ui-grid-cell',
        '[class*="taskGridRow"].header [class*="ui-grid-cell"]',
        '[role="columnheader"]'
      ].join(', ')
    );

    headerCells.forEach((h, idx) => {
      const labelEl =
        h.querySelector(
          '.ui-grid-header-cell-label, .ui-grid-cell-contents, span'
        ) || h;
      const text = cellText(labelEl) || cellText(h);
      const key = getColClassKey(h);
      const entry = { text, index: idx };
      if (key) byKey[key] = entry;
      byIndex[idx] = entry;
    });

    // Angular columnDefs — запасной путь
    try {
      if (typeof angular !== 'undefined') {
        document
          .querySelectorAll('.ui-grid, [ui-grid], [class*="ui-grid"]')
          .forEach((el) => {
            let scope = angular.element(el).scope();
            for (let d = 0; d < 12 && scope; d += 1) {
              const cols =
                scope.gridOptions?.columnDefs ||
                scope.grid?.columns ||
                scope.colContainer?.renderedCols;
              if (Array.isArray(cols)) {
                cols.forEach((col, i) => {
                  const text = String(
                    col.displayName || col.name || col.field || ''
                  ).trim();
                  const field = String(col.field || col.name || '').trim();
                  if (!text && !field) return;
                  byIndex[i] = byIndex[i] || { text: text || field, index: i };
                  if (text) byIndex[i].text = text;
                  byIndex[i].field = field;
                });
              }
              scope = scope.$parent;
            }
          });
      }
    } catch (_) {
      /* ignore */
    }

    columnMapCache = { byKey, byIndex };
    return columnMapCache;
  }

  function findInstanceNameInTexts(texts) {
    const orgRe =
      /(ООО|ОАО|АО|ПАО|ЗАО|ИП|Общество с ограниченной|АКЦИОНЕРН|ПУБЛИЧН|ГОСУДАРСТВЕНН)/i;
    return (
      texts.find(
        (t) =>
          t.length > 8 &&
          !looksLikeDate(t) &&
          !looksLikeSosValue(t) &&
          !isTargetTitle(t) &&
          (t.includes('Подключение') || orgRe.test(t))
      ) ||
      texts.find(
        (t) =>
          t.length > 12 &&
          !looksLikeDate(t) &&
          !looksLikeSosValue(t) &&
          !isTargetTitle(t) &&
          /(Санкт-Петербург|ул\.|улица|пр-кт|проспект)/i.test(t)
      ) ||
      ''
    );
  }

  function extractFieldsFromCells(cells) {
    const map = buildColumnMap();
    let title = '';
    let instanceName = '';
    let dateStr = '';
    let sos = '';
    let receivedStr = '';

    const texts = cells.map((c) => cellText(c));

    cells.forEach((cell, i) => {
      const text = texts[i] || '';
      const key = getColClassKey(cell);
      const header =
        (key && map.byKey[key]?.text) ||
        map.byIndex[i]?.text ||
        '';
      const headerLow = header.toLowerCase().replace(/\s+/g, ' ');

      if (
        !title &&
        (headerLow.includes('тема') ||
          headerLow.includes('subject') ||
          headerLow.includes('задач'))
      ) {
        if (text.length > 3) title = text;
      }
      if (
        !instanceName &&
        (headerLow.includes('экземпляр') || headerLow.includes('instance'))
      ) {
        if (text.length > 2) instanceName = text;
      }

      if (headerTextMatchesInstanceCreated(header) && looksLikeDate(text)) {
        dateStr = text;
      }
      if (headerTextMatchesReceived(header) && looksLikeDate(text)) {
        receivedStr = text;
      }
      if (headerTextMatchesSos(header) && text) {
        sos = text;
      }

      // По field из columnDefs
      const field = (key && map.byKey[key]?.field) || map.byIndex[i]?.field || '';
      const f = field.toLowerCase();
      if (!dateStr && (f.includes('creat') || f.includes('instance')) && looksLikeDate(text)) {
        dateStr = text;
      }
      if (!sos && (f === 'sos' || f.includes('sos') || f.includes('схем')) && text) {
        sos = text;
      }
    });

    // Запасной путь: первые колонки (без СОС и дат)
    if (!title && texts.length >= 1) title = texts[0];
    if (!instanceName && texts.length >= 2) {
      const candidate = texts[1];
      if (
        !looksLikeSosValue(candidate) &&
        !looksLikeDate(candidate) &&
        !isTargetTitle(candidate)
      ) {
        instanceName = candidate;
      }
    }
    // Эвристика: тема — первая ячейка с ПРЗ/ФРЗ/ПКМ
    if (!title || !isTargetTitle(title)) {
      const byContent = texts.find((t) => t.length > 5 && isTargetTitle(t));
      if (byContent) title = byContent;
    }
    if (
      !instanceName ||
      looksLikeSosValue(instanceName) ||
      looksLikeDate(instanceName) ||
      isTargetTitle(instanceName)
    ) {
      instanceName = findInstanceNameInTexts(texts);
    }

    // Эвристика: даты и СОС по содержимому ячеек
    if (!dateStr || !sos) {
      const dateByIndex = [];
      for (let i = 0; i < texts.length; i++) {
        if (looksLikeDate(texts[i]) && parsePageDate(texts[i]) != null) {
          dateByIndex.push({ i, text: texts[i] });
        }
        if (!sos && looksLikeSosValue(texts[i])) {
          sos = texts[i];
        }
      }
      // «Дата создания экземпляра» обычно последняя колонка-дата
      if (!dateStr && dateByIndex.length) {
        dateStr = dateByIndex[dateByIndex.length - 1].text;
      }
    }

    if (!dateStr && receivedStr) dateStr = receivedStr;

    return { title, instanceName, dateStr, sos };
  }

  function isTargetTitle(title) {
    const t = (title || '').toLowerCase();
    if (/шаг\s*\d/.test(t)) return false;
    return /(прз|фрз|пкм)/.test(t);
  }

  function isHeaderRow(row) {
    return (
      row.classList.contains('header') ||
      row.classList.contains('heading') ||
      /header|heading/i.test(row.className || '')
    );
  }

  const ROW_SELECTOR = [
    '.taskGridRow',
    '.ng-scope.taskGridRow',
    '[class*="taskGridRow"]',
    '.ui-grid-row',
    '[class*="ui-grid-row"]'
  ].join(', ');

  function readExpectedRowCount() {
    const hay = String(document.body?.innerText || '').slice(0, 16000);
    const rangeMatch = hay.match(/(\d+)\s*[-–]\s*(\d+)\s*(?:of|из)\s*(\d+)/i);
    if (rangeMatch) return parseInt(rangeMatch[3], 10);
    const simpleMatch = hay.match(/(\d+)\s*(?:of|из)\s*(\d+)/i);
    if (simpleMatch) return parseInt(simpleMatch[2], 10);

    // Запасной путь: totalItems из Angular-модели грида
    try {
      if (typeof angular !== 'undefined') {
        let best = 0;
        document
          .querySelectorAll('.ui-grid, [ui-grid], [class*="ui-grid"]')
          .forEach((el) => {
            let scope = angular.element(el).scope();
            for (let d = 0; d < 14 && scope; d += 1) {
              const total =
                scope.gridOptions?.totalItems ??
                scope.gridApi?.grid?.options?.totalItems ??
                scope.gridApi?.pagination?.getTotalItems?.() ??
                scope.gridOptions?.data?.length;
              if (Number.isFinite(total) && total > best) best = total;
              scope = scope.$parent;
            }
          });
        if (best > 0) return best;
      }
    } catch (_) {
      /* ignore */
    }

    return null;
  }

  function findGridScrollTarget() {
    const candidates = new Set();
    for (const sel of [
      '.ui-grid-viewport',
      '.ui-grid-canvas-container',
      '[class*="ui-grid-viewport"]'
    ]) {
      document.querySelectorAll(sel).forEach((el) => {
        if (el.scrollHeight > el.clientHeight + 8) candidates.add(el);
      });
    }

    const sampleRow = document.querySelector(
      '.taskGridRow:not(.header):not(.heading), [class*="taskGridRow"]:not(.header)'
    );
    if (sampleRow) {
      let el = sampleRow.parentElement;
      for (let depth = 0; depth < 14 && el; depth += 1) {
        const oy = getComputedStyle(el).overflowY;
        if (
          (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
          el.scrollHeight > el.clientHeight + 8
        ) {
          candidates.add(el);
        }
        el = el.parentElement;
      }
    }

    const list = Array.from(candidates);
    if (!list.length) return null;

    let best = list[0];
    let bestScore = 0;
    for (const el of list) {
      const rows = el.querySelectorAll(ROW_SELECTOR).length;
      const score = rows * 1000 + el.scrollHeight;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function parseRow(row) {
    if (isHeaderRow(row)) return null;

    const cells = getRowCells(row);
    if (cells.length < 2) return null;

    const { title, instanceName, dateStr, sos } = extractFieldsFromCells(cells);

    if (!isTargetTitle(title)) return null;

    const titleLower = title.toLowerCase();
    if (
      titleLower.includes('отложен') ||
      titleLower.includes('управление отложен')
    ) {
      return null;
    }

    const appearedAt = parsePageDate(dateStr);
    const { client, address } = parseInstanceName(instanceName);
    const safeClient = looksLikeSosValue(client) ? '' : client;
    const key = (title + '|' + instanceName).substring(0, 160);
    if (title.length <= 3) return null;

    return {
      id: key,
      title,
      client: safeClient,
      address,
      instanceName,
      status: '',
      priority: '',
      sos: sos || '',
      date: dateStr || '',
      appearedAt,
      dateSource: dateStr || sos ? 'dom' : '',
      fullText: [title, instanceName, sos, dateStr].join(' ')
    };
  }

  function scanVisibleRows(seen) {
    document.querySelectorAll(ROW_SELECTOR).forEach((row) => {
      const task = parseRow(row);
      if (!task) return;
      if (!seen.has(task.id)) seen.set(task.id, task);
      else seen.set(task.id, mergeTaskRecords(seen.get(task.id), task));
    });
  }

  async function scanWithHorizontalReveal(seen) {
    const viewports = document.querySelectorAll(
      '.ui-grid-viewport, [class*="ui-grid-viewport"]'
    );
    scanVisibleRows(seen);
    for (const vp of viewports) {
      if (vp.scrollWidth <= vp.clientWidth + 12) continue;
      const saved = vp.scrollLeft;
      vp.scrollLeft = 0;
      await sleep(100);
      scanVisibleRows(seen);
      vp.scrollLeft = vp.scrollWidth;
      await sleep(140);
      scanVisibleRows(seen);
      vp.scrollLeft = saved;
    }
  }

  function pickField(obj, keys) {
    for (const key of keys) {
      const val = obj[key];
      if (val != null && String(val).trim()) return String(val).trim();
    }
    return '';
  }

  function flattenStrings(obj, out, depth) {
    if (!obj || depth > 5) return;
    if (typeof obj === 'string') {
      out.push(obj);
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) flattenStrings(item, out, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      for (const val of Object.values(obj)) flattenStrings(val, out, depth + 1);
    }
  }

  function objectToTask(raw) {
    const row = raw?.entity || raw;
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

    let title = pickField(row, [
      'taskSubject',
      'task_subject',
      'TAD_DISPLAY_NAME',
      'subject',
      'title',
      'stepName',
      'name',
      'displayName',
      'taskName'
    ]);

    if (!title) {
      const strings = [];
      flattenStrings(row, strings, 0);
      title = strings.find((s) => s.length > 5 && isTargetTitle(s)) || '';
    }
    if (!isTargetTitle(title)) return null;

    const titleLower = title.toLowerCase();
    if (
      titleLower.includes('отложен') ||
      titleLower.includes('управление отложен')
    ) {
      return null;
    }

    const instanceName = pickField(row, [
      'instanceName',
      'instance_name',
      'PI_NAME',
      'processInstanceName',
      'instance',
      'piName',
      'processSubject'
    ]);
    const status = pickField(row, [
      'status',
      'taskStatus',
      'TASK_STATUS',
      'state',
      'statusName'
    ]);
    const priority = pickField(row, ['priority', 'priorityName']);
    const sos = pickField(row, [
      'sos',
      'SOS',
      'Sos',
      'схемаПодключения',
      'схема_подключения',
      'connectionScheme',
      'schemeOfConnection',
      'soc',
      'SOC',
      'connectionType',
      'mediaType',
      'technology',
      'TECHNOLOGY',
      'sosName',
      'sosValue'
    ]);

    const statusLower = status.toLowerCase();
    if (
      statusLower.includes('отложен') ||
      statusLower.includes('завершен') ||
      statusLower.includes('закрыт') ||
      statusLower.includes('выполнен') ||
      statusLower.includes('отказ')
    ) {
      return null;
    }

    const { client, address } = parseInstanceName(instanceName);
    const safeClient = looksLikeSosValue(client) ? '' : client;
    const key = (title + '|' + instanceName).substring(0, 160);

    return {
      id: key,
      title,
      client: safeClient,
      address,
      instanceName,
      status,
      priority,
      sos,
      date: '',
      appearedAt: null,
      dateSource: 'model',
      fullText: [title, instanceName, status, sos].join(' ')
    };
  }

  function absorbTaskArray(arr, seen) {
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 500) return 0;
    let added = 0;
    for (const item of arr) {
      const task = objectToTask(item);
      if (!task) continue;
      if (!seen.has(task.id)) {
        seen.set(task.id, task);
        added += 1;
      } else {
        seen.set(task.id, mergeTaskRecords(seen.get(task.id), task));
      }
    }
    return added;
  }

  function collectFromGridModel() {
    const seen = new Map();

    try {
      if (typeof angular !== 'undefined') {
        document
          .querySelectorAll('.ui-grid, [ui-grid], [class*="ui-grid"], .taskGrid')
          .forEach((el) => {
            let scope = angular.element(el).scope();
            for (let depth = 0; depth < 22 && scope; depth += 1) {
              absorbTaskArray(scope.gridOptions?.data, seen);
              absorbTaskArray(
                scope.gridApi?.grid?.rows?.map((r) => r.entity),
                seen
              );
              absorbTaskArray(scope.taskList, seen);
              absorbTaskArray(scope.tasks, seen);
              absorbTaskArray(scope.rows, seen);
              absorbTaskArray(scope.data, seen);
              scope = scope.$parent;
            }
          });

        document
          .querySelectorAll('[ng-controller], [data-ng-controller], .ng-scope')
          .forEach((el) => {
            let scope = angular.element(el).scope();
            for (let depth = 0; depth < 18 && scope; depth += 1) {
              for (const key of Object.keys(scope)) {
                if (key.startsWith('$')) continue;
                absorbTaskArray(scope[key], seen);
              }
              scope = scope.$parent;
            }
          });
      }
    } catch (_) {
      /* ignore */
    }

    return Array.from(seen.values());
  }

  function pickMergedText(preferred, fallback, { rejectScheme = false, requireStep = false } = {}) {
    const a = String(preferred || '').trim();
    const b = String(fallback || '').trim();
    const ok = (value) => {
      if (!value) return false;
      if (rejectScheme && looksLikeSosValue(value)) return false;
      if (requireStep && !isTargetTitle(value)) return false;
      return true;
    };
    const aOk = ok(a);
    const bOk = ok(b);
    if (aOk && !bOk) return a;
    if (bOk && !aOk) return b;
    if (!aOk && !bOk) return '';
    return b.length > a.length ? b : a;
  }

  function mergeTaskRecords(into, from) {
    if (!from) return into;
    if (!into) return { ...from };

    const merged = {
      ...into,
      ...from,
      id: into.id || from.id,
      title: pickMergedText(into.title, from.title, { requireStep: true }),
      instanceName: pickMergedText(into.instanceName, from.instanceName, {
        rejectScheme: true
      }),
      client: pickMergedText(into.client, from.client, { rejectScheme: true }),
      address: pickMergedText(into.address, from.address)
    };

    // DOM с датой/СОС важнее model без них
    const intoDom = into.dateSource === 'dom';
    const fromDom = from.dateSource === 'dom';

    if (fromDom && from.date) {
      merged.date = from.date;
      merged.appearedAt = from.appearedAt ?? into.appearedAt;
      merged.dateSource = 'dom';
    } else if (intoDom && into.date) {
      merged.date = into.date;
      merged.appearedAt = into.appearedAt ?? from.appearedAt;
      merged.dateSource = 'dom';
    } else {
      merged.date = into.date || from.date || '';
      merged.appearedAt = into.appearedAt ?? from.appearedAt ?? null;
      merged.dateSource = into.dateSource || from.dateSource || '';
    }

    merged.sos = (fromDom && from.sos) || (intoDom && into.sos) || from.sos || into.sos || '';

    return merged;
  }

  function nudgeGridRender(viewport) {
    if (!viewport) return;
    viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
    try {
      if (typeof angular !== 'undefined') {
        angular.element(viewport).scope()?.$applyAsync?.();
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function collectGridTasks() {
    const hidden = document.hidden;
    const stepDelay = hidden ? 320 : 150;
    const settleDelay = hidden ? 420 : 180;
    const seen = new Map();
    const viewport = findGridScrollTarget();
    await scanWithHorizontalReveal(seen);

    if (viewport && viewport.scrollHeight > viewport.clientHeight + 8) {
      const savedTop = viewport.scrollTop;
      const expected = readExpectedRowCount();
      const step = Math.max(
        48,
        Math.floor(viewport.clientHeight * (hidden ? 0.55 : 0.72))
      );
      let idleRounds = 0;

      viewport.scrollTop = 0;
      nudgeGridRender(viewport);
      await sleep(settleDelay);
      await scanWithHorizontalReveal(seen);

      while (idleRounds < 4) {
        const prevCount = seen.size;
        viewport.scrollTop = Math.min(
          viewport.scrollTop + step,
          viewport.scrollHeight
        );
        nudgeGridRender(viewport);
        await sleep(stepDelay);
        await scanWithHorizontalReveal(seen);

        if (expected && seen.size >= expected) break;
        if (seen.size === prevCount) idleRounds += 1;
        else idleRounds = 0;

        if (
          viewport.scrollTop + viewport.clientHeight >=
          viewport.scrollHeight - 4
        ) {
          await sleep(stepDelay);
          await scanWithHorizontalReveal(seen);
          break;
        }
      }

      viewport.scrollTop = viewport.scrollHeight;
      nudgeGridRender(viewport);
      await sleep(settleDelay);
      await scanWithHorizontalReveal(seen);
      viewport.scrollTop = savedTop;
    }

    return Array.from(seen.values());
  }

  function collectTableFallback(seenIds) {
    const out = [];
    const table = document.querySelector('table');
    if (!table) return out;

    table.querySelectorAll('tbody tr').forEach((row) => {
      const text = row.textContent?.trim() || '';
      if (text.length <= 20) return;
      if (
        !text.includes('Подключение') &&
        !text.includes('расчет') &&
        !text.includes('координация')
      ) {
        return;
      }
      if (text.toLowerCase().includes('отложен')) return;

      const dateStr = extractDateFromText(text);
      const key = text.substring(0, 100);
      if (seenIds.has(key)) return;
      seenIds.add(key);
      out.push({
        id: key,
        title: text.substring(0, 150),
        client: '',
        address: '',
        instanceName: '',
        status: '',
        date: dateStr || '',
        fullText: text
      });
    });

    return out;
  }

  function looksLikeRefreshControl(el) {
    if (!el || el.disabled) return false;
    const label = [
      el.getAttribute('title'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-original-title'),
      el.getAttribute('tooltip'),
      el.className,
      el.id,
      cellText(el)
    ]
      .join(' ')
      .toLowerCase();
    if (!label.trim()) return false;
    return (
      /обнов|refresh|reload|перезагруз|синхрон|sync/.test(label) &&
      !/настрой|setting|фильтр|filter|сортир|sort|экспорт|export/.test(label)
    );
  }

  function clickRefreshControls() {
    const selectors = [
      'button',
      'a',
      '[role="button"]',
      '.btn',
      '[class*="refresh"]',
      '[class*="Reload"]',
      '[class*="reload"]',
      '[title*="бнов"]',
      '[aria-label*="бнов"]',
      '[title*="efresh" i]',
      '[aria-label*="efresh" i]'
    ];
    const candidates = [];
    document.querySelectorAll(selectors.join(', ')).forEach((el) => {
      if (looksLikeRefreshControl(el)) candidates.push(el);
    });

    let clicked = 0;
    for (const el of candidates.slice(0, 4)) {
      try {
        el.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, view: window })
        );
        clicked += 1;
      } catch (_) {
        try {
          el.click();
          clicked += 1;
        } catch (_) {
          /* ignore */
        }
      }
    }
    return clicked;
  }

  function looksLikeSearchInput(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    const type = String(el.type || 'text').toLowerCase();
    if (type && type !== 'text' && type !== 'search') return false;

    const hint = [
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.id,
      el.className
    ]
      .join(' ')
      .toLowerCase();

    return (
      /поиск|search|filter|найти|введите\s+текст/.test(hint) ||
      hint.includes('searchbox') ||
      hint.includes('search-input')
    );
  }

  function findDashboardSearchInput() {
    const inputs = Array.from(
      document.querySelectorAll(
        'input[type="text"], input[type="search"], input:not([type]), textarea'
      )
    ).filter(looksLikeSearchInput);

    if (!inputs.length) return null;

    // Предпочитаем видимое поле рядом с гридом задач
    const scored = inputs.map((el) => {
      const rect = el.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const nearGrid = Boolean(
        el.closest('.ui-grid, .taskGrid, [class*="dashboard"], [class*="task"]') ||
          document.querySelector('.taskGridRow, .ui-grid-row')
      );
      const ph = String(el.getAttribute('placeholder') || '').toLowerCase();
      let score = 0;
      if (visible) score += 5;
      if (nearGrid) score += 3;
      if (/введите\s+текст\s+поиска|текст\s+поиска/.test(ph)) score += 10;
      if (/поиск|search/.test(ph)) score += 4;
      return { el, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.el || null;
  }

  /**
   * Enter в поле «Введите текст поиска» (даже пустом) — soft-reload дашборда BPM.
   * Без input.focus() и без form submit: иначе Chromium шлёт
   * «Окно … ожидает» на неактивном окне.
   */
  function triggerSearchEnterRefresh() {
    const input = findDashboardSearchInput();
    if (!input) return false;

    try {
      const opts = {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        view: window
      };
      // Синтетика без фокуса — достаточно для Angular ng-keydown/ng-keypress
      input.dispatchEvent(new KeyboardEvent('keydown', opts));
      input.dispatchEvent(new KeyboardEvent('keypress', opts));
      input.dispatchEvent(new KeyboardEvent('keyup', opts));

      try {
        if (typeof angular !== 'undefined') {
          const $el = angular.element(input);
          $el.triggerHandler?.('keydown', {
            keyCode: 13,
            which: 13,
            key: 'Enter',
            preventDefault() {},
            stopPropagation() {}
          });
          $el.triggerHandler?.('keypress', {
            keyCode: 13,
            which: 13,
            key: 'Enter',
            preventDefault() {},
            stopPropagation() {}
          });
          $el.triggerHandler?.('keyup', {
            keyCode: 13,
            which: 13,
            key: 'Enter',
            preventDefault() {},
            stopPropagation() {}
          });
          const scope = $el.scope?.() || $el.isolateScope?.();
          // Типичные обработчики поиска BPM
          if (typeof scope?.search === 'function') {
            try {
              scope.search();
            } catch (_) {
              /* ignore */
            }
          }
          if (typeof scope?.onSearch === 'function') {
            try {
              scope.onSearch();
            } catch (_) {
              /* ignore */
            }
          }
          if (typeof scope?.doSearch === 'function') {
            try {
              scope.doSearch();
            } catch (_) {
              /* ignore */
            }
          }
          scope?.$applyAsync?.();
        }
      } catch (_) {
        /* ignore */
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  function callScopeRefreshMethods() {
    if (typeof angular === 'undefined') return 0;
    let called = 0;
    // Только явные refresh* — не search/getTasks/reload (ломают фильтры и навигацию BPM)
    const methodNames = [
      'refresh',
      'refreshData',
      'refreshGrid',
      'refreshTasks',
      'refreshList',
      'reloadData',
      'reloadList',
      'onRefresh'
    ];

    const seen = new WeakSet();
    const tryCall = (fn, ctx) => {
      if (typeof fn !== 'function' || called >= 6) return;
      try {
        fn.call(ctx);
        called += 1;
      } catch (_) {
        /* ignore */
      }
    };

    // Только грид задач — не все .ng-scope на портале
    document
      .querySelectorAll('.ui-grid, [ui-grid], [class*="ui-grid"], .taskGrid')
      .forEach((el) => {
        let scope;
        try {
          scope = angular.element(el).scope();
        } catch (_) {
          return;
        }
        for (let depth = 0; depth < 12 && scope; depth += 1) {
          if (seen.has(scope)) {
            scope = scope.$parent;
            continue;
          }
          seen.add(scope);

          for (const name of methodNames) {
            if (typeof scope[name] === 'function') tryCall(scope[name], scope);
          }

          try {
            const api = scope.gridApi;
            if (api?.core?.refresh) tryCall(api.core.refresh, api.core);
          } catch (_) {
            /* ignore */
          }

          scope = scope.$parent;
        }
      });

    return called;
  }

  function wakePageVisibilityHooks() {
    // Не шлём window.focus / visibilitychange — на фоне Chromium
    // показывает «Окно … ожидает». Достаточно лёгкого mousemove.
    try {
      document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 })
      );
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Мягкое обновление списка BPM без location.reload.
   * 1) Enter в поле поиска (даже пустом) — основной путь на реальном дашборде
   * 2) кнопка «Обновить» / Angular refresh* — запасной
   */
  async function softRefreshDashboard(force = false) {
    const now = Date.now();
    const last = globalThis.__bpmLastSoftRefreshAt || 0;
    if (!force && now - last < 12000) {
      return { skipped: true, clicked: 0, called: 0, searchEnter: false, waitMs: 0 };
    }
    globalThis.__bpmLastSoftRefreshAt = now;

    wakePageVisibilityHooks();

    const searchEnter = triggerSearchEnterRefresh();
    let clicked = 0;
    let called = 0;
    // Если Enter в поиске сработал — ждём дольше (дашборд перерисует грид)
    // иначе пробуем кнопки / Angular refresh
    if (!searchEnter) {
      clicked = clickRefreshControls();
      called = callScopeRefreshMethods();
    }

    const acted = searchEnter || clicked > 0 || called > 0;
    const waitMs = document.hidden
      ? acted
        ? searchEnter
          ? 2600
          : 2000
        : 800
      : acted
        ? searchEnter
          ? 1800
          : 1200
        : 350;
    await sleep(waitMs);
    return { clicked, called, searchEnter, waitMs, skipped: false };
  }

  async function collectAllTasks(options = {}) {
    columnMapCache = undefined;

    // Soft-refresh только если страница скрыта или явно запрошен force
    // (активный дашборд пользователя не дёргаем — конфликт с работой в BPM)
    let soft = { skipped: true, clicked: 0, called: 0, waitMs: 0 };
    const wantSoft =
      options.forceSoftRefresh === true ||
      (options.skipSoftRefresh !== true && document.hidden);
    if (wantSoft) {
      soft = await softRefreshDashboard(Boolean(options.forceSoftRefresh));
    }

    const pagerTotal = readExpectedRowCount();

    // Model — полный список; DOM — точные дата и СОС
    const modelTasks = collectFromGridModel();
    const domTasks = await collectGridTasks();
    const seen = new Map();

    const softOk = soft && soft.skipped === false && ((soft.clicked || 0) + (soft.called || 0) > 0);
    // После успешного soft-refresh DOM/page — источник членства.
    // Иначе model-only «призраки» остаются после отработки заявки.
    const preferDomMembership =
      softOk ||
      (pagerTotal &&
        domTasks.length > 0 &&
        domTasks.length >= Math.min(pagerTotal, 30) * 0.85);

    if (preferDomMembership && domTasks.length) {
      for (const task of domTasks) {
        seen.set(task.id, { ...task });
      }
      for (const task of modelTasks) {
        if (!seen.has(task.id)) continue;
        seen.set(task.id, mergeTaskRecords(seen.get(task.id), task));
      }
    } else {
      for (const task of modelTasks) {
        seen.set(task.id, { ...task });
      }
      for (const task of domTasks) {
        seen.set(task.id, mergeTaskRecords(seen.get(task.id), task));
      }
    }

    let tasks = Array.from(seen.values());

    if (!tasks.length) {
      const seenIds = new Set();
      tasks.push(...collectTableFallback(seenIds));
    }

    const effectivePager =
      pagerTotal ||
      readExpectedRowCount() ||
      (modelTasks.length > tasks.length ? modelTasks.length : null);

    return {
      tasks,
      pagerTotal: effectivePager,
      hidden: document.hidden,
      source: domTasks.length ? 'dom' : modelTasks.length ? 'model' : 'none',
      modelCount: modelTasks.length,
      domCount: domTasks.length,
      softRefresh: soft
    };
  }

  globalThis.__bpmCollectTasks = collectAllTasks;
  globalThis.__bpmSoftRefreshDashboard = softRefreshDashboard;
})();
