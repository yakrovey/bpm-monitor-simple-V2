/**
 * Инжектируемая функция (без внешних зависимостей).
 * Вызывается через chrome.scripting.executeScript.
 * Только темы ПРЗ / ФРЗ / ПКМ; время старта — из колонки срока на странице.
 */
export function pageFindTasks() {
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

    if (!client && !address) client = cleaned;

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
      const day = parseInt(rusMatch[1], 10);
      const month = months[rusMatch[2].toLowerCase().substring(0, 3)];
      const year = parseInt(rusMatch[3], 10);
      if (month === undefined) return null;
      return new Date(
        year,
        month,
        day,
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

  function cellText(el) {
    return (el?.innerText || el?.textContent || '').trim();
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

  function isTargetTitle(title) {
    const t = (title || '').toLowerCase();
    if (/шаг\s*\d/.test(t)) return false;
    return /(прз|фрз|пкм)/.test(t);
  }

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

    if (!isTargetTitle(title)) return;

    const titleLower = title.toLowerCase();
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

    const appearedAt = parsePageDate(dateStr);
    const { client, address } = parseInstanceName(instanceName);
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

  return tasks;
}
