// Content script — парсинг задач только на workplace.ertelecom.ru
// Никуда вовне данные не уходят, только в background этого расширения.

const ext = globalThis.browser ?? globalThis.chrome;

console.log('🚀 BPM Monitor V2 content script');

function parseDate(dateStr) {
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
    const day = parseInt(rusMatch[1], 10);
    const monthName = rusMatch[2].toLowerCase().substring(0, 3);
    const month = months[monthName];
    const year = parseInt(rusMatch[3], 10);
    const hours = parseInt(rusMatch[4], 10);
    const minutes = parseInt(rusMatch[5], 10);
    const seconds = parseInt(rusMatch[6], 10);

    if (month !== undefined && !isNaN(year) && !isNaN(day)) {
      return new Date(year, month, day, hours || 0, minutes || 0, seconds || 0);
    }
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
    );
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
    );
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

function isOlderThan10Months(dateStr) {
  if (!dateStr) return false;
  const taskDate = parseDate(dateStr);
  if (!taskDate) return false;

  const now = new Date();
  const diffMonths =
    (now.getFullYear() - taskDate.getFullYear()) * 12 +
    (now.getMonth() - taskDate.getMonth());

  if (diffMonths < 0) return false;
  return diffMonths > 10;
}

function parseInstanceName(raw) {
  const text = (raw || '').trim();
  if (!text) return { client: '', address: '' };

  const conn = text.match(
    /^Подключение\s+[\"«`'“](.+?)[\"»`'”]\s+по\s+ТЭО/i
  );
  if (conn) {
    return { client: conn[1].trim(), address: '' };
  }

  let cleaned = text
    .replace(/\s*\[[\d]+\]\s*$/, '')
    .replace(/\s+(RIAS|KRUS)-[\w.-]+\s*$/i, '')
    .trim();

  const orgRe =
    /(ООО|ОАО|АО|ПАО|ЗАО|ИП|Общество|ОБЩЕСТВО|АКЦИОНЕРН|ПУБЛИЧН|ГОСУДАРСТВЕНН)/i;
  const addressRe =
    /(Санкт-Петербург|СПб|Ленинградск|Москва|МО\b|г\.|город\b|ул\.|улица|пр-кт|проспект|\bпр\.|ш\.|шоссе|пер\.|переулок|наб\.|бул\.|б-р|д\.|дом\b|корп\.?|стр\.|лит\.|обл\.|область|район|р-н|пос[её]лок|пгт|микрорайон|мкр\.?)/i;

  const clientQuoted = cleaned.match(
    /^((?:ООО|ОАО|АО|ПАО|ЗАО|ИП)\s*[«"'“”'].+?[»"'“”']|(?:Общество|ОБЩЕСТВО|Акционерн\w*|Публичн\w*|Государственн\w*)[\s\S]*?[«"'“”'].+?[»"'“”'])/i
  );

  let client = '';
  let address = '';

  if (clientQuoted) {
    client = clientQuoted[1].trim();
    address = cleaned
      .slice(clientQuoted[0].length)
      .replace(/^[\s.,;:—–\-]+/, '')
      .trim();
  } else {
    let parts = cleaned
      .split(/\.\s+/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length < 2) {
      const alt = cleaned
        .split(/\s*[|—–]\s*|\s+\/\s+/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (alt.length >= 2) parts = alt;
    }

    if (parts.length >= 2) {
      const orgIdx = parts.findIndex((p) => orgRe.test(p));
      if (orgIdx >= 0) {
        client = parts[orgIdx];
        const rest = parts.filter((_, i) => i !== orgIdx);
        const addrPart = rest.find((p) => addressRe.test(p));
        address = (addrPart || rest.join('. ')).trim();
      } else if (addressRe.test(parts[0])) {
        address = parts[0];
        client = parts.slice(1).join('. ');
      } else {
        client = parts[0];
        address = parts.slice(1).join('. ');
      }
    } else {
      const m = cleaned.match(addressRe);
      if (m && m.index > 8) {
        client = cleaned
          .slice(0, m.index)
          .replace(/[\s.,;:—–\-]+$/, '')
          .trim();
        address = cleaned.slice(m.index).trim();
      } else {
        client = cleaned;
      }
    }
  }

  if (address && address.toLowerCase() === client.toLowerCase()) {
    address = '';
  }
  if (address && !addressRe.test(address) && address.length < 12) {
    address = '';
  }

  return {
    client: client.replace(/\.+$/, '').trim(),
    address: address.replace(/\.+$/, '').trim()
  };
}

function getRowCells(row) {
  const uiCells = row.querySelectorAll('.ui-grid-cell');
  if (uiCells.length) return Array.from(uiCells);

  const bindings = row.querySelectorAll('.ng-binding');
  if (bindings.length) return Array.from(bindings);

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

function looksLikeOrg(s) {
  return /(ООО|ОАО|АО|ПАО|ЗАО|ИП|Общество|ОБЩЕСТВО|Акционерн|АКЦИОНЕРН)/i.test(
    s || ''
  );
}

function looksLikeAddress(s) {
  return /(Санкт-Петербург|СПб|Ленинградск|Москва|г\.|ул\.|улица|пр-кт|проспект|ш\.|шоссе|пер\.|наб\.|,\s*\d+\s*\/\s*\d)/i.test(
    s || ''
  );
}

function findTasks() {
  const tasks = [];
  const seen = new Set();

  const rows = document.querySelectorAll(
    [
      '.taskGridRow',
      '.ng-scope.taskGridRow',
      '[class*="taskGridRow"]',
      '.ui-grid-row',
      '[class*="ui-grid-row"]'
    ].join(', ')
  );

  rows.forEach((row) => {
    if (
      row.classList.contains('header') ||
      row.classList.contains('heading') ||
      /header|heading/i.test(row.className || '')
    ) {
      return;
    }

    const cells = getRowCells(row);
    const cellText = (el) => (el?.innerText || el?.textContent || '').trim();
    const texts = cells.map(cellText).map((t) => t.trim()).filter(Boolean);

    let title = '';
    let instanceName = '';
    let client = '';
    let address = '';
    let status = '';
    let priority = '';
    let dateStr = '';

    const dedicated = isDedicatedDashboard();

    // Тема | Клиент | Адрес | Услуга | Дата | [id]
    if (dedicated && texts.length >= 2) {
      title = texts[0] || '';
      client = texts.find(looksLikeOrg) || texts[1] || '';
      address =
        texts.find((t) => t !== client && looksLikeAddress(t)) ||
        (texts[2] && texts[2] !== client ? texts[2] : '') ||
        '';
      dateStr = texts.find(looksLikeDate) || '';
      priority =
        texts.find(
          (t) =>
            t !== title &&
            t !== client &&
            t !== address &&
            t !== dateStr &&
            !/^\d{4,}$/.test(t)
        ) || '';
      instanceName = [client, address].filter(Boolean).join('. ');
    } else if (cells.length >= 5) {
      title = cellText(cells[0]);
      instanceName = cellText(cells[1]);
      status = cellText(cells[2]);
      priority = cellText(cells[3]);
      dateStr = cellText(cells[4]);
      const parsed = parseInstanceName(instanceName);
      client = parsed.client;
      address = parsed.address;
    } else if (cells.length >= 4) {
      title = cellText(cells[0]);
      instanceName = cellText(cells[1]);
      status = cellText(cells[2]);
      dateStr = cellText(cells[3]);
      const parsed = parseInstanceName(instanceName);
      client = parsed.client;
      address = parsed.address;
    } else if (cells.length >= 2) {
      title = cellText(cells[0]);
      instanceName = cellText(cells[1]);
      const parsed = parseInstanceName(instanceName);
      client = parsed.client;
      address = parsed.address;
    }

    const titleLower = (title || '').toLowerCase();
    if (!dedicated) {
      if (/шаг\s*\d/.test(titleLower)) return;
      if (!/(прз|фрз|пкм)/.test(titleLower)) return;
    } else if (title.length <= 2) {
      return;
    }

    if (
      titleLower.includes('отложен') ||
      titleLower.includes('управление отложен')
    ) {
      return;
    }

    const statusLower = status.toLowerCase();
    if (
      statusLower.includes('отложен') ||
      statusLower.includes('завершен') ||
      statusLower.includes('закрыт') ||
      statusLower.includes('выполнен') ||
      statusLower.includes('отказ')
    ) {
      return;
    }

    const pageDate = parseDate(dateStr);
    const appearedAt = pageDate ? pageDate.getTime() : null;

    const key = (title + '|' + client + '|' + address).substring(0, 180);
    if (!seen.has(key) && title.length > 2) {
      seen.add(key);
      tasks.push({
        id: key,
        title,
        client,
        address,
        instanceName: instanceName || [client, address].filter(Boolean).join('. '),
        status,
        priority,
        date: dateStr,
        appearedAt,
        fullText: [title, client, address, priority, dateStr].join(' ')
      });
    }
  });

  return tasks;
}

function dashboardFamilyFromHref(href) {
  const candidates = [href || '', location.href || ''];
  try {
    candidates.push(window.top?.location?.href || '');
  } catch (_) {
    /* cross-origin iframe */
  }
  for (const h of candidates) {
    if (/\/SYSRP\/4002\b/i.test(h)) return 'prz';
    if (/\/SYSRP\/4003\b/i.test(h)) return 'frz';
    if (/\/SYSRP\/4004\b/i.test(h)) return 'pkm';
  }
  return null;
}

function isDedicatedDashboard() {
  return dashboardFamilyFromHref() != null;
}

function tagTasks(tasks) {
  const family = dashboardFamilyFromHref();
  if (!family) return tasks;
  return tasks.map((t) => ({
    ...t,
    _family: family,
    _dashboardKey: family,
    id: t.id || `${family}|${t.title}|${t.instanceName || t.client || ''}`
  }));
}

function pushTasksToBackground(tasks) {
  if (!tasks.length) return;
  ext.runtime.sendMessage({ action: 'newTasks', tasks: tagTasks(tasks) }, () => {
    void ext.runtime.lastError;
  });
}

ext.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getTasks' || request.action === 'manualCheck') {
    const tasks = tagTasks(findTasks());
    console.log(`📤 V2alt: найдено задач в фрейме: ${tasks.length}`, location.href);

    // Сообщаем в background отдельно: tabs.sendMessage принимает ответ только от одного фрейма,
    // а грид BPM часто внутри iframe.
    ext.runtime.sendMessage(
      { action: 'frameTasks', tasks, href: location.href },
      () => {
        void ext.runtime.lastError;
      }
    );

    sendResponse({ status: 'ok', tasks, href: location.href });
    return true;
  }
  return false;
});

// Если пользователь сам держит страницу открытой — лёгкий локальный опрос
setTimeout(() => {
  const tasks = findTasks();
  if (tasks.length) pushTasksToBackground(tasks);
}, 4000);

setInterval(() => {
  const tasks = findTasks();
  if (tasks.length) pushTasksToBackground(tasks);
}, 60000);

console.log('✅ Content V2 готов:', location.href);
