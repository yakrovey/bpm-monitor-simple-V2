import {
  appearNotificationFor,
  collectDueNotifications,
  evaluateTimer,
  getSchemeConfig,
  getStepFamily,
  looksLikeSchemeLabel,
  reconcileNotifiedThresholds,
  resolveAppearedAtForTimer,
  schemeFromSos,
  supportsSchemeSwitch
} from './timerEngine.js';
import { isWorkTime, parseRussianDateTime } from './businessTime.js';
import { pageFindTasks } from './pageScrape.js';
import { ext } from './extApi.js';

// BPM Monitor V2 — фон + рабочие таймеры
// Данные только локально: ext.storage.local + workplace.ertelecom.ru

const TARGET_URL =
  'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/13202';
const TARGET_DASHBOARD_MATCH = '/SYSRP/13202';
const TARGET_URL_PATTERN =
  'https://workplace.ertelecom.ru/ProcessPortal/dashboards/*';
const ALARM_NAME = 'bpmCheck';
const CHECK_PERIOD_MINUTES = 1;
/** Минимальный интервал между фоновыми проверками (защита от дублей). */
const MIN_CHECK_INTERVAL_MS = 45 * 1000;
const MONITOR_TAB_STORAGE_KEY = 'monitorTabId';
const MONITOR_WINDOW_STORAGE_KEY = 'monitorWindowId';
const SCRAPE_TIMEOUT_ACTIVE_MS = 28000;
const SCRAPE_TIMEOUT_HIDDEN_MS = 55000;
/** Не видели заявку в снимке дольше — снимаем даже при неполном scrape. */
const STALE_TASK_REMOVE_MS = 90 * 1000;
/** Защита от срыва колонки: не принимать дату старше сохранённой на много дней. */
const MAX_APPEARED_AT_ROLLBACK_MS = 2 * 24 * 60 * 60 * 1000;

let knownIds = new Set();
let activeTasks = [];
let bootstrapped = false;
let lastCheckAt = null;
let lastError = null;
let lastCheckMessage = null;
let monitorStatus = 'starting';
let lastRunCheckAt = 0;
let runCheckPromise = null;

async function loadState() {
  const data = await ext.storage.local.get([
    'knownIds',
    'activeTasks',
    'bootstrapped',
    'lastCheckAt',
    'lastError',
    'lastCheckMessage',
    'monitorStatus'
  ]);

  knownIds = new Set(data.knownIds || []);
  activeTasks = data.activeTasks || [];
  bootstrapped = Boolean(data.bootstrapped);
  lastCheckAt = data.lastCheckAt || null;
  lastError = data.lastError || null;
  lastCheckMessage = data.lastCheckMessage || null;
  monitorStatus = data.monitorStatus || 'idle';
  const beforeRepair = activeTasks.length;
  if (repairActiveTasks() || activeTasks.length !== beforeRepair) {
    await saveState();
  }
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
    ...extra
  });
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

  // Только явные шаги ПРЗ / ФРЗ / ПКМ. «Шаг 1.2 / 3.1 / 5.1» и прочее — игнор.
  if (/шаг\s*\d/.test(text)) return null;
  if (!/(прз|фрз|пкм)/.test(text)) return null;

  if (text.includes('пкм')) {
    // «ПКМ: состояние НМУ КРУС» — отдельный шаг «Монтаж»
    if (
      text.includes('нму крус') ||
      text.includes('нку крус') ||
      (text.includes('состояние') && text.includes('крус'))
    ) {
      return 'Монтаж: НМУ КРУС';
    }
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

function createNotification(title, message) {
  ext.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: title || 'Монитор BPM',
    message: message || '',
    priority: 1,
    silent: false,
    requireInteraction: false
  });
}

function enrichTaskView(task, now = Date.now()) {
  const synced = syncAppearedAtWithPageDate(cleanDisplayFields(task));
  const evalResult = evaluateTimer(synced, now);
  return {
    ...synced,
    zone: evalResult.zone,
    color: evalResult.color,
    elapsedMs: evalResult.elapsedMs,
    elapsedLabel: evalResult.elapsedLabel,
    paused: evalResult.paused,
    workingNow: evalResult.workingNow,
    supportsSchemeSwitch: evalResult.supportsSchemeSwitch,
    scheme: synced.scheme || 'default'
  };
}

function applyTimerNotifications(task, now = Date.now()) {
  const allowNotify = isWorkTime(new Date(now));
  let next = reconcileNotifiedThresholds(cleanDisplayFields({ ...task }), now);

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
  // Дата со страницы — главный источник. Fallback «сейчас» только если даты нет.
  let candidate = null;

  if (incoming.date) {
    candidate = parseRussianDateTime(incoming.date);
  }
  if (
    candidate == null &&
    incoming.appearedAt &&
    Number.isFinite(Number(incoming.appearedAt))
  ) {
    candidate = Number(incoming.appearedAt);
  }

  if (candidate != null && prev?.appearedAt) {
    const rollbackMs = prev.appearedAt - candidate;
    const prevFromPage =
      Boolean(prev.date) &&
      parseRussianDateTime(prev.date) === prev.appearedAt;
    // Блокируем только скачок на дни назад при уже стабильной дате со страницы
    if (prevFromPage && rollbackMs > MAX_APPEARED_AT_ROLLBACK_MS) {
      return prev.appearedAt;
    }
  }

  if (candidate != null) return candidate;
  if (prev?.appearedAt) return prev.appearedAt;
  return now;
}

/** Выровнять appearedAt с текстовой датой (единый источник с таймером и уведомлениями). */
function syncAppearedAtWithPageDate(task) {
  if (!task) return task;
  const appearedAt = resolveAppearedAtForTimer(task);
  if (task.appearedAt === appearedAt) return task;
  return reconcileNotifiedThresholds(task);
}

function resolveTextField(incomingVal, prevVal, { rejectScheme = false } = {}) {
  let inc = String(incomingVal || '').trim();
  let prev = String(prevVal || '').trim();
  if (rejectScheme) {
    if (looksLikeSchemeLabel(prev)) prev = '';
    if (looksLikeSchemeLabel(inc)) inc = '';
  }
  if (!inc) return prev;
  return inc;
}

function deriveClientFromInstance(instanceName) {
  const text = String(instanceName || '').trim();
  if (!text || looksLikeSchemeLabel(text)) return '';

  const conn = text.match(/^Подключение\s+[\"«`'“](.+?)[\"»`'”]\s+по\s+ТЭО/i);
  if (conn) return conn[1].trim();

  const orgRe = /(ООО|ОАО|АО|ПАО|ЗАО|ИП|Общество с ограниченной)/i;
  const match = text.match(orgRe);
  if (match) {
    const idx = text.indexOf(match[0]);
    return text.slice(idx).split(/\.\s+/)[0].replace(/\.+$/, '').trim();
  }
  return '';
}

function cleanDisplayFields(task) {
  if (!task) return task;
  let next = { ...task };

  if (looksLikeSchemeLabel(next.client)) next.client = '';
  if (looksLikeSchemeLabel(next.instanceName)) next.instanceName = '';

  if (!next.client && next.instanceName) {
    const derived = deriveClientFromInstance(next.instanceName);
    if (derived) next.client = derived;
  }

  return next;
}

function sanitizeTaskFields(task) {
  if (!task) return task;
  let next = cleanDisplayFields(task);
  const title = String(next.title || '').trim();
  if (!title || !getTaskType(title)) return null;

  if (
    next.address &&
    !next.client &&
    looksLikeSchemeLabel(next.address) &&
    !/(ул\.|улица|пр-кт|Санкт-Петербург)/i.test(next.address)
  ) {
    next.address = '';
  }
  return next;
}

function repairActiveTasks() {
  let changed = false;
  const next = [];
  for (const task of activeTasks) {
    const cleaned = sanitizeTaskFields(task);
    if (!cleaned) {
      changed = true;
      continue;
    }
    if (cleaned.client !== task.client ||
      cleaned.instanceName !== task.instanceName ||
      cleaned.title !== task.title ||
      cleaned.appearedAt !== task.appearedAt
    ) {
      changed = true;
    }
    next.push(cleaned);
  }
  activeTasks = next.map((t) => reconcileNotifiedThresholds(t)).filter(Boolean);
  return changed;
}

function resolveDisplayDate(incoming, prev, appearedAt) {
  if (incoming.date) {
    const parsed = parseRussianDateTime(incoming.date);
    if (parsed != null) return incoming.date;
  }
  if (prev?.date) return prev.date;
  return '';
}

/**
 * Автосхема по колонке СОС для ФРЗ/ПКМ. Монтаж не трогаем.
 * Возвращает null, если СОС пустой/неизвестный или шаг не поддерживает смену.
 */
function resolveSchemeFromIncoming(incoming, prev) {
  const family = getStepFamily(incoming.type || prev?.type);
  if (family === 'montage') return 'montage';
  if (family !== 'frz' && family !== 'pkm') return null;

  // Свежий СОС со страницы важнее сохранённого
  const sos = (incoming.sos || '').trim() || (prev?.sos || '').trim();
  return schemeFromSos(sos);
}

function applySchemeChange(task, nextScheme, now) {
  if (!nextScheme || task.scheme === nextScheme) return task;

  let next = {
    ...task,
    scheme: nextScheme,
    schemeChangedAt: now,
    notified: [],
    lastDangerAt: 0,
    lastVolsNotifyAt: nextScheme === 'vols' ? now : 0
  };

  if (nextScheme === 'vols') {
    next.appearedAt = now;
  }

  next = seedPastThresholds(next, now);
  return next;
}

function mergeExisting(prev, incoming, now) {
  const appearedAt = resolveAppearedAt(incoming, prev, now);
  const displayDate = resolveDisplayDate(incoming, prev, appearedAt);
  const gainedPageDate = Boolean(displayDate) && !prev?.date;
  const pageDateChanged =
    prev?.appearedAt != null &&
    appearedAt !== prev.appearedAt &&
    displayDate &&
    parseRussianDateTime(displayDate) === appearedAt;

  let merged = {
    ...prev,
    ...incoming,
    id: prev.id,
    title: resolveTextField(incoming.title, prev.title),
    client: resolveTextField(incoming.client, prev.client, { rejectScheme: true }),
    address: resolveTextField(incoming.address, prev.address),
    instanceName: resolveTextField(incoming.instanceName, prev.instanceName, {
      rejectScheme: true
    }),
    type: incoming.type || prev.type,
    date: displayDate,
    sos: (incoming.sos || prev.sos || '').trim(),
    appearedAt,
    scheme: prev.scheme || 'default',
    schemeChangedAt: prev.schemeChangedAt || null,
    notified: prev.notified || [],
    lastDangerAt: prev.lastDangerAt || 0,
    lastVolsNotifyAt: prev.lastVolsNotifyAt || 0,
    pendingAppear: prev.pendingAppear || null,
    lastSeenAt: now
  };

  const sosScheme = resolveSchemeFromIncoming(incoming, prev);
  const prevScheme = prev.scheme || 'default';
  if (sosScheme) {
    merged = applySchemeChange(merged, sosScheme, now);
  } else if (getStepFamily(merged.type) === 'montage') {
    merged.scheme = 'montage';
  }

  // Схемы с остановленным таймером — не перезаписываем appearedAt датой со страницы
  // (кроме свежего переключения на ВОЛС — там таймер сбрасывается)
  const switchedToVols = sosScheme === 'vols' && prevScheme !== 'vols';
  if (
    (merged.scheme === 'vols' || merged.scheme === 'montage') &&
    !switchedToVols
  ) {
    merged.appearedAt = prev.appearedAt || appearedAt;
  }

  // Дата появилась или изменилась — пересчитать пороги без спама старых
  if (
    (pageDateChanged || gainedPageDate) &&
    merged.scheme !== 'vols' &&
    merged.scheme !== 'montage' &&
    (!sosScheme || sosScheme === merged.scheme)
  ) {
    merged = seedPastThresholds(merged, now);
  }

  merged = syncAppearedAtWithPageDate(merged);
  return cleanDisplayFields(merged);
}

function seedPastThresholds(task, now) {
  // При первом появлении в расширении не спамим уже прошедшие пороги.
  const synced = reconcileNotifiedThresholds(task, now);
  const family = getStepFamily(synced.type);
  const scheme = synced.scheme || 'default';
  const config = getSchemeConfig(family, scheme);
  const evalResult = evaluateTimer(synced, now);
  const notified = new Set(synced.notified || []);
  let lastDangerAt = task.lastDangerAt || 0;

  if (config.mode === 'vols' || config.mode === 'montage') {
    return {
      ...synced,
      notified: Array.from(notified),
      lastDangerAt,
      lastElapsedMs: evalResult.elapsedMs,
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
    ...synced,
    notified: Array.from(notified),
    lastDangerAt,
    lastElapsedMs: elapsed,
    zone: evalResult.zone,
    color: evalResult.color,
    elapsedMs: evalResult.elapsedMs,
    elapsedLabel: evalResult.elapsedLabel
  };
}

function createTrackedTask(incoming, now, { notifyAppear }) {
  const isMontage = getStepFamily(incoming.type) === 'montage';
  const sosScheme = resolveSchemeFromIncoming(incoming, null);
  const initialScheme = isMontage ? 'montage' : sosScheme || 'default';

  let task = {
    ...incoming,
    sos: (incoming.sos || '').trim(),
    appearedAt: resolveAppearedAt(incoming, null, now),
    scheme: initialScheme,
    schemeChangedAt: sosScheme || isMontage ? now : null,
    notified: [],
    lastDangerAt: 0,
    lastVolsNotifyAt: initialScheme === 'vols' ? now : 0,
    pendingAppear: null,
    lastSeenAt: now
  };

  if (initialScheme === 'vols') {
    // ВОЛС: таймер сброшен
    task.appearedAt = now;
  } else {
    task = syncAppearedAtWithPageDate(task);
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

function looksLikePartialScrape(incomingCount, prevCount, pagerTotal) {
  if (!bootstrapped || incomingCount === 0) return false;
  // Явно знаем pager — не хватает строк (строго, без «90% достаточно»)
  if (pagerTotal && incomingCount < pagerTotal) return true;
  if (pagerTotal && incomingCount >= pagerTotal) return false;
  if (prevCount === 0) return false;
  if (incomingCount >= prevCount) return false;
  // Типичный сбой виртуального грида (~25 строк) при большем списке
  if (incomingCount <= 30 && prevCount > incomingCount + 8) return true;
  return incomingCount < prevCount * 0.7;
}

async function processTasks(tasks, { pagerTotal = null } = {}) {
  const now = Date.now();
  const prevById = new Map(activeTasks.map((t) => [t.id, t]));
  const prevCount = activeTasks.length;
  const relevant = [];
  let skippedNoType = 0;

  for (const raw of tasks) {
    const sanitized = sanitizeTaskFields({
      ...raw,
      title: String(raw.title || '').trim(),
      client: String(raw.client || '').trim(),
      address: String(raw.address || '').trim(),
      instanceName: String(raw.instanceName || '').trim()
    });
    if (!sanitized) {
      skippedNoType += 1;
      continue;
    }
    const type = getTaskType(sanitized.title);
    const id =
      sanitized.id ||
      `${sanitized.title}|${sanitized.instanceName || sanitized.client || ''}`;
    relevant.push({
      id,
      title: sanitized.title,
      client: sanitized.client || '',
      address: sanitized.address || '',
      instanceName: sanitized.instanceName || '',
      status: sanitized.status || '',
      priority: sanitized.priority || '',
      sos: sanitized.sos || '',
      date: sanitized.date || '',
      appearedAt: sanitized.appearedAt || null,
      fullText: sanitized.fullText || '',
      type
    });
  }

  lastCheckAt = now;
  lastError = null;

  if (!bootstrapped) {
    activeTasks = relevant.map((t) => {
      const task = createTrackedTask(t, now, { notifyAppear: false });
      knownIds.add(task.id);
      return enrichTaskView(task, now);
    });
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
  const incomingIds = new Set();
  const partialScrape = looksLikePartialScrape(
    relevant.length,
    prevCount,
    pagerTotal
  );

  for (const incoming of relevant) {
    incomingIds.add(incoming.id);
    const prev = prevById.get(incoming.id);
    let task;

    if (prev) {
      task = mergeExisting(prev, incoming, now);
      task = applyTimerNotifications(task, now);
    } else if (!knownIds.has(incoming.id)) {
      knownIds.add(incoming.id);
      task = createTrackedTask(incoming, now, { notifyAppear: true });
      newCount += 1;
    } else {
      // Вернулась после снятия: в knownIds есть, «новая» не уведомляем
      task = createTrackedTask(incoming, now, { notifyAppear: false });
    }

    next.push(enrichTaskView({ ...task, lastSeenAt: now }, now));
  }

  let keptStale = 0;
  if (partialScrape) {
    for (const prev of activeTasks) {
      if (incomingIds.has(prev.id)) continue;
      const lastSeen = prev.lastSeenAt || prev.appearedAt || 0;
      if (now - lastSeen >= STALE_TASK_REMOVE_MS) continue;
      const kept = sanitizeTaskFields(prev);
      if (!kept) continue;
      next.push(enrichTaskView(applyTimerNotifications(kept, now), now));
      keptStale += 1;
    }
  }

  const removedCount = activeTasks.filter((t) => {
    if (incomingIds.has(t.id)) return false;
    if (partialScrape) {
      const lastSeen = t.lastSeenAt || t.appearedAt || 0;
      return now - lastSeen >= STALE_TASK_REMOVE_MS;
    }
    return true;
  }).length;

  activeTasks = next.map((t) => sanitizeTaskFields(t)).filter(Boolean);
  monitorStatus = 'monitoring';
  lastCheckMessage = `Обновлено: ${activeTasks.length} активных, новых: ${newCount}, строк с страницы: ${tasks.length}` +
    (pagerTotal ? `, pager: ${pagerTotal}` : '') +
    (removedCount ? `, снято: ${removedCount}` : '') +
    (partialScrape
      ? ` · неполный снимок${keptStale ? `, сохранено: ${keptStale}` : ''}`
      : '') +
    (skippedNoType ? `, прочих шагов: ${skippedNoType}` : '') +
    (isWorkTime(new Date(now)) ? '' : ' · уведомления на паузе (вне раб. времени)');
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
    enrichTaskView(applyTimerNotifications(syncAppearedAtWithPageDate(task), now), now)
  );
  lastCheckAt = now;
  await saveState();
}

function waitForTabComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ext.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Таймаут загрузки вкладки BPM'));
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        ext.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    ext.tabs.get(tabId, (tab) => {
      if (ext.runtime.lastError) {
        clearTimeout(timer);
        ext.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error(ext.runtime.lastError.message));
        return;
      }
      if (tab.status === 'complete') {
        clearTimeout(timer);
        ext.tabs.onUpdated.removeListener(onUpdated);
        resolve();
        return;
      }
      ext.tabs.onUpdated.addListener(onUpdated);
    });
  });
}

async function findDashboardTabs() {
  const tabs = await ext.tabs.query({ url: TARGET_URL_PATTERN });
  return tabs
    .filter((t) => (t.url || '').includes(TARGET_DASHBOARD_MATCH))
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return 0;
    });
}

let cachedMonitorTabId = null;
let ensureMonitorTabPromise = null;

function isDashboardUrl(url) {
  return (url || '').includes(TARGET_DASHBOARD_MATCH);
}

function isWorkplaceUrl(url) {
  return (url || '').includes('workplace.ertelecom.ru');
}

async function persistMonitorTargets(tab) {
  cachedMonitorTabId = tab.id;
  await ext.storage.local.set({
    [MONITOR_WINDOW_STORAGE_KEY]: tab.windowId,
    [MONITOR_TAB_STORAGE_KEY]: tab.id
  });
}

async function navigateTabToDashboard(tabId) {
  let tab = await ext.tabs.get(tabId);
  if (isDashboardUrl(tab.url)) return tab;

  tab = await ext.tabs.update(tabId, { url: TARGET_URL, active: true });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 1200));
  return ext.tabs.get(tab.id);
}

async function findExistingMonitorWindowTab() {
  const stored = await ext.storage.local.get([MONITOR_WINDOW_STORAGE_KEY]);
  const windows = await ext.windows.getAll({ populate: true, windowTypes: ['normal'] });

  if (stored[MONITOR_WINDOW_STORAGE_KEY]) {
    const win = windows.find((w) => w.id === stored[MONITOR_WINDOW_STORAGE_KEY]);
    const tab = win?.tabs?.[0];
    if (tab && isWorkplaceUrl(tab.url)) {
      return tab;
    }
  }

  for (const win of windows) {
    if (win.focused) continue;
    const tabs = win.tabs || [];
    if (tabs.length !== 1) continue;
    const tab = tabs[0];
    if (!isWorkplaceUrl(tab.url)) continue;
    await ext.storage.local.set({ [MONITOR_WINDOW_STORAGE_KEY]: win.id });
    return tab;
  }

  return null;
}

async function ensureDedicatedMonitorTabImpl() {
  if (cachedMonitorTabId) {
    try {
      const tab = await ext.tabs.get(cachedMonitorTabId);
      if (isWorkplaceUrl(tab.url)) {
        const ready = isDashboardUrl(tab.url)
          ? tab
          : await navigateTabToDashboard(tab.id);
        await markTabPersistent(ready.id);
        await persistMonitorTargets(ready);
        await keepTabActiveInBackgroundWindow(ready);
        return ready;
      }
    } catch (_) {
      cachedMonitorTabId = null;
    }
  }

  const stored = await ext.storage.local.get([
    MONITOR_TAB_STORAGE_KEY,
    MONITOR_WINDOW_STORAGE_KEY
  ]);

  if (stored[MONITOR_TAB_STORAGE_KEY]) {
    try {
      const tab = await ext.tabs.get(stored[MONITOR_TAB_STORAGE_KEY]);
      if (isWorkplaceUrl(tab.url)) {
        const ready = isDashboardUrl(tab.url)
          ? tab
          : await navigateTabToDashboard(tab.id);
        await markTabPersistent(ready.id);
        await persistMonitorTargets(ready);
        await keepTabActiveInBackgroundWindow(ready);
        return ready;
      }
    } catch (_) {
      /* tab gone */
    }
  }

  const existing = await findExistingMonitorWindowTab();
  if (existing) {
    const ready = isDashboardUrl(existing.url)
      ? existing
      : await navigateTabToDashboard(existing.id);
    await markTabPersistent(ready.id);
    await persistMonitorTargets(ready);
    await keepTabActiveInBackgroundWindow(ready);
    return ready;
  }

  monitorStatus = 'opening-tab';
  await saveState();

  const win = await ext.windows.create({
    url: TARGET_URL,
    focused: false,
    state: 'normal',
    type: 'normal'
  });

  await ext.storage.local.set({ [MONITOR_WINDOW_STORAGE_KEY]: win.id });

  await new Promise((r) => setTimeout(r, 400));
  const tabs = await ext.tabs.query({ windowId: win.id });
  const tab = tabs[0];
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 2500));
  await markTabPersistent(tab.id);
  await persistMonitorTargets(tab);

  monitorStatus = 'tab-ready';
  await saveState();
  return tab;
}

async function ensureDedicatedMonitorTab() {
  if (ensureMonitorTabPromise) {
    return ensureMonitorTabPromise;
  }

  ensureMonitorTabPromise = ensureDedicatedMonitorTabImpl().finally(() => {
    ensureMonitorTabPromise = null;
  });
  return ensureMonitorTabPromise;
}

async function keepTabActiveInBackgroundWindow(tab) {
  try {
    const win = await ext.windows.get(tab.windowId);
    if (win.focused) return;
    if (!tab.active) {
      await ext.tabs.update(tab.id, { active: true });
    }
  } catch (_) {
    /* ignore */
  }
}

/**
 * Кратко «разбудить» фоновое окно монитора без перезагрузки страницы.
 * Важно: фокус держим на время soft-refresh + scrape, иначе Chrome снова
 * затормозит Angular до сбора данных.
 * Возвращает previousWindowId для restoreMonitorWindowFocus().
 */
async function beginWakeDedicatedMonitorWindow(tab) {
  let previousWindowId = null;
  try {
    const focused = await ext.windows.getLastFocused();
    if (focused?.id != null && focused.id !== tab.windowId) {
      previousWindowId = focused.id;
    }
  } catch (_) {
    /* ignore */
  }

  try {
    await keepTabActiveInBackgroundWindow(tab);
    const win = await ext.windows.get(tab.windowId);
    if (!win.focused) {
      await ext.windows.update(tab.windowId, { focused: true, drawAttention: false });
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (_) {
    /* ignore */
  }

  return previousWindowId;
}

async function restoreMonitorWindowFocus(previousWindowId) {
  if (previousWindowId == null) return;
  try {
    await ext.windows.update(previousWindowId, { focused: true });
  } catch (_) {
    /* ignore */
  }
}

async function softRefreshTab(tabId) {
  try {
    await injectGridScraper(tabId);
    // Только основной frame: allFrames мог дергать refresh в чужих iframe BPM
    await ext.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: async () => {
        const fn = globalThis.__bpmSoftRefreshDashboard;
        if (typeof fn === 'function') return fn(true);
        return null;
      }
    });
  } catch (err) {
    console.warn('softRefreshTab failed:', err);
  }
}

function pickScrapedText(a, b, { requireStep = false, rejectScheme = false } = {}) {
  const left = String(a || '').trim();
  const right = String(b || '').trim();
  const ok = (value) => {
    if (!value) return false;
    if (rejectScheme && looksLikeSchemeLabel(value)) return false;
    if (requireStep && !getTaskType(value)) return false;
    return true;
  };
  const leftOk = ok(left);
  const rightOk = ok(right);
  if (leftOk && !rightOk) return left;
  if (rightOk && !leftOk) return right;
  if (!leftOk && !rightOk) return '';
  return right.length > left.length ? right : left;
}

function taskDateRank(task) {
  let rank = 0;
  if (task?.dateSource === 'dom' && task.date) rank += 3;
  else if (task?.date && parseRussianDateTime(task.date) != null) rank += 2;
  if (task?.sos) rank += 2;
  if (task?.dateSource === 'dom' && task.sos) rank += 1;
  return rank;
}

function pickBetterScrapedTask(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rankA = taskDateRank(a);
  const rankB = taskDateRank(b);
  if (rankB !== rankA) return rankB > rankA ? b : a;

  const merged = { ...a, ...b, id: a.id };
  merged.title = pickScrapedText(a.title, b.title, { requireStep: true });
  merged.instanceName = pickScrapedText(a.instanceName, b.instanceName, {
    rejectScheme: true
  });
  merged.client = pickScrapedText(a.client, b.client, { rejectScheme: true });
  merged.address = pickScrapedText(a.address, b.address);
  merged.date = (b.dateSource === 'dom' && b.date) || a.date || b.date || '';
  merged.appearedAt = b.appearedAt ?? a.appearedAt ?? null;
  merged.dateSource =
    (b.date && b.dateSource) || (a.date && a.dateSource) || b.dateSource || a.dateSource || '';
  merged.sos = b.sos || a.sos || '';
  return merged;
}

function mergeScrapedTasks(lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      const id = raw.id || `${raw.title}|${raw.instanceName || raw.client || ''}`;
      const task = { ...raw, id };
      byId.set(id, pickBetterScrapedTask(byId.get(id), task));
    }
  }
  return Array.from(byId.values());
}

async function injectGridScraper(tabId) {
  try {
    await ext.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['gridScrapeInject.js']
    });
  } catch (err) {
    console.warn('gridScrapeInject failed:', err);
  }
}

async function scrapeViaScripting(tabId) {
  await injectGridScraper(tabId);
  try {
    const results = await ext.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pageFindTasks
    });

    let merged = [];
    let pagerTotal = null;
    for (const item of results || []) {
      const payload = item.result;
      if (!payload) continue;
      const tasks = Array.isArray(payload) ? payload : payload.tasks || [];
      if (payload.pagerTotal && (!pagerTotal || payload.pagerTotal > pagerTotal)) {
        pagerTotal = payload.pagerTotal;
      }
      merged = mergeScrapedTasks([merged, tasks]);
    }
    return { tasks: merged, pagerTotal };
  } catch (err) {
    console.warn('scripting scrape failed:', err);
    return { tasks: [], pagerTotal: null };
  }
}

function collectTasksFromTab(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const collected = [];
    const seen = new Set();
    let pagerTotal = null;

    function onMessage(request, sender) {
      if (request?.action !== 'frameTasks') return;
      if (sender.tab?.id !== tabId) return;
      if (request.pagerTotal && (!pagerTotal || request.pagerTotal > pagerTotal)) {
        pagerTotal = request.pagerTotal;
      }
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
      resolve({ tasks: collected, pagerTotal });
    }, timeoutMs);
  });
}

async function markTabPersistent(tabId) {
  try {
    await ext.tabs.update(tabId, { autoDiscardable: false });
  } catch (_) {
    /* ignore */
  }
}

async function doScrapeTab(
  tabId,
  timeoutMs,
  { wakeWindow = false, softRefresh = false, tab = null } = {}
) {
  await markTabPersistent(tabId);
  let previousWindowId = null;
  try {
    if (wakeWindow && tab) {
      previousWindowId = await beginWakeDedicatedMonitorWindow(tab);
    }
    // Soft-refresh только для окна монитора — не трогаем активный дашборд пользователя
    if (softRefresh) {
      await softRefreshTab(tabId);
    }
    const fromContent = await collectTasksFromTab(tabId, timeoutMs);
    const scripted = await scrapeViaScripting(tabId);
    const tasks = mergeScrapedTasks([
      fromContent.tasks || [],
      scripted.tasks || []
    ]);
    const pagerTotal =
      Math.max(scripted.pagerTotal || 0, fromContent.pagerTotal || 0) || null;
    return { tasks, pagerTotal };
  } finally {
    await restoreMonitorWindowFocus(previousWindowId);
  }
}

async function requestTasksFromTab() {
  const dedicatedTab = await ensureDedicatedMonitorTab();

  const dashboardTabs = await findDashboardTabs();
  const userVisible = dashboardTabs.find(
    (t) => t.active && !t.hidden && t.id !== dedicatedTab.id
  );

  let pagerTotal = null;
  const scrapeLists = [];

  if (userVisible) {
    // Активная вкладка пользователя: только чтение, без wake/refresh (не сбиваем UX)
    const userResult = await doScrapeTab(
      userVisible.id,
      SCRAPE_TIMEOUT_ACTIVE_MS,
      { wakeWindow: false, softRefresh: false, tab: userVisible }
    );
    scrapeLists.push(userResult.tasks || []);
    pagerTotal = userResult.pagerTotal;
  }

  // Фоновое окно монитора: soft-refresh (Enter в поиске) БЕЗ смены фокуса окна —
  // иначе Chromium шлёт «Окно … ожидает»
  const dedicatedResult = await doScrapeTab(
    dedicatedTab.id,
    Math.min(SCRAPE_TIMEOUT_HIDDEN_MS, 22000),
    { wakeWindow: false, softRefresh: true, tab: dedicatedTab }
  );
  scrapeLists.push(dedicatedResult.tasks || []);
  if (
    dedicatedResult.pagerTotal &&
    (!pagerTotal || dedicatedResult.pagerTotal > pagerTotal)
  ) {
    pagerTotal = dedicatedResult.pagerTotal;
  }

  const merged = mergeScrapedTasks(scrapeLists);

  await ext.storage.local.set({ [MONITOR_TAB_STORAGE_KEY]: dedicatedTab.id });
  cachedMonitorTabId = dedicatedTab.id;
  return { tasks: merged, pagerTotal };
}

async function runCheck(reason = 'alarm') {
  // Параллельный alarm + manual / push не должен дважды будить окно и писать storage
  if (runCheckPromise) {
    if (reason === 'manual') {
      await runCheckPromise;
    } else {
      return {
        ok: true,
        skipped: true,
        total: activeTasks.length,
        message: 'Пропуск: проверка уже выполняется'
      };
    }
  }

  runCheckPromise = runCheckImpl(reason).finally(() => {
    runCheckPromise = null;
  });
  return runCheckPromise;
}

async function runCheckImpl(reason = 'alarm') {
  const now = Date.now();
  await loadState();

  if (
    reason !== 'manual' &&
    lastRunCheckAt &&
    now - lastRunCheckAt < MIN_CHECK_INTERVAL_MS
  ) {
    if (activeTasks.length) {
      await refreshTimersOnly();
    }
    return {
      ok: true,
      skipped: true,
      total: activeTasks.length,
      message: 'Пропуск: проверка уже была менее минуты назад'
    };
  }

  lastRunCheckAt = now;
  console.log(`🔍 Проверка (${reason})`);
  try {
    const { tasks, pagerTotal } = await requestTasksFromTab();

    if (tasks.length) {
      const result = await processTasks(tasks, { pagerTotal });
      return { ok: true, ...result };
    }

    if (activeTasks.length) {
      await refreshTimersOnly();
    }

    monitorStatus = 'monitoring';
    lastCheckAt = Date.now();
    lastCheckMessage =
      activeTasks.length > 0
        ? `Со страницы 0 строк, оставлен прошлый список (${activeTasks.length}). Откройте дашборд 13202 и повторите.`
        : 'На странице задачи не найдены. Откройте дашборд SYSRP/13202 (с таблицей задач) и нажмите «Проверить сейчас» ещё раз.';
    if (!activeTasks.length) {
      lastError = lastCheckMessage;
    } else {
      lastError = null;
    }
    await saveState();
    return {
      ok: true,
      newCount: 0,
      total: activeTasks.length,
      scraped: 0,
      emptyScrape: true,
      message: lastCheckMessage
    };
  } catch (err) {
    lastError = String(err && err.message ? err.message : err);
    lastCheckMessage = `Ошибка: ${lastError}`;
    monitorStatus = 'error';
    try {
      if (activeTasks.length) await refreshTimersOnly();
    } catch (_) {
      /* ignore */
    }
    await saveState();
    console.warn('⚠️ Ошибка проверки:', lastError);
    return { ok: false, error: lastError, message: lastCheckMessage };
  }
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

  if (scheme !== 'default' && scheme !== 'radio' && scheme !== 'vols' && scheme !== 'montage') {
    return { ok: false, error: 'Неизвестная схема' };
  }

  if (scheme === 'montage' && getStepFamily(task.type) !== 'pkm') {
    return { ok: false, error: 'Схема «Монтаж» только для ПКМ' };
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
  await saveState();
  return { ok: true, task: next };
}

function ensureAlarm() {
  ext.alarms.create(ALARM_NAME, {
    periodInMinutes: CHECK_PERIOD_MINUTES,
    delayInMinutes: 0.1
  });
}

ext.runtime.onInstalled.addListener(async () => {
  await loadState();
  ensureAlarm();
  runCheck('install');
});

ext.runtime.onStartup.addListener(async () => {
  await loadState();
  ensureAlarm();
  runCheck('startup');
});

ext.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runCheck('alarm');
  }
});

ext.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'frameTasks') {
    return false;
  }

  (async () => {
    await loadState();

    if (request.action === 'newTasks') {
      // Устаревший путь: полный scrape через runCheck (не сырой processTasks)
      const result = await runCheck(request.source || 'push');
      sendResponse({ status: 'ok', ...result });
      return;
    }

    if (request.action === 'getStatus') {
      sendResponse({
        status: 'ok',
        monitorStatus,
        lastCheckAt,
        lastError,
        lastCheckMessage,
        activeCount: activeTasks.length,
        knownCount: knownIds.size,
        bootstrapped,
        targetUrl: TARGET_URL,
        privacy: 'local-only',
        workHours: 'пн–пт 09:00–18:00',
        notificationsEnabled: isWorkTime(),
        collectingAlways: true,
        checkPeriodMinutes: CHECK_PERIOD_MINUTES,
        popupRefreshSec: 5,
        timerTickSec: 1
      });
      return;
    }

    if (request.action === 'getHistory') {
      const now = Date.now();
      let changed = false;
      const beforeLen = activeTasks.length;
      const repaired = repairActiveTasks();
      if (repaired || activeTasks.length !== beforeLen) changed = true;
      activeTasks = activeTasks.map((t) => {
        const synced = syncAppearedAtWithPageDate(t);
        if (synced.appearedAt !== t.appearedAt) changed = true;
        return synced;
      });
      if (changed) await saveState();
      const history = activeTasks.map((t) => enrichTaskView(t, now));
      sendResponse({ history });
      return;
    }

    if (request.action === 'manualCheck') {
      const result = await runCheck('manual');
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
        monitorStatus
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

    sendResponse({ status: 'unknown' });
  })();

  return true;
});

ext.tabs.onRemoved.addListener((tabId) => {
  if (cachedMonitorTabId === tabId) {
    cachedMonitorTabId = null;
  }
  ext.storage.local.get([MONITOR_TAB_STORAGE_KEY]).then((data) => {
    if (data[MONITOR_TAB_STORAGE_KEY] === tabId) {
      ext.storage.local.remove(MONITOR_TAB_STORAGE_KEY);
    }
  });
});

ext.windows.onRemoved.addListener((windowId) => {
  ext.storage.local.get([MONITOR_WINDOW_STORAGE_KEY]).then((data) => {
    if (data[MONITOR_WINDOW_STORAGE_KEY] === windowId) {
      cachedMonitorTabId = null;
      ext.storage.local.remove([
        MONITOR_WINDOW_STORAGE_KEY,
        MONITOR_TAB_STORAGE_KEY
      ]);
    }
  });
});

loadState().then(() => {
  ensureAlarm();
  console.log('✅ Background V2 + timers готов (local-only)');
});
