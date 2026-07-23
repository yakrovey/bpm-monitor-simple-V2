import {
  businessMsBetween,
  formatBusinessDuration,
  hours,
  hoursMinutes,
  isWorkTime,
  parseRussianDateTime
} from './businessTime.js';

/** Цвета с читаемым чёрным текстом */
export const ZONE_COLORS = {
  green: '#c8e6c9',
  yellow: '#fff59d',
  red: '#ef9a9a',
  overdue: '#90caf9',
  vols: '#ffffff',
  montage: '#eceff1',
  paused: null
};

export function getStepFamily(type) {
  if (!type) return null;
  if (
    type.includes('Монтаж') ||
    type.includes('НКУ КРУС') ||
    type.includes('НМУ КРУС')
  ) {
    return 'montage';
  }
  // Старые сохранённые «ПКМ: Подключение» до переклассификации
  if (type.includes('ПКМ') && type.includes('Подключен')) {
    return 'montage';
  }
  if (type.includes('ПРЗ')) return 'prz';
  if (type.includes('ФРЗ')) return 'frz';
  if (type.includes('ПКМ')) return 'pkm';
  return null;
}

export function supportsSchemeSwitch(type) {
  const family = getStepFamily(type);
  return family === 'frz' || family === 'pkm';
}

/**
 * СОС (схема подключения) со страницы → схема таймеров.
 * P2P / P2MP / ДРОП → radio; ВОЛС → vols; медный кабель → default (схема 1).
 * null — распознать не удалось.
 */
export function schemeFromSos(sosText) {
  const raw = String(sosText || '').trim();
  if (!raw) return null;
  const t = raw.toLowerCase().replace(/\s+/g, ' ');

  // Радиосеть: P2P / P2MP / ДРОП (одна линейка таймеров)
  if (/\bp2mp\b|\bp2p\b|p2mp|p2p/i.test(raw)) return 'radio';
  if (/\bдроп\b|\bdrop\b/i.test(t) || t.includes('дроп')) return 'radio';

  // ВОЛС
  if (
    t.includes('волс') ||
    t.includes('vols') ||
    t.includes('оптоволок') ||
    t.includes('fiber')
  ) {
    return 'vols';
  }

  // Схема 1 — медный кабель
  if (
    t.includes('медн') ||
    t.includes('медь') ||
    t.includes('кабел') ||
    t.includes('copper') ||
    /\bcu\b/i.test(raw) ||
    t.includes('схема 1') ||
    t.includes('сх.1') ||
    t.includes('сх 1')
  ) {
    return 'default';
  }
  return null;
}

/** Короткая метка СОС/схемы — не имя клиента и не экземпляр. */
export function looksLikeSchemeLabel(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 80) return false;
  if (schemeFromSos(raw)) return true;
  return /^(волс|медь|медный|copper|cu|radio|радио|p2p|p2mp|дроп|drop)$/i.test(
    raw
  );
}

function zoneByRanges(elapsed, ranges) {
  for (const range of ranges) {
    if (elapsed < range.until) {
      return { zone: range.zone, color: ZONE_COLORS[range.zone] };
    }
  }
  return { zone: 'overdue', color: ZONE_COLORS.overdue };
}

/**
 * Правила порогов. until — верхняя граница зоны (не включая overdue).
 * milestones — разовые уведомления при достижении порога (бизнес-время, кроме vols).
 * danger — повторяющиеся в красной «опасной» зоне.
 */
export function getSchemeConfig(family, scheme) {
  if (family === 'montage' || (scheme === 'montage' && family === 'pkm')) {
    return {
      mode: 'montage',
      ranges: [{ until: Infinity, zone: 'montage' }],
      milestones: [],
      danger: null,
      overdueAfter: null,
      volsIntervalMs: null
    };
  }

  if (scheme === 'vols' && family === 'pkm') {
    return {
      mode: 'vols',
      ranges: [{ until: Infinity, zone: 'vols' }],
      milestones: [],
      danger: null,
      overdueAfter: null,
      volsIntervalMs: null // ПКМ ВОЛС: без уведомлений
    };
  }

  if (scheme === 'vols' && family === 'frz') {
    return {
      mode: 'vols',
      ranges: [{ until: Infinity, zone: 'vols' }],
      milestones: [],
      danger: null,
      overdueAfter: null,
      volsIntervalMs: 48 * hours(1)
    };
  }

  if (family === 'prz') {
    return {
      mode: 'business',
      ranges: [
        { until: hours(5), zone: 'green' },
        { until: hours(7), zone: 'yellow' },
        { until: hours(9), zone: 'red' }
      ],
      milestones: [
        {
          id: 'prz_5h',
          at: hours(5),
          text: 'прошло 5 часов, посмотри задачу'
        },
        {
          id: 'prz_7h',
          at: hours(7),
          text: 'время подходит к концу, срочно отработай задачу'
        }
      ],
      // 8ч30–8ч45: каждые 5 мин; 8ч45–8ч59: каждые 2 мин; с 9ч — просрок
      danger: {
        from: hoursMinutes(8, 30),
        mid: hoursMinutes(8, 45),
        until: hoursMinutes(8, 59),
        text: 'СРОЧНО ОТРАБОТАЙ ЗАЯВКУ',
        textAfterMid: 'УГРОЗА ПРОСРОКА',
        intervalBeforeMid: 5 * 60 * 1000,
        intervalAfterMid: 2 * 60 * 1000
      },
      overdueAfter: hours(9),
      overdueText: 'ВСЁ РАССЛАБЬСЯ, ТЫ ПРОСРОЧИЛ ЭТУ ЗАЯВКУ'
    };
  }

  if (family === 'frz' && scheme === 'radio') {
    return {
      mode: 'business',
      ranges: [
        { until: hours(8), zone: 'green' },
        { until: hours(20), zone: 'yellow' },
        { until: hoursMinutes(26, 59), zone: 'red' }
      ],
      milestones: [
        {
          id: 'frz_radio_8h',
          at: hours(8),
          text: 'займись заявкой, проконтролируй ТО, если требуется'
        },
        {
          id: 'frz_radio_20h',
          at: hours(20),
          text: 'ОСТАЛОСЬ 6 ЧАСОВ ДО ПРОСРОКА'
        }
      ],
      danger: {
        from: hoursMinutes(26, 30),
        mid: hoursMinutes(26, 50),
        until: hoursMinutes(26, 59),
        text: 'ОПАСНОСТЬ ПРОСРОКА',
        intervalBeforeMid: 5 * 60 * 1000,
        intervalAfterMid: 2 * 60 * 1000
      },
      overdueAfter: hoursMinutes(26, 59),
      overdueText: 'ВСЁ РАССЛАБЬСЯ, ТЫ ПРОСРОЧИЛ ЭТУ ЗАЯВКУ'
    };
  }

  if (family === 'frz') {
    // default
    return {
      mode: 'business',
      ranges: [
        { until: hours(8), zone: 'green' },
        { until: hours(12), zone: 'yellow' },
        { until: hoursMinutes(15, 59), zone: 'red' }
      ],
      milestones: [
        {
          id: 'frz_8h',
          at: hours(8),
          text: 'прошло 8 часов, посмотри заявку'
        },
        {
          id: 'frz_12h',
          at: hours(12),
          text: 'СРОЧНО ОТРАБОТАЙ ЗАЯВКУ'
        }
      ],
      danger: {
        from: hoursMinutes(15, 30),
        mid: hoursMinutes(15, 50),
        until: hoursMinutes(15, 59),
        text: 'ОПАСНОСТЬ ПРОСРОКА',
        intervalBeforeMid: 5 * 60 * 1000,
        intervalAfterMid: 2 * 60 * 1000
      },
      overdueAfter: hoursMinutes(15, 59),
      overdueText: 'ВСЁ РАССЛАБЬСЯ, ТЫ ПРОСРОЧИЛ ЭТУ ЗАЯВКУ'
    };
  }

  if (family === 'pkm' && scheme === 'radio') {
    return {
      mode: 'business',
      ranges: [
        { until: hours(6), zone: 'green' },
        { until: hours(10), zone: 'yellow' },
        { until: hoursMinutes(13, 59), zone: 'red' }
      ],
      milestones: [
        {
          id: 'pkm_radio_6h',
          at: hours(6),
          text: 'прошло 6 часов с момента появления заявки на 5.1 не забудь о ней'
        },
        {
          id: 'pkm_radio_10h',
          at: hours(10),
          text: 'СРОЧНО ВЫДАЙ ЗАЯВКУ В РАБОТУ!'
        }
      ],
      danger: {
        from: hoursMinutes(13, 45),
        mid: hoursMinutes(13, 45),
        until: hoursMinutes(13, 59),
        text: 'ОПАСНОСТЬ ПРОСРОКА',
        intervalBeforeMid: 2 * 60 * 1000,
        intervalAfterMid: 2 * 60 * 1000
      },
      overdueAfter: hoursMinutes(13, 59),
      overdueText: 'ВСЁ РАССЛАБЬСЯ, ТЫ ПРОСРОЧИЛ ЭТУ ЗАЯВКУ'
    };
  }

  if (family === 'pkm') {
    return {
      mode: 'business',
      ranges: [
        { until: hours(2), zone: 'green' },
        { until: hours(3), zone: 'yellow' },
        { until: hours(4), zone: 'red' }
      ],
      milestones: [
        {
          id: 'pkm_appear',
          at: 0,
          text: 'на 5.1 новая заявка',
          onlyOnAppear: true
        },
        {
          id: 'pkm_2h',
          at: hours(2),
          text: 'заявка на 5.1 уже 2 часа'
        },
        {
          id: 'pkm_3h',
          at: hours(3),
          text: 'на 5.1 ДО ПРОСРОКА ЗАЯВКИ 1 ЧАС'
        }
      ],
      danger: null,
      overdueAfter: hours(4),
      overdueText: 'ВСЁ РАССЛАБЬСЯ, ТЫ ПРОСРОЧИЛ ЭТУ ЗАЯВКУ'
    };
  }

  return {
    mode: 'business',
    ranges: [{ until: Infinity, zone: 'green' }],
    milestones: [],
    danger: null,
    overdueAfter: null
  };
}

export function buildNotifyBody(task, text) {
  const lines = [text];
  const client = (task.client || '').trim();
  const address = (task.address || '').trim();
  const title = (task.title || '').trim();

  if (client) lines.push(`Клиент: ${client}`);
  if (address) lines.push(`Адрес: ${address}`);
  else if (title) lines.push(`Задача: ${title}`);

  return lines.join('\n');
}

/** Единый источник старта таймера: дата со страницы → appearedAt → now. */
export function resolveAppearedAtForTimer(task, now = Date.now()) {
  const scheme = task?.scheme || 'default';
  if (scheme === 'vols' || scheme === 'montage') {
    return task.schemeChangedAt || task.appearedAt || now;
  }
  if (task?.date) {
    const fromPage = parseRussianDateTime(task.date);
    if (fromPage != null) return fromPage;
  }
  if (task?.appearedAt && Number.isFinite(Number(task.appearedAt))) {
    return Number(task.appearedAt);
  }
  return now;
}

/**
 * Синхронизация appearedAt с датой страницы и корректировка notified.
 * При смене даты старые пороги помечаются без уведомления.
 */
export function reconcileNotifiedThresholds(task, now = Date.now()) {
  const family = getStepFamily(task.type);
  const scheme = task.scheme || 'default';
  const config = getSchemeConfig(family, scheme);
  const appearedAt = resolveAppearedAtForTimer(task, now);
  const prevAppearedAt = task.appearedAt;
  const appearedAtChanged =
    prevAppearedAt != null &&
    Math.abs(prevAppearedAt - appearedAt) > 60 * 1000;

  if (config.mode === 'vols' || config.mode === 'montage') {
    return { ...task, appearedAt, lastElapsedMs: task.lastElapsedMs ?? 0 };
  }

  const elapsed = businessMsBetween(appearedAt, now);
  const notified = new Set(task.notified || []);

  for (const milestone of config.milestones || []) {
    if (milestone.onlyOnAppear) continue;
    if (elapsed < milestone.at) {
      notified.delete(milestone.id);
    } else if (appearedAtChanged) {
      notified.add(milestone.id);
    }
  }
  if (config.overdueAfter != null) {
    if (elapsed < config.overdueAfter) notified.delete('overdue');
    else if (appearedAtChanged) notified.add('overdue');
  }

  return {
    ...task,
    appearedAt,
    notified: Array.from(notified),
    lastElapsedMs: appearedAtChanged ? elapsed : task.lastElapsedMs
  };
}

export function evaluateTimer(task, now = Date.now()) {
  const family = getStepFamily(task.type);
  const scheme = task.scheme || 'default';
  const config = getSchemeConfig(family, scheme);
  const workingNow = isWorkTime(new Date(now));

  if (config.mode === 'vols' || config.mode === 'montage') {
    const since = task.schemeChangedAt || task.appearedAt || now;
    const wallElapsed = Math.max(0, now - since);
    const isMontage = config.mode === 'montage';
    return {
      family,
      scheme,
      mode: config.mode,
      zone: isMontage ? 'montage' : 'vols',
      color: isMontage ? ZONE_COLORS.montage : ZONE_COLORS.vols,
      elapsedMs: 0,
      wallElapsedMs: wallElapsed,
      elapsedLabel: isMontage ? 'Монтаж · таймер выкл' : 'ВОЛС · таймер выкл',
      workingNow,
      paused: true,
      config,
      supportsSchemeSwitch: supportsSchemeSwitch(task.type)
    };
  }

  const appearedAt = resolveAppearedAtForTimer(task, now);
  const elapsedMs = businessMsBetween(appearedAt, now);
  let { zone, color } = zoneByRanges(elapsedMs, config.ranges);

  if (
    config.overdueAfter != null &&
    elapsedMs >= config.overdueAfter
  ) {
    zone = 'overdue';
    color = ZONE_COLORS.overdue;
  }

  return {
    family,
    scheme,
    mode: 'business',
    zone,
    color,
    elapsedMs,
    wallElapsedMs: Math.max(0, now - appearedAt),
    elapsedLabel: formatBusinessDuration(elapsedMs),
    workingNow,
    paused: !workingNow,
    config,
    supportsSchemeSwitch: supportsSchemeSwitch(task.type)
  };
}

/**
 * Какие уведомления нужно отправить сейчас (с учётом уже отправленных).
 * allowNotify=false: только пересчёт зоны/таймера, без due и без пометки notified.
 */
export function collectDueNotifications(
  task,
  timerState,
  now = Date.now(),
  { allowNotify = true } = {}
) {
  const evalResult = evaluateTimer(task, now);
  const config = evalResult.config;
  const notified = new Set(timerState.notified || []);
  const due = [];
  let lastDangerAt = timerState.lastDangerAt || 0;
  let lastVolsNotifyAt = timerState.lastVolsNotifyAt || 0;

  const patchBase = {
    zone: evalResult.zone,
    color: evalResult.color,
    elapsedMs: evalResult.elapsedMs,
    elapsedLabel: evalResult.elapsedLabel,
    paused: evalResult.paused,
    workingNow: evalResult.workingNow,
    lastElapsedMs: evalResult.elapsedMs
  };

  if (!allowNotify) {
    return {
      due: [],
      timerPatch: {
        notified: Array.from(notified),
        lastDangerAt,
        lastVolsNotifyAt,
        ...patchBase
      },
      evalResult
    };
  }

  if (config.mode === 'vols' || config.mode === 'montage') {
    const since = task.schemeChangedAt || task.appearedAt || now;
    if (!config.volsIntervalMs) {
      return {
        due: [],
        timerPatch: {
          notified: Array.from(notified),
          lastDangerAt,
          lastVolsNotifyAt,
          ...patchBase
        },
        evalResult
      };
    }
    const base = lastVolsNotifyAt || since;
    if (now - base >= config.volsIntervalMs) {
      const id = `vols_${Math.floor((now - since) / config.volsIntervalMs)}`;
      if (!notified.has(id)) {
        due.push({
          key: id,
          title: `${task.type} · ВОЛС`,
          message: buildNotifyBody(task, 'проверь, что там с заявкой')
        });
        notified.add(id);
        lastVolsNotifyAt = now;
      }
    }

    return {
      due,
      timerPatch: {
        notified: Array.from(notified),
        lastDangerAt,
        lastVolsNotifyAt,
        ...patchBase
      },
      evalResult
    };
  }

  const elapsed = evalResult.elapsedMs;
  const prevElapsed =
    task.lastElapsedMs != null && Number.isFinite(task.lastElapsedMs)
      ? task.lastElapsedMs
      : null;

  for (const milestone of config.milestones || []) {
    if (milestone.onlyOnAppear) continue;
    if (elapsed < milestone.at) continue;
    if (notified.has(milestone.id)) continue;

    if (prevElapsed != null && prevElapsed < milestone.at) {
      due.push({
        key: milestone.id,
        title: task.type,
        message: buildNotifyBody(task, milestone.text)
      });
    }
    notified.add(milestone.id);
  }

  if (
    config.overdueAfter != null &&
    elapsed >= config.overdueAfter &&
    !notified.has('overdue')
  ) {
    if (prevElapsed != null && prevElapsed < config.overdueAfter) {
      due.push({
        key: 'overdue',
        title: task.type,
        message: buildNotifyBody(task, config.overdueText)
      });
    }
    notified.add('overdue');
  }

  if (config.danger && elapsed >= config.danger.from && elapsed < config.danger.until) {
    const afterMid = elapsed >= config.danger.mid;
    const interval = afterMid
      ? config.danger.intervalAfterMid
      : config.danger.intervalBeforeMid;
    const dangerText = afterMid
      ? config.danger.textAfterMid || config.danger.text
      : config.danger.textBeforeMid || config.danger.text;
    if (!lastDangerAt || now - lastDangerAt >= interval) {
      const dangerKey = `danger_${Math.floor(elapsed / interval)}`;
      due.push({
        key: dangerKey,
        title: task.type,
        message: buildNotifyBody(task, dangerText)
      });
      lastDangerAt = now;
    }
  }

  return {
    due,
    timerPatch: {
      notified: Array.from(notified),
      lastDangerAt,
      lastVolsNotifyAt,
      ...patchBase
    },
    evalResult
  };
}

export function appearNotificationFor(task) {
  const family = getStepFamily(task.type);
  const scheme = task.scheme || 'default';
  if (family === 'montage' || scheme === 'vols' || scheme === 'montage') return null;

  if (family === 'pkm' && scheme === 'default') {
    return {
      key: 'pkm_appear',
      title: task.type,
      message: buildNotifyBody(task, 'на 5.1 новая заявка')
    };
  }

  // Для ПРЗ/ФРЗ — базовое уведомление о новой задаче
  return {
    key: 'appear',
    title: task.type,
    message: buildNotifyBody(
      task,
      `Новая задача: ${task.title || 'без названия'}`
    )
  };
}
