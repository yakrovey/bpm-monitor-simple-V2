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

  // Подключение "КЛИЕНТ" по ТЭО N
  const conn = text.match(
    /^Подключение\s+[\"«`'“](.+?)[\"»`'”]\s+по\s+ТЭО/i
  );
  if (conn) {
    return { client: conn[1].trim(), address: '' };
  }

  // Убираем хвост RIAS/KRUS/[id]
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

  // Если порядок «клиент. адрес» или наоборот не распознали
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

  if (!client && !address) client = cleaned;

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

function findTasks() {
  const tasks = [];
  const seen = new Set();

  const rows = document.querySelectorAll(
    '.taskGridRow, .ng-scope.taskGridRow, [class*="taskGridRow"]'
  );

  rows.forEach((row) => {
    if (row.classList.contains('header') || row.classList.contains('heading')) {
      return;
    }

    const cells = getRowCells(row);
    const cellText = (el) => (el?.innerText || el?.textContent || '').trim();

    let title = '';
    let instanceName = '';
    let status = '';
    let priority = '';
    let dateStr = '';

    if (cells.length >= 5) {
      title = cellText(cells[0]);
      instanceName = cellText(cells[1]);
      status = cellText(cells[2]);
      priority = cellText(cells[3]);
      dateStr = cellText(cells[4]);
    } else if (cells.length >= 4) {
      title = cellText(cells[0]);
      instanceName = cellText(cells[1]);
      status = cellText(cells[2]);
      dateStr = cellText(cells[3]);
    } else if (cells.length >= 2) {
      title = cellText(cells[0]);
      instanceName = cellText(cells[1]);
    }

    // Только ПРЗ / ФРЗ / ПКМ; «Шаг 1.2/3.1/5.1» отбрасываем
    const titleLower = (title || '').toLowerCase();
    if (/шаг\s*\d/.test(titleLower)) return;
    if (!/(прз|фрз|пкм)/.test(titleLower)) return;

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

    const { client, address } = parseInstanceName(instanceName);
    const pageDate = parseDate(dateStr);
    const appearedAt = pageDate ? pageDate.getTime() : null;

    const key = (title + '|' + instanceName).substring(0, 160);
    if (!seen.has(key) && title.length > 3) {
      seen.add(key);
      tasks.push({
        id: key,
        title,
        client,
        address,
        instanceName,
        status,
        priority,
        date: dateStr,
        appearedAt,
        fullText: [title, instanceName, status, dateStr].join(' ')
      });
    }
  });

  if (tasks.length === 0) {
    const table = document.querySelector('table');
    if (table) {
      table.querySelectorAll('tbody tr').forEach((row) => {
        const text = row.textContent?.trim() || '';
        if (
          text.length > 20 &&
          (text.includes('Подключение') ||
            text.includes('расчет') ||
            text.includes('координация'))
        ) {
          if (text.toLowerCase().includes('отложен')) return;

          const dateStr = extractDateFromText(text);
          // Срок выполнения не используем как фильтр возраста

          const key = text.substring(0, 100);
          if (!seen.has(key)) {
            seen.add(key);
            tasks.push({
              id: key,
              title: text.substring(0, 150),
              client: '',
              address: '',
              instanceName: '',
              status: '',
              date: dateStr || '',
              fullText: text
            });
          }
        }
      });
    }
  }

  return tasks;
}

function pushTasksToBackground(tasks) {
  if (!tasks.length) return;
  ext.runtime.sendMessage({ action: 'newTasks', tasks }, () => {
    void ext.runtime.lastError;
  });
}

ext.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getTasks' || request.action === 'manualCheck') {
    const tasks = findTasks();
    console.log(`📤 V2: найдено задач в фрейме: ${tasks.length}`, location.href);

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
