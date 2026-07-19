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
const CHECK_PERIOD_MINUTES = 1;
const MONITOR_TABS_STORAGE_KEY = 'monitorTabIds';
const GRID_SETTLE_MS = 5000;

let knownIds = new Set();
let activeTasks = [];
let bootstrapped = false;
let lastCheckAt = null;
let lastError = null;
let lastCheckMessage = null;
let monitorStatus = 'starting';

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
  const typed = getTaskType(raw.title);

  if (typed) {
    const typedFamily = getStepFamily(typed);
    if (!family || typedFamily === family) return typed;
    return null;
  }

  const title = (raw.title || '').toLowerCase();
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

function mergeExisting(prev, incoming, now) {
  return {
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

async function processTasks(tasks) {
  const now = Date.now();
  const prevById = new Map(activeTasks.map((t) => [t.id, t]));
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

  for (const incoming of relevant) {
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
      task = createTrackedTask(incoming, now, { notifyAppear: false });
      task.appearedAt = resolveAppearedAt(incoming, null, now);
      task = seedPastThresholds(task, now);
    }

    next.push(enrichTaskView(task, now));
  }

  activeTasks = next;
  monitorStatus = 'monitoring';
  lastCheckMessage = `Обновлено: ${activeTasks.length} активных, новых: ${newCount}, строк с страницы: ${tasks.length}` +
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
    enrichTaskView(applyTimerNotifications(task, now), now)
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

async function getStoredTabIds() {
  const stored = await ext.storage.local.get([MONITOR_TABS_STORAGE_KEY]);
  return stored[MONITOR_TABS_STORAGE_KEY] || {};
}

async function saveStoredTabIds(map) {
  await ext.storage.local.set({ [MONITOR_TABS_STORAGE_KEY]: map });
}

function tabMatchesDashboard(tab, dash) {
  const url = tab?.url || '';
  return url.includes(dash.match);
}

async function findTabForDashboard(dash, storedIds) {
  const savedId = storedIds[dash.key];
  if (savedId != null) {
    try {
      const tab = await ext.tabs.get(savedId);
      if (tab && tabMatchesDashboard(tab, dash)) return tab;
    } catch (_) {
      /* закрыта */
    }
  }

  const all = await ext.tabs.query({
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/*'
  });
  const exact = all.find((t) => tabMatchesDashboard(t, dash));
  if (exact) return exact;
  return null;
}

async function ensureDashboardTab(dash, storedIds) {
  let tab = await findTabForDashboard(dash, storedIds);
  if (tab) {
    storedIds[dash.key] = tab.id;
    return tab;
  }

  tab = await ext.tabs.create({
    url: dash.url,
    active: false,
    pinned: true
  });
  storedIds[dash.key] = tab.id;
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, GRID_SETTLE_MS));
  return tab;
}

/** Держит три закреплённые фоновые вкладки 4002/4003/4004. */
async function ensureAllDashboardTabs() {
  monitorStatus = 'opening-tab';
  await saveState();

  const storedIds = await getStoredTabIds();
  const pairs = [];
  for (const dash of DASHBOARDS) {
    const tab = await ensureDashboardTab(dash, storedIds);
    pairs.push({ dash, tab });
  }
  await saveStoredTabIds(storedIds);

  monitorStatus = 'tab-ready';
  await saveState();
  return pairs;
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
  let tasks = await scrapeViaScripting(tab.id);
  if (!tasks.length) {
    tasks = await collectTasksFromTab(tab.id, 2500);
  }
  return tasks.map((t) => ({
    ...t,
    _family: dash.family,
    _dashboardKey: dash.key,
    id: t.id || `${dash.key}|${t.title}|${t.instanceName || t.client || ''}`
  }));
}

async function requestTasksFromAllDashboards() {
  const pairs = await ensureAllDashboardTabs();
  const merged = [];
  const perDash = [];

  for (const { dash, tab } of pairs) {
    const tasks = await scrapeOneDashboard(dash, tab);
    perDash.push({ key: dash.key, label: dash.label, count: tasks.length });
    merged.push(...tasks);
  }

  return { tasks: dedupeTasks(merged), perDash, tabCount: pairs.length };
}

async function runCheck(reason = 'alarm') {
  console.log(`🔍 Проверка V2alt (${reason})`);
  try {
    await loadState();
    if (activeTasks.length) {
      await refreshTimersOnly();
    }
    const { tasks, perDash, tabCount } = await requestTasksFromAllDashboards();
    const summary = perDash.map((p) => `${p.label}:${p.count}`).join(' · ');

    if (tasks.length) {
      const result = await processTasks(tasks);
      lastCheckMessage = `${result.message || ''} [${summary}] · вкладок: ${tabCount}`;
      await saveState();
      return { ok: true, ...result, message: lastCheckMessage, perDash };
    }

    monitorStatus = 'monitoring';
    lastCheckAt = Date.now();
    lastCheckMessage =
      activeTasks.length > 0
        ? `С дашбордов 0 строк (${summary}), оставлен прошлый список (${activeTasks.length}). Проверьте вкладки 4002/4003/4004.`
        : `Задачи не найдены (${summary}). Нужны дашборды ПРЗ/ФРЗ/ПКМ (расширение открывает их в фоне). Войдите в BPM и нажмите «Проверить сейчас».`;
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
      message: lastCheckMessage,
      perDash
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
      const result = await processTasks(request.tasks || []);
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
        targetUrl: DASHBOARDS.map((d) => d.url),
        dashboards: DASHBOARDS.map((d) => ({ key: d.key, label: d.label, url: d.url })),
        privacy: 'local-only',
        workHours: 'пн–пт 09:00–18:00',
        notificationsEnabled: isWorkTime(),
        collectingAlways: true
      });
      return;
    }

    if (request.action === 'getHistory') {
      const now = Date.now();
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

loadState().then(() => {
  ensureAlarm();
  console.log('✅ Background V2alt (3 dashboards) готов (local-only)');
});
