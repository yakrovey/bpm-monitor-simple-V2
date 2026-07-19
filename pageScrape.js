/**
 * Инжектируемая функция (без внешних зависимостей).
 * Вызывается через chrome.scripting.executeScript.
 * opts.requireStepKeywords=false — режим отдельных дашбордов 4002/4003/4004
 * (берём активные строки таблицы, тип задаёт background по URL дашборда).
 */
export function pageFindTasks(opts) {
  const requireStepKeywords = !(opts && opts.requireStepKeywords === false);
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

    // Юрлицо в кавычках → всё после кавычек считаем адресом
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
    // Если «адрес» на самом деле кусок названия без адресных признаков — не показываем
    if (address && !addressRe.test(address) && address.length < 12) {
      address = '';
    }

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
    if (!requireStepKeywords) {
      return Boolean((title || '').trim().length > 2);
    }
    const t = (title || '').toLowerCase();
    if (/шаг\s*\d/.test(t)) return false;
    return /(прз|фрз|пкм)/.test(t);
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
    const texts = cells.map(cellText).map((t) => t.trim()).filter(Boolean);

    let title = '';
    let instanceName = '';
    let client = '';
    let address = '';
    let status = '';
    let priority = '';
    let dateStr = '';

    // Отдельные дашборды 4002/4003/4004:
    // Тема | Клиент | Адрес | Услуга | Дата | [id]
    if (!requireStepKeywords && texts.length >= 4) {
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
      if (!client && !address) {
        const parsed = parseInstanceName(texts[1] || '');
        client = parsed.client;
        address = parsed.address;
        instanceName = texts[1] || '';
      }
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
