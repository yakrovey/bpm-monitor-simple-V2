import {
  appearNotificationFor,
  collectDueNotifications,
  evaluateTimer,
  getSchemeConfig,
  getStepFamily,
  supportsSchemeSwitch
} from './timerEngine.js';
import { isWorkTime, parseRussianDateTime } from './businessTime.js';
import { pageFindTasks } from './pageScrape.js';
import { ext } from './extApi.js';

// BPM Monitor V2alt — фон + рабочие таймеры
// Источники: отдельные дашборды ПРЗ / ФРЗ / ПКМ (не «Работа»).
// Данные только локально: ext.storage.local + workplace.ertelecom.ru

const DASHBOARDS = [
  {
    key: 'prz',
    family: 'prz',
    label: 'ПРЗ',
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/4002',
    match: '/SYSRP/4002'
  },
  {
    key: 'frz',
    family: 'frz',
    label: 'ФРЗ',
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/4003',
    match: '/SYSRP/4003'
  },
  {
    key: 'pkm',
    family: 'pkm',
    label: 'ПКМ',
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/4004',
    match: '/SYSRP/4004'
  }
];

const ALARM_NAME = 'bpmCheck';
const WARM_ALARM_NAME = 'bpmWarmEnd';
const CHECK_PERIOD_MINUTES = 1;
const WARMUP_MS = 60 * 1000;
const MONITOR_TABS_STORAGE_KEY = 'monitorTabIds';
const LOGIN_NOTIFY_TEXT = 'ПОХОЖЕ, ВХОД В BPMS НЕ ВЫПОЛНЕН';
const DASHBOARD_ID_RE = /\/SYSRP\/(400[234])(?:\/|$|\?|#)/i;

/** idle | warming | running | paused */
let runMode = 'idle';
let warmUntil = 0;

let ensureTabsInFlight = null;

let knownIds = new Set();
let activeTasks = [];
/** id / fp:… → выбранная схема (живёт дольше, чем activeTasks при сбое скрапа). */
let schemeMemory = {};
/** family → подряд пустых «уверенных» снимков; id → сколько раз не было в успешном скрапе семьи. */
let missStreaks = { family: {}, task: {} };
let bootstrapped = false;
let lastCheckAt = null;
let lastError = null;
let lastCheckMessage = null;
let monitorStatus = 'idle';
/** Пользовательский переключатель всплывающих уведомлений (по умолчанию включены). */
let notificationsEnabled = true;

const ABSENT_DROP_AFTER = 3;
const FAMILY_EMPTY_DROP_AFTER = 3;

async function loadState() {
  const data = await ext.storage.local.get([
    'knownIds',
    'activeTasks',
    'bootstrapped',
    'lastCheckAt',
    'lastError',
    'lastCheckMessage',
    'monitorStatus',
    'runMode',
    'warmUntil',
    'notificationsEnabled',
    'schemeMemory',
    'missStreaks'
  ]);

  knownIds = new Set(data.knownIds || []);
  activeTasks = data.activeTasks || [];
  bootstrapped = Boolean(data.bootstrapped);
  lastCheckAt = data.lastCheckAt || null;
  lastError = data.lastError || null;
  lastCheckMessage = data.lastCheckMessage || null;
  monitorStatus = data.monitorStatus || 'idle';
  runMode = data.runMode || 'idle';
  warmUntil = Number(data.warmUntil || 0);
  notificationsEnabled = data.notificationsEnabled !== false;
  schemeMemory = data.schemeMemory && typeof data.schemeMemory === 'object'
    ? data.schemeMemory
    : {};
  missStreaks =
    data.missStreaks && typeof data.missStreaks === 'object'
      ? {
          family: data.missStreaks.family || {},
          task: data.missStreaks.task || {}
        }
      : { family: {}, task: {} };
}

async function saveState(extra = {}) {
  await ext.storage.local.set({
    knownIds: Array.from(knownIds),
    activeTasks,
    bootstrapped,
    lastCheckAt,
    lastError,
    lastCheckMessage,
    monitorStatus,
    runMode,
    warmUntil,
    notificationsEnabled,
    schemeMemory,
    missStreaks,
    ...extra
  });
}

/** Строгий id дашборда из URL: 4002 | 4003 | 4004. */
function extractDashboardId(url) {
  const s = String(url || '');
  const m = s.match(DASHBOARD_ID_RE);
  if (m) return m[1];
  if (/\/SYSRP\/4002\b/i.test(s)) return '4002';
  if (/\/SYSRP\/4003\b/i.test(s)) return '4003';
  if (/\/SYSRP\/4004\b/i.test(s)) return '4004';
  return null;
}

function keyFromDashboardId(id) {
  if (id === '4002') return 'prz';
  if (id === '4003') return 'frz';
  if (id === '4004') return 'pkm';
  return null;
}

function dashboardIdFor(dash) {
  return extractDashboardId(dash.url) || dash.match.replace('/SYSRP/', '');
}

function getTaskType(title) {
  const text = (title || '').toLowerCase();

  if (
    text.includes('отложен') ||
    text.includes('завершен') ||
    text.includes('закрыт') ||
    text.includes('выполнен') ||
    text.includes('отказ')
  ) {
    return null;
  }

  // На общем дашборде игнор «Шаг 1.2…»; на отдельных досках тип задаёт classifyFromDashboard.
  if (/шаг\s*\d/.test(text)) return null;
  if (!/(прз|фрз|пкм)/.test(text)) return null;

  if (text.includes('пкм')) {
    if (text.includes('подключен')) return 'ПКМ: Подключение';
    return 'ПКМ: Координация';
  }

  if (text.includes('фрз') || text.includes('финальн')) {
    return 'ФРЗ: Финальный расчет';
  }

  if (text.includes('прз')) {
    if (text.includes('валидация') || text.includes('validation')) {
      return 'ПРЗ: Валидация';
    }
    return 'ПРЗ: Предварительный расчет';
  }

  return null;
}

function isInactiveRaw(raw) {
  const text = `${raw.title || ''} ${raw.status || ''}`.toLowerCase();
  return (
    text.includes('отложен') ||
    text.includes('завершен') ||
    text.includes('закрыт') ||
    text.includes('выполнен') ||
    text.includes('отказ') ||
    text.includes('управление отложен')
  );
}

/** Тип задачи с учётом дашборда-источника (4002/4003/4004). */
function classifyFromDashboard(raw) {
  if (isInactiveRaw(raw)) return null;

  const family = raw._family;
  const title = (raw.title || '').toLowerCase();

  // На отдельных досках тип задаёт дашборд — текст темы не отсекает строку
  if (family === 'prz') {
    if (title.includes('валидация') || title.includes('validation')) {
      return 'ПРЗ: Валидация';
    }
    return 'ПРЗ: Предварительный расчет';
  }
  if (family === 'frz') return 'ФРЗ: Финальный расчет';
  if (family === 'pkm') {
    if (title.includes('подключен')) return 'ПКМ: Подключение';
    return 'ПКМ: Координация';
  }

  return getTaskType(raw.title);
}

function createNotification(title, message, opts = {}) {
  if (!notificationsEnabled && !opts.force) return;

  const notifId = opts.id || `bpm-alt-${Date.now()}`;
  try {
    ext.action?.setBadgeText?.({ text: '!' });
    ext.action?.setBadgeBackgroundColor?.({ color: '#d32f2f' });
  } catch (_) {
    /* ignore */
  }
  ext.notifications.create(
    notifId,
    {
      type: 'basic',
      iconUrl: 'icon.png',
      title: title || 'Монитор BPM',
      message: message || '',
      priority: 2,
      silent: false,
      requireInteraction: Boolean(opts.requireInteraction)
    },
    () => {
      if (ext.runtime.lastError) {
        console.warn('notification error:', ext.runtime.lastError.message);
      }
    }
  );
}

function enrichTaskView(task, now = Date.now()) {
  const evalResult = evaluateTimer(task, now);
  return {
    ...task,
    zone: evalResult.zone,
    color: evalResult.color,
    elapsedMs: evalResult.elapsedMs,
    elapsedLabel: evalResult.elapsedLabel,
    paused: evalResult.paused,
    workingNow: evalResult.workingNow,
    supportsSchemeSwitch: evalResult.supportsSchemeSwitch,
    scheme: task.scheme || 'default'
  };
}

function applyTimerNotifications(task, now = Date.now()) {
  const allowNotify = isWorkTime(new Date(now));
  let next = { ...task };

  // Отложенное «появилась задача», если пришла вне рабочего времени
  if (next.pendingAppear && allowNotify) {
    createNotification(next.pendingAppear.title, next.pendingAppear.message);
    const notified = new Set(next.notified || []);
    notified.add(next.pendingAppear.key);
    next.notified = Array.from(notified);
    next.pendingAppear = null;
  }

  const timerState = {
    notified: next.notified || [],
    lastDangerAt: next.lastDangerAt || 0,
    lastVolsNotifyAt: next.lastVolsNotifyAt || 0
  };

  // Статус/цвет/таймер — всегда; due непустой только в рабочее время
  const { due, timerPatch } = collectDueNotifications(next, timerState, now, {
    allowNotify
  });

  for (const item of due) {
    createNotification(item.title, item.message);
  }

  return {
    ...next,
    ...timerPatch,
    pendingAppear: next.pendingAppear || null
  };
}

function resolveAppearedAt(incoming, prev, now) {
  // Время со страницы (колонка срока) — источник истины мастер-системы
  if (incoming.appearedAt && Number.isFinite(Number(incoming.appearedAt))) {
    return Number(incoming.appearedAt);
  }
  if (incoming.date) {
    const fromPage = parseRussianDateTime(incoming.date);
    if (fromPage != null) return fromPage;
  }
  if (prev?.appearedAt) return prev.appearedAt;
  return now;
}

function taskFingerprint(task) {
  const family =
    getStepFamily(task.type) ||
    task._family ||
    task._dashboardKey ||
    '';
  const norm = (v) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .slice(0, 100);
  return [
    family,
    norm(task.client),
    norm(task.address),
    norm(task.title)
  ].join('|');
}

function rememberScheme(task) {
  if (!task?.id) return;
  const scheme = task.scheme || 'default';
  const entry = {
    id: task.id,
    scheme,
    schemeChangedAt: task.schemeChangedAt || null,
    fingerprint: taskFingerprint(task),
    notified: Array.isArray(task.notified) ? [...task.notified] : [],
    lastDangerAt: task.lastDangerAt || 0,
    lastVolsNotifyAt: task.lastVolsNotifyAt || 0,
    appearedAt: task.appearedAt || null,
    savedAt: Date.now()
  };
  schemeMemory[task.id] = entry;
  if (entry.fingerprint) {
    schemeMemory[`fp:${entry.fingerprint}`] = { ...entry };
  }
  // Не раздуваем storage
  const ids = Object.keys(schemeMemory).filter((k) => !k.startsWith('fp:'));
  if (ids.length > 400) {
    ids
      .map((id) => ({ id, t: schemeMemory[id]?.savedAt || 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(0, ids.length - 400)
      .forEach(({ id }) => {
        const fp = schemeMemory[id]?.fingerprint;
        delete schemeMemory[id];
        if (fp) delete schemeMemory[`fp:${fp}`];
      });
  }
}

function recallScheme(incoming) {
  if (!incoming) return null;
  if (incoming.id && schemeMemory[incoming.id]) return schemeMemory[incoming.id];
  const fp = taskFingerprint(incoming);
  if (fp && schemeMemory[`fp:${fp}`]) return schemeMemory[`fp:${fp}`];
  return null;
}

function applyRecalledScheme(task, recalled) {
  if (!recalled || !task) return task;
  const scheme = recalled.scheme || 'default';
  if (scheme === 'default' && !recalled.schemeChangedAt) return task;
  return {
    ...task,
    scheme,
    schemeChangedAt: recalled.schemeChangedAt || task.schemeChangedAt || null,
    notified:
      Array.isArray(recalled.notified) && recalled.notified.length
        ? recalled.notified
        : task.notified || [],
    lastDangerAt: recalled.lastDangerAt || task.lastDangerAt || 0,
    lastVolsNotifyAt: recalled.lastVolsNotifyAt || task.lastVolsNotifyAt || 0,
    appearedAt: task.appearedAt || recalled.appearedAt || null
  };
}

function mergeExisting(prev, incoming, now) {
  const merged = {
    ...incoming,
    id: prev.id,
    type: incoming.type || prev.type,
    appearedAt: resolveAppearedAt(incoming, prev, now),
    scheme: prev.scheme || 'default',
    schemeChangedAt: prev.schemeChangedAt || null,
    notified: prev.notified || [],
    lastDangerAt: prev.lastDangerAt || 0,
    lastVolsNotifyAt: prev.lastVolsNotifyAt || 0,
    pendingAppear: prev.pendingAppear || null
  };
  // Если схема была только в memory (после обнуления списка) — подхватить
  if (
    (!merged.scheme || merged.scheme === 'default') &&
    !merged.schemeChangedAt
  ) {
    return applyRecalledScheme(merged, recallScheme(merged));
  }
  return merged;
}

function seedPastThresholds(task, now) {
  // При первом появлении в расширении не спамим уже прошедшие пороги.
  // «ВСЁ РАССЛАБЬСЯ…» уйдёт только когда заявка СТАНЕТ синей уже под мониторингом.
  const family = getStepFamily(task.type);
  const scheme = task.scheme || 'default';
  const config = getSchemeConfig(family, scheme);
  const evalResult = evaluateTimer(task, now);
  const notified = new Set(task.notified || []);
  let lastDangerAt = task.lastDangerAt || 0;

  if (config.mode === 'vols') {
    return {
      ...task,
      notified: Array.from(notified),
      lastDangerAt,
      zone: evalResult.zone,
      color: evalResult.color,
      elapsedMs: evalResult.elapsedMs,
      elapsedLabel: evalResult.elapsedLabel
    };
  }

  const elapsed = evalResult.elapsedMs;
  for (const milestone of config.milestones || []) {
    if (milestone.onlyOnAppear) continue;
    if (elapsed >= milestone.at) notified.add(milestone.id);
  }
  if (config.overdueAfter != null && elapsed >= config.overdueAfter) {
    notified.add('overdue');
  }
  if (config.danger && elapsed >= config.danger.from) {
    lastDangerAt = now;
  }

  return {
    ...task,
    notified: Array.from(notified),
    lastDangerAt,
    zone: evalResult.zone,
    color: evalResult.color,
    elapsedMs: evalResult.elapsedMs,
    elapsedLabel: evalResult.elapsedLabel
  };
}

function createTrackedTask(incoming, now, { notifyAppear }) {
  let task = {
    ...incoming,
    appearedAt: resolveAppearedAt(incoming, null, now),
    scheme: 'default',
    schemeChangedAt: null,
    notified: [],
    lastDangerAt: 0,
    lastVolsNotifyAt: 0,
    pendingAppear: null
  };

  // Восстановить вручную выбранную схему после обнуления списка
  const recalled = recallScheme(incoming);
  task = applyRecalledScheme(task, recalled);
  if (task.appearedAt == null && recalled?.appearedAt) {
    task.appearedAt = recalled.appearedAt;
  }

  // Запоминаем уже прошедшие сроки без уведомлений
  task = seedPastThresholds(task, now);

  if (notifyAppear) {
    const appear = appearNotificationFor(task);
    if (appear && !task.notified.includes(appear.key)) {
      if (isWorkTime(new Date(now))) {
        createNotification(appear.title, appear.message);
        task.notified = [...task.notified, appear.key];
      } else {
        task.pendingAppear = appear;
      }
    }
  }

  // Дальше только новые пороги (в т.ч. переход в синий → «ВСЁ РАССЛАБЬСЯ…»)
  return applyTimerNotifications(task, now);
}

/**
 * Слияние снимка с учётом нестабильного скрапа (особенно ФРЗ):
 * пустой снимок семьи не сразу стирает задачи; схемы хранятся в schemeMemory.
 */
async function processTasks(tasks, opts = {}) {
  const now = Date.now();
  const perDash = Array.isArray(opts.perDash) ? opts.perDash : [];
  const prevById = new Map(activeTasks.map((t) => [t.id, t]));
  const prevByFamily = { prz: [], frz: [], pkm: [] };
  for (const t of activeTasks) {
    const fam = getStepFamily(t.type);
    if (fam && prevByFamily[fam]) prevByFamily[fam].push(t);
  }

  const relevant = [];
  let skippedNoType = 0;

  for (const raw of tasks) {
    const type = classifyFromDashboard(raw);
    if (!type) {
      skippedNoType += 1;
      continue;
    }
    const id = raw.id || `${raw.title}|${raw.instanceName || raw.client || ''}`;
    relevant.push({
      id,
      title: raw.title || '',
      client: raw.client || '',
      address: raw.address || '',
      instanceName: raw.instanceName || '',
      status: raw.status || '',
      priority: raw.priority || '',
      date: raw.date || '',
      appearedAt: raw.appearedAt || null,
      fullText: raw.fullText || '',
      type,
      _family: raw._family || getStepFamily(type),
      _dashboardKey: raw._dashboardKey || raw._family || getStepFamily(type)
    });
  }

  const incomingByFamily = { prz: [], frz: [], pkm: [] };
  for (const t of relevant) {
    const fam = getStepFamily(t.type);
    if (fam && incomingByFamily[fam]) incomingByFamily[fam].push(t);
  }

  lastCheckAt = now;
  lastError = null;

  function upsertFromIncoming(incoming, { notifyAppear }) {
    const prev = prevById.get(incoming.id);
    let task;
    if (prev) {
      task = mergeExisting(prev, incoming, now);
      task = applyTimerNotifications(task, now);
    } else if (!knownIds.has(incoming.id)) {
      knownIds.add(incoming.id);
      task = createTrackedTask(incoming, now, { notifyAppear });
    } else {
      task = createTrackedTask(incoming, now, { notifyAppear: false });
      task.appearedAt = resolveAppearedAt(incoming, null, now);
      task = applyRecalledScheme(task, recallScheme(incoming));
      task = seedPastThresholds(task, now);
      task = applyTimerNotifications(task, now);
    }
    if (task.schemeChangedAt || (task.scheme && task.scheme !== 'default')) {
      rememberScheme(task);
    }
    missStreaks.task[task.id] = 0;
    return enrichTaskView(task, now);
  }

  function dashInfoFor(family) {
    return perDash.find((p) => p.key === family) || null;
  }

  function isConfidentEmpty(family) {
    const info = dashInfoFor(family);
    if (!info || info.missing) return false;
    return info.pageState === 'ready' && Number(info.count || 0) === 0;
  }

  if (!bootstrapped) {
    const next = [];
    for (const incoming of relevant) {
      next.push(upsertFromIncoming(incoming, { notifyAppear: false }));
    }
    activeTasks = next;
    bootstrapped = true;
    monitorStatus = 'monitoring';
    lastCheckMessage = `Первый снимок: ${activeTasks.length} задач ПРЗ/ФРЗ/ПКМ (из ${tasks.length} строк)`;
    await saveState();
    console.log(`🌱 Bootstrap: ${activeTasks.length} задач без уведомлений`);
    return {
      newCount: 0,
      total: activeTasks.length,
      scraped: tasks.length,
      bootstrapped: true,
      message: lastCheckMessage
    };
  }

  let newCount = 0;
  const next = [];
  const keptSoft = [];

  for (const family of ['prz', 'frz', 'pkm']) {
    const incoming = incomingByFamily[family];
    const previous = prevByFamily[family] || [];

    if (incoming.length > 0) {
      missStreaks.family[family] = 0;
      const seenIds = new Set();

      for (const item of incoming) {
        const beforeKnown = knownIds.has(item.id) || prevById.has(item.id);
        const task = upsertFromIncoming(item, { notifyAppear: !beforeKnown });
        if (!beforeKnown) newCount += 1;
        next.push(task);
        seenIds.add(task.id);
      }

      // Задачи семьи, которых нет в успешном скрапе — не сразу удаляем
      for (const prev of previous) {
        if (seenIds.has(prev.id)) continue;
        const streak = (missStreaks.task[prev.id] || 0) + 1;
        missStreaks.task[prev.id] = streak;
        if (streak < ABSENT_DROP_AFTER) {
          const kept = enrichTaskView(
            applyTimerNotifications({ ...prev }, now),
            now
          );
          if (kept.schemeChangedAt || (kept.scheme && kept.scheme !== 'default')) {
            rememberScheme(kept);
          }
          next.push(kept);
          keptSoft.push(family);
        }
        // иначе реально пропала — schemeMemory оставляем
      }
      continue;
    }

    // Пустой снимок семьи
    if (!previous.length) {
      missStreaks.family[family] = 0;
      continue;
    }

    if (isConfidentEmpty(family)) {
      missStreaks.family[family] = (missStreaks.family[family] || 0) + 1;
    } else {
      // Сбой/нестабильный скрап — не считаем пустым
      missStreaks.family[family] = 0;
    }

    const familyStreak = missStreaks.family[family] || 0;
    if (familyStreak < FAMILY_EMPTY_DROP_AFTER) {
      for (const prev of previous) {
        const kept = enrichTaskView(
          applyTimerNotifications({ ...prev }, now),
          now
        );
        if (kept.schemeChangedAt || (kept.scheme && kept.scheme !== 'default')) {
          rememberScheme(kept);
        }
        next.push(kept);
      }
      keptSoft.push(family);
    }
    // иначе очередь семьи пуста уверенно — не добавляем previous
  }

  activeTasks = next;
  monitorStatus = 'monitoring';
  const softNote = keptSoft.length
    ? ` · удержано при пустом снимке: ${[...new Set(keptSoft)].join(',')}`
    : '';
  lastCheckMessage =
    `Обновлено: ${activeTasks.length} активных, новых: ${newCount}, строк с страницы: ${tasks.length}` +
    (skippedNoType ? `, прочих шагов: ${skippedNoType}` : '') +
    softNote +
    (isWorkTime(new Date(now))
      ? ''
      : ' · уведомления на паузе (вне раб. времени)');
  await saveState();
  console.log(`📊 ${lastCheckMessage}`);
  return {
    newCount,
    total: activeTasks.length,
    scraped: tasks.length,
    bootstrapped: false,
    message: lastCheckMessage
  };
}

async function refreshTimersOnly() {
  const now = Date.now();
  activeTasks = activeTasks.map((task) =>
    enrichTaskView(applyTimerNotifications(task, now), now)
  );
  lastCheckAt = now;
  await saveState();
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ext.tabs.onUpdated.removeListener(onUpdated);
      resolve('timeout');
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        ext.tabs.onUpdated.removeListener(onUpdated);
        resolve('complete');
      }
    }

    ext.tabs.get(tabId, (tab) => {
      if (ext.runtime.lastError) {
        clearTimeout(timer);
        resolve('error');
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        resolve('complete');
        return;
      }
      ext.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function getStoredTabIds() {
  const stored = await ext.storage.local.get([MONITOR_TABS_STORAGE_KEY]);
  return stored[MONITOR_TABS_STORAGE_KEY] || {};
}

async function saveStoredTabIds(map) {
  await ext.storage.local.set({ [MONITOR_TABS_STORAGE_KEY]: { ...map } });
}

function tabMatchesDashboard(tab, dash) {
  const href = `${tab?.url || ''} ${tab?.pendingUrl || ''}`;
  const id = extractDashboardId(href);
  return id != null && id === dashboardIdFor(dash);
}

function looksLikeLoginUrl(url) {
  const u = (url || '').toLowerCase();
  return /login|logon|signin|sign-in|auth|sso|cas\b|oidc|oauth|accounts\.|adfs/.test(
    u
  );
}

function isWorkplaceTab(tab) {
  const url = `${tab?.url || ''} ${tab?.pendingUrl || ''}`;
  return /ertelecom\.ru|workplace/i.test(url) || looksLikeLoginUrl(url);
}

async function getTabSafe(tabId) {
  if (tabId == null) return null;
  try {
    return await ext.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function queryAllTabs() {
  try {
    return await ext.tabs.query({});
  } catch (_) {
    return [];
  }
}

async function findTabForDashboard(dash, storedIds, usedIds = new Set()) {
  const saved = await getTabSafe(storedIds[dash.key]);
  // Сохранённую вкладку монитора не бросаем из‑за SPA-URL:
  // BPM часто уводит адрес со /SYSRP/4003, но вкладка всё ещё та же.
  if (
    saved &&
    !usedIds.has(saved.id) &&
    isWorkplaceTab(saved) &&
    !looksLikeLoginUrl(saved.url)
  ) {
    return saved;
  }

  const all = await queryAllTabs();
  return (
    all.find(
      (t) => !usedIds.has(t.id) && tabMatchesDashboard(t, dash)
    ) || null
  );
}

/**
 * Если вкладка уехала с нужного дашборда — вернуть на 4002/4003/4004.
 * Не трогаем login-страницу.
 */
async function repairDashboardTab(dash, tab) {
  if (!tab?.id) return tab;
  if (looksLikeLoginUrl(tab.url)) return tab;
  if (tabMatchesDashboard(tab, dash)) return tab;
  try {
    console.log(`↺ repair tab ${dash.key} → ${dash.url}`);
    return await ext.tabs.update(tab.id, {
      url: dash.url,
      active: false,
      pinned: true
    });
  } catch (err) {
    console.warn('repairDashboardTab failed', dash.key, err);
    return tab;
  }
}

async function claimSpareWorkplaceTab(dash, storedIds, usedIds) {
  const all = await queryAllTabs();
  const taken = new Set(
    Object.values(storedIds)
      .concat([...usedIds])
      .filter((id) => id != null)
  );

  const exact = all.find(
    (t) => tabMatchesDashboard(t, dash) && !taken.has(t.id)
  );
  if (exact) return exact;

  // Не растаскиваем одну login-вкладку на три шага — только точный URL дашборда.
  return null;
}

function forgetTabIdConflicts(storedIds, key, tabId) {
  for (const k of Object.keys(storedIds)) {
    if (k !== key && storedIds[k] === tabId) delete storedIds[k];
  }
  storedIds[key] = tabId;
}

/**
 * ТОЛЬКО поиск существующих вкладок. НИКОГДА не вызывает tabs.create.
 * «Проверить сейчас» сначала вызывает ensureMonitorDashboards, затем collect.
 */
async function collectExistingDashboardTabs() {
  if (ensureTabsInFlight) return ensureTabsInFlight;

  ensureTabsInFlight = (async () => {
    const storedIds = await getStoredTabIds();
    const usedIds = new Set();
    const pairs = [];

    for (const dash of DASHBOARDS) {
      let tab = await findTabForDashboard(dash, storedIds, usedIds);
      if (!tab) {
        tab = await claimSpareWorkplaceTab(dash, storedIds, usedIds);
      }
      if (tab) {
        forgetTabIdConflicts(storedIds, dash.key, tab.id);
        usedIds.add(tab.id);
        pairs.push({ dash, tab });
      } else {
        pairs.push({ dash, tab: null });
      }
    }

    await saveStoredTabIds(storedIds);
    return pairs;
  })();

  try {
    return await ensureTabsInFlight;
  } finally {
    ensureTabsInFlight = null;
  }
}

/**
 * Открыть ровно одну вкладку на дашборд: 4002 / 4003 / 4004.
 * Уже занятые вкладки не переиспользуются под другой шаг.
 */
async function openOneDashboardTab(dash, storedIds, usedIds) {
  let tab = null;
  const saved = await getTabSafe(storedIds[dash.key]);
  if (saved && !usedIds.has(saved.id)) {
    tab = await ext.tabs.update(saved.id, {
      url: dash.url,
      active: false,
      pinned: true
    });
  } else {
    const all = await queryAllTabs();
    const existing = all.find(
      (t) => !usedIds.has(t.id) && tabMatchesDashboard(t, dash)
    );
    if (existing) {
      tab = await ext.tabs.update(existing.id, {
        url: dash.url,
        active: false,
        pinned: true
      });
    } else {
      tab = await ext.tabs.create({
        url: dash.url,
        active: false,
        pinned: true
      });
    }
  }

  if (!tab?.id) {
    throw new Error(`tabs API не вернул вкладку для ${dash.label}`);
  }

  usedIds.add(tab.id);
  forgetTabIdConflicts(storedIds, dash.key, tab.id);
  return tab;
}

/**
 * Открытие 3 дашбордов по «Запустить».
 * Без долгих wait — иначе popup закрывается и SW обрывает создание вкладок.
 */
async function openMonitorDashboards() {
  const storedIds = await getStoredTabIds();
  const usedIds = new Set();
  const opened = [];
  const errors = [];

  for (const dash of DASHBOARDS) {
    try {
      const tab = await openOneDashboardTab(dash, storedIds, usedIds);
      await saveStoredTabIds(storedIds);
      opened.push({
        key: dash.key,
        label: dash.label,
        tabId: tab.id,
        url: dash.url
      });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      console.warn('openMonitorDashboards failed', dash.key, msg);
      errors.push(`${dash.label}: ${msg}`);
    }
  }

  await saveStoredTabIds(storedIds);

  try {
    const firstId = storedIds.prz || opened[0]?.tabId;
    if (firstId != null) {
      await ext.tabs.update(firstId, { active: true });
      const first = await getTabSafe(firstId);
      if (first?.windowId != null) {
        await ext.windows.update(first.windowId, { focused: true });
      }
    }
  } catch (err) {
    console.warn('focus first tab failed', err);
  }

  if (!opened.length) {
    return {
      ok: false,
      opened,
      error: errors.join('; ') || 'Не удалось открыть ни одной вкладки'
    };
  }

  return {
    ok: true,
    opened,
    warning: errors.length ? errors.join('; ') : null
  };
}

/**
 * Для «Проверить сейчас»: если вкладки закрыты — открыть заново;
 * если открыты — ничего не плодить, только закрепить/запомнить.
 */
async function ensureMonitorDashboards() {
  const storedIds = await getStoredTabIds();
  const usedIds = new Set();
  const opened = [];
  let created = 0;
  let reused = 0;
  let repaired = 0;

  for (const dash of DASHBOARDS) {
    let tab = await findTabForDashboard(dash, storedIds, usedIds);
    let wasCreated = false;
    let wasRepaired = false;

    if (tab) {
      try {
        if (!tabMatchesDashboard(tab, dash) || looksLikeLoginUrl(tab.url)) {
          tab = await ext.tabs.update(tab.id, {
            url: dash.url,
            active: false,
            pinned: true
          });
          wasRepaired = true;
          repaired += 1;
        } else {
          tab = await ext.tabs.update(tab.id, {
            pinned: true,
            active: false
          });
        }
      } catch (_) {
        tab = null;
      }
    }

    if (!tab) {
      tab = await openOneDashboardTab(dash, storedIds, usedIds);
      wasCreated = true;
      created += 1;
    } else {
      usedIds.add(tab.id);
      forgetTabIdConflicts(storedIds, dash.key, tab.id);
      reused += 1;
    }

    opened.push({
      key: dash.key,
      label: dash.label,
      tabId: tab.id,
      url: dash.url,
      created: wasCreated,
      repaired: wasRepaired
    });
  }

  await saveStoredTabIds(storedIds);

  // После открытия/ремонта ФРЗ/ПРЗ/ПКМ дать гриду прогрузиться
  if (created > 0 || repaired > 0) {
    await new Promise((r) => setTimeout(r, 3500));
  }

  return {
    ok: true,
    opened,
    created,
    reused,
    repaired,
    message:
      created > 0 || repaired > 0
        ? `Вкладки: новых ${created}, поправлены ${repaired}, на месте ${reused}.`
        : 'Все 3 вкладки на месте.'
  };
}

function dedupeTasks(tasks) {
  const seen = new Set();
  const out = [];
  for (const task of tasks) {
    const id = task.id || `${task.title}|${task.instanceName || task.client || ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ ...task, id });
  }
  return out;
}

async function scrapeViaScripting(tabId) {
  try {
    const results = await ext.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageFindTasks,
      args: [{ requireStepKeywords: false }]
    });
    const merged = [];
    for (const item of results || []) {
      if (Array.isArray(item.result)) merged.push(...item.result);
    }
    return dedupeTasks(merged);
  } catch (err) {
    console.warn('scripting scrape failed:', err);
    return [];
  }
}

function collectTasksFromTab(tabId, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const collected = [];
    const seen = new Set();

    function onMessage(request, sender) {
      if (request?.action !== 'frameTasks') return;
      if (sender.tab?.id !== tabId) return;
      for (const task of request.tasks || []) {
        const id = task.id || `${task.title}|${task.instanceName || task.client || ''}`;
        if (seen.has(id)) continue;
        seen.add(id);
        collected.push(task);
      }
    }

    ext.runtime.onMessage.addListener(onMessage);
    ext.tabs.sendMessage(tabId, { action: 'getTasks' }, () => {
      void ext.runtime.lastError;
    });

    setTimeout(() => {
      ext.runtime.onMessage.removeListener(onMessage);
      resolve(collected);
    }, timeoutMs);
  });
}

async function scrapeOneDashboard(dash, tab) {
  if (!tab?.id) return { tasks: [], pageState: 'unknown' };
  const pageState = await probeTabPageState(tab.id);
  let tasks = await scrapeViaScripting(tab.id);
  if (!tasks.length) {
    tasks = await collectTasksFromTab(tab.id, 2500);
  }
  return {
    pageState,
    tasks: tasks.map((t) => ({
      ...t,
      _family: dash.family,
      _dashboardKey: dash.key,
      id: t.id || `${dash.key}|${t.title}|${t.instanceName || t.client || ''}`
    }))
  };
}

/** login | ready | unknown — по DOM/URL вкладки */
async function probeTabPageState(tabId) {
  try {
    const results = await ext.scripting.executeScript({
      target: { tabId },
      func: () => {
        const href = String(location.href || '');
        const hrefLow = href.toLowerCase();
        const bodyText = String(document.body?.innerText || '')
          .slice(0, 8000)
          .toLowerCase();
        const hasGrid = Boolean(
          document.querySelector(
            '.taskGridRow, .ui-grid, .ui-grid-canvas, [class*="taskGrid"], [class*="Dashboard"]'
          )
        );
        const urlLogin = /\/login|logon|signin|sign-in|\/auth|sso|adfs|oidc/.test(
          hrefLow
        );
        const textLogin =
          /парол|войти в систему|sign in|log in|authenticate|вход в систему|введите логин/.test(
            bodyText
          ) && !hasGrid;
        if (urlLogin || textLogin) return 'login';
        if (hasGrid || /\/dashboards\/sysrp\/400[234]/i.test(href)) return 'ready';
        return 'unknown';
      }
    });
    return results?.[0]?.result || 'unknown';
  } catch (err) {
    console.warn('probeTabPageState failed', err);
    return 'unknown';
  }
}

async function requestTasksFromAllDashboards() {
  const pairs = await collectExistingDashboardTabs();
  const merged = [];
  const perDash = [];
  let loginLike = false;
  let missingTabs = 0;
  let loginTabs = 0;
  let readyTabs = 0;

  for (const { dash, tab } of pairs) {
    if (!tab) {
      missingTabs += 1;
      perDash.push({
        key: dash.key,
        label: dash.label,
        count: 0,
        missing: true,
        pageState: 'missing'
      });
      continue;
    }

    const urlLogin = looksLikeLoginUrl(tab.url);
    const urlMismatch = !tabMatchesDashboard(tab, dash);
    // urlMismatch сам по себе не значит «нет входа» — SPA часто меняет адрес
    if (urlLogin) loginLike = true;

    const { tasks, pageState } = await scrapeOneDashboard(dash, tab);
    if (pageState === 'login' || urlLogin) loginTabs += 1;
    else if (
      pageState === 'ready' ||
      tabMatchesDashboard(tab, dash) ||
      tasks.length > 0
    ) {
      readyTabs += 1;
    }

    perDash.push({
      key: dash.key,
      label: dash.label,
      count: tasks.length,
      pageState,
      urlMismatch
    });
    merged.push(...tasks);
  }

  return {
    tasks: dedupeTasks(merged),
    perDash,
    tabCount: pairs.filter((p) => p.tab).length,
    loginLike,
    missingTabs,
    loginTabs,
    readyTabs
  };
}

const LOGIN_NOTIFY_ID = 'bpm-alt-login-warn';
const LOGIN_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
let lastLoginNotifyAt = 0;

async function notifyLoginMissing() {
  const now = Date.now();
  if (now - lastLoginNotifyAt < LOGIN_NOTIFY_COOLDOWN_MS) {
    return false;
  }
  lastLoginNotifyAt = now;
  createNotification('Монитор BPM V2alt', LOGIN_NOTIFY_TEXT, {
    id: LOGIN_NOTIFY_ID,
    requireInteraction: true
  });
  return true;
}

async function clearLoginNotification() {
  lastLoginNotifyAt = 0;
  try {
    await ext.notifications.clear(LOGIN_NOTIFY_ID);
  } catch (_) {
    /* ignore */
  }
  await clearLoginBadge();
}

async function clearLoginBadge() {
  try {
    ext.action?.setBadgeText?.({ text: '' });
  } catch (_) {
    /* ignore */
  }
}

async function clearAlarms() {
  try {
    await ext.alarms.clear(ALARM_NAME);
    await ext.alarms.clear(WARM_ALARM_NAME);
  } catch (_) {
    /* ignore */
  }
}

/** Сбор только с уже открытых вкладок. tabs.create здесь запрещён. */
async function collectAndApply(reason = 'alarm') {
  console.log(`🔍 collectAndApply (${reason}), mode=${runMode}`);
  try {
    if (activeTasks.length) {
      await refreshTimersOnly();
    }

    const {
      tasks,
      perDash,
      tabCount,
      loginLike,
      missingTabs,
      loginTabs,
      readyTabs
    } = await requestTasksFromAllDashboards();
    const summary = perDash.map((p) => `${p.label}:${p.count}`).join(' · ');
    lastCheckAt = Date.now();

    if (tasks.length) {
      runMode = 'running';
      monitorStatus = 'monitoring';
      lastError = null;
      await clearLoginNotification();
      const result = await processTasks(tasks, { perDash });
      lastCheckMessage = `${result.message || ''} [${summary}] · вкладок: ${tabCount}`;
      await saveState();
      ensureAlarm();
      return {
        ok: true,
        ...result,
        runMode,
        message: lastCheckMessage,
        perDash
      };
    }

    // Пустой снимок ≠ обязательно «нет входа».
    // Уведомление только при явных признаках login / нет вкладок.
    const suspectLogin =
      missingTabs > 0 ||
      loginTabs > 0 ||
      tabCount === 0 ||
      (loginLike && readyTabs === 0);

    if (!suspectLogin) {
      runMode = 'running';
      monitorStatus = 'monitoring';
      lastError = null;
      await clearLoginNotification();

      // Не зовём processTasks([]) «насильно» — пусть soft-keep удержит ФРЗ/ПРЗ/ПКМ
      const result = await processTasks([], { perDash });
      lastCheckMessage =
        result.message ||
        `Пустой снимок (${summary}). Список не сбрасываю сразу.`;
      await saveState();
      ensureAlarm();
      return {
        ok: true,
        ...result,
        emptyScrape: true,
        needLogin: false,
        runMode,
        message: lastCheckMessage,
        perDash
      };
    }

    runMode = 'paused';
    monitorStatus = 'paused';
    lastCheckMessage = `Нет данных (${summary}). ${LOGIN_NOTIFY_TEXT}`;
    lastError = lastCheckMessage;
    await notifyLoginMissing();
    await saveState();
    ensureAlarm();
    return {
      ok: true,
      newCount: 0,
      total: activeTasks.length,
      scraped: 0,
      emptyScrape: true,
      needLogin: true,
      loginLike,
      missingTabs,
      loginTabs,
      readyTabs,
      runMode,
      message: lastCheckMessage,
      perDash
    };
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    runMode = 'paused';
    monitorStatus = 'paused';
    lastCheckMessage = `${LOGIN_NOTIFY_TEXT} (${lastError})`;
    await notifyLoginMissing();
    await saveState();
    ensureAlarm();
    return { ok: false, error: lastError, runMode, message: lastCheckMessage };
  }
}

async function handleTick(reason = 'alarm') {
  await loadState();

  if (runMode === 'idle') {
    return {
      ok: true,
      idle: true,
      runMode,
      message: 'Монитор не запущен. Нажмите «Запустить».'
    };
  }

  if (runMode === 'warming') {
    const left = Math.max(0, warmUntil - Date.now());
    if (left > 0) {
      monitorStatus = 'warming';
      lastCheckMessage = `Ожидание прогрева вкладок… ещё ~${Math.ceil(left / 1000)} с`;
      await saveState();
      return { ok: true, warming: true, runMode, warmLeftMs: left, message: lastCheckMessage };
    }
    // Минута прошла — первая попытка сбора
    return collectAndApply('warm-done');
  }

  if (runMode === 'running' || runMode === 'paused') {
    return collectAndApply(reason);
  }

  return { ok: true, runMode, message: lastCheckMessage };
}

/**
 * Кнопка «Запустить»: открыть 3 pinned-вкладки один раз, ждать 1 минуту, затем сбор.
 */
async function startMonitor(options = {}) {
  await loadState();
  monitorStatus = 'starting';
  lastCheckMessage = 'Запуск монитора…';
  await saveState();

  let openedResult;
  try {
    if (options.tabsOpenedByPopup && Array.isArray(options.opened) && options.opened.length) {
      // Popup уже открыл вкладки — только запоминаем id (строго по key / id дашборда)
      const storedIds = await getStoredTabIds();
      const usedIds = new Set();
      for (const item of options.opened) {
        const key =
          item.key ||
          keyFromDashboardId(extractDashboardId(item.url)) ||
          null;
        if (!key || item.tabId == null || usedIds.has(item.tabId)) continue;
        usedIds.add(item.tabId);
        forgetTabIdConflicts(storedIds, key, item.tabId);
      }
      await saveStoredTabIds(storedIds);
      openedResult = { ok: true, opened: options.opened };
    } else {
      openedResult = await openMonitorDashboards();
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    runMode = 'idle';
    monitorStatus = 'idle';
    lastError = msg;
    lastCheckMessage = `Не удалось открыть дашборды: ${msg}`;
    await saveState();
    return { ok: false, runMode, message: lastCheckMessage, error: msg };
  }

  if (!openedResult?.ok) {
    runMode = 'idle';
    monitorStatus = 'idle';
    lastError = openedResult?.error || 'Нет вкладок';
    lastCheckMessage = `Не удалось открыть дашборды: ${lastError}`;
    await saveState();
    return {
      ok: false,
      runMode,
      message: lastCheckMessage,
      error: lastError,
      opened: openedResult?.opened || []
    };
  }

  runMode = 'warming';
  warmUntil = Date.now() + WARMUP_MS;
  monitorStatus = 'warming';
  lastError = null;
  lastCheckMessage =
    `Открыто вкладок: ${openedResult.opened.length}. Жду 1 минуту, затем сниму данные.` +
    (openedResult.warning ? ` (${openedResult.warning})` : '');
  await saveState();

  await clearAlarms();
  // Дублируем таймер: one-shot + периодический (надёжнее в MV3)
  ext.alarms.create(WARM_ALARM_NAME, { when: warmUntil });
  ext.alarms.create(ALARM_NAME, {
    periodInMinutes: CHECK_PERIOD_MINUTES,
    delayInMinutes: 1
  });

  createNotification(
    'Монитор BPM V2alt',
    'Вкладки открыты. Через 1 минуту будет проверка входа в BPMS.',
    { id: 'bpm-alt-started', requireInteraction: false }
  );

  return {
    ok: true,
    runMode,
    warmUntil,
    opened: openedResult.opened,
    message: lastCheckMessage
  };
}

async function stopToIdle() {
  runMode = 'idle';
  warmUntil = 0;
  monitorStatus = 'idle';
  lastCheckMessage = 'Остановлено. Нажмите «Запустить», когда будете готовы.';
  await clearAlarms();
  await clearLoginBadge();
  await saveState();
  return { ok: true, runMode, message: lastCheckMessage };
}

async function setTaskScheme(taskId, scheme) {
  await loadState();
  const now = Date.now();
  const idx = activeTasks.findIndex((t) => t.id === taskId);
  if (idx < 0) return { ok: false, error: 'Задача не найдена' };

  const task = activeTasks[idx];
  if (!supportsSchemeSwitch(task.type)) {
    return { ok: false, error: 'Смена схемы только для ФРЗ и ПКМ' };
  }

  if (scheme !== 'default' && scheme !== 'radio' && scheme !== 'vols') {
    return { ok: false, error: 'Неизвестная схема' };
  }

  let next = {
    ...task,
    scheme,
    schemeChangedAt: now,
    notified: [],
    lastDangerAt: 0,
    lastVolsNotifyAt: scheme === 'vols' ? now : 0
  };

  if (scheme === 'vols') {
    // Таймер сбрасывается и не считается
    next.appearedAt = now;
  }
  // radio: appearedAt сохраняем — сроки от появления заявки

  // После смены схемы не спамим уже прошедшие пороги новой схемы
  next = seedPastThresholds(next, now);
  next = enrichTaskView(applyTimerNotifications(next, now), now);
  activeTasks[idx] = next;
  rememberScheme(next);
  await saveState();
  return { ok: true, task: next };
}

function ensureAlarm() {
  ext.alarms.create(ALARM_NAME, {
    periodInMinutes: CHECK_PERIOD_MINUTES,
    delayInMinutes: CHECK_PERIOD_MINUTES
  });
}

async function goIdleOnBrowserStart(reason) {
  await loadState();
  runMode = 'idle';
  warmUntil = 0;
  monitorStatus = 'idle';
  lastCheckMessage =
    'Расширение активно, но ничего не делает. Нажмите «Запустить».';
  await clearAlarms();
  await clearLoginBadge();
  await saveState();
  console.log(`⏸ V2alt idle after ${reason}`);
}

ext.runtime.onInstalled.addListener(async () => {
  await goIdleOnBrowserStart('install');
});

ext.runtime.onStartup.addListener(async () => {
  await goIdleOnBrowserStart('startup');
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === WARM_ALARM_NAME) {
    handleTick(alarm.name === WARM_ALARM_NAME ? 'warm-alarm' : 'alarm');
  }
});

ext.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'frameTasks') {
    return false;
  }

  (async () => {
    await loadState();

    if (request.action === 'newTasks') {
      // Игнор автопушей со страницы, пока монитор не запущен
      if (runMode === 'idle' || runMode === 'warming') {
        sendResponse({ status: 'ignored', runMode });
        return;
      }
      const result = await processTasks(request.tasks || []);
      sendResponse({ status: 'ok', ...result });
      return;
    }

    if (request.action === 'getStatus') {
      sendResponse({
        status: 'ok',
        monitorStatus,
        runMode,
        warmUntil,
        lastCheckAt,
        lastError,
        lastCheckMessage,
        activeCount: activeTasks.length,
        knownCount: knownIds.size,
        bootstrapped,
        targetUrl: DASHBOARDS.map((d) => d.url),
        dashboards: DASHBOARDS.map((d) => ({ key: d.key, label: d.label, url: d.url })),
        privacy: 'local-only',
        workHours: 'пн–пт 09:00–18:00',
        notificationsEnabled,
        workTimeNow: isWorkTime(),
        collectingAlways: runMode === 'running' || runMode === 'paused',
        primaryAction:
          runMode === 'idle'
            ? 'start'
            : runMode === 'warming'
              ? 'warming'
              : 'check'
      });
      return;
    }

    if (request.action === 'setNotificationsEnabled') {
      notificationsEnabled = request.enabled !== false;
      await saveState({ notificationsEnabled });
      sendResponse({
        ok: true,
        notificationsEnabled,
        message: notificationsEnabled
          ? 'Уведомления включены'
          : 'Уведомления выключены'
      });
      return;
    }

    if (request.action === 'getHistory') {
      const now = Date.now();
      const history = activeTasks.map((t) => enrichTaskView(t, now));
      sendResponse({ history });
      return;
    }

    if (request.action === 'startMonitor') {
      const result = await startMonitor({
        tabsOpenedByPopup: Boolean(request.tabsOpenedByPopup),
        opened: request.opened || []
      });
      sendResponse(result);
      return;
    }

    if (request.action === 'manualCheck') {
      if (runMode === 'idle') {
        sendResponse({
          ok: false,
          runMode,
          message: 'Сначала нажмите «Запустить».'
        });
        return;
      }
      if (runMode === 'warming' && Date.now() < warmUntil) {
        const left = Math.ceil((warmUntil - Date.now()) / 1000);
        sendResponse({
          ok: true,
          warming: true,
          runMode,
          message: `Ещё рано: подождите ~${left} с после запуска.`
        });
        return;
      }

      let ensureInfo = null;
      try {
        ensureInfo = await ensureMonitorDashboards();
      } catch (err) {
        sendResponse({
          ok: false,
          runMode,
          message: `Не удалось проверить вкладки: ${err.message || err}`
        });
        return;
      }

      const result = await handleTick('manual');
      const prefix = ensureInfo?.message ? `${ensureInfo.message} ` : '';
      sendResponse({
        ...result,
        ensure: ensureInfo,
        message: `${prefix}${result.message || ''}`.trim()
      });
      return;
    }

    if (request.action === 'openDashboards') {
      // Совместимость: то же, что старт без смены режима? Лучше запретить автосоздание вне Start.
      if (runMode === 'idle') {
        sendResponse({
          ok: false,
          message: 'Используйте кнопку «Запустить».'
        });
        return;
      }
      const result = await openMonitorDashboards();
      sendResponse(result);
      return;
    }

    if (request.action === 'setScheme') {
      const result = await setTaskScheme(request.taskId, request.scheme);
      sendResponse(result);
      return;
    }

    if (request.action === 'ping') {
      sendResponse({
        status: 'pong',
        activeCount: activeTasks.length,
        monitorStatus,
        runMode
      });
      return;
    }

    if (request.action === 'resetKnown') {
      knownIds = new Set();
      bootstrapped = false;
      activeTasks = [];
      await saveState();
      sendResponse({ status: 'ok' });
      return;
    }

    if (request.action === 'stopMonitor') {
      const result = await stopToIdle();
      sendResponse(result);
      return;
    }

    sendResponse({ status: 'unknown' });
  })();

  return true;
});

loadState().then(async () => {
  // После пробуждения SW не запускаем сбор сами. Alarm только если уже running/paused/warming.
  if (runMode === 'running' || runMode === 'paused' || runMode === 'warming') {
    ensureAlarm();
  } else {
    await clearAlarms();
    monitorStatus = 'idle';
    runMode = 'idle';
    lastCheckMessage =
      lastCheckMessage ||
      'Расширение активно, но ничего не делает. Нажмите «Запустить».';
    await saveState();
  }
  console.log('✅ Background V2alt готов, runMode=', runMode);
});
