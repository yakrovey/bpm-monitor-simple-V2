import { evaluateTimer, getStepFamily } from './timerEngine.js';
import {
  formatBusinessDuration,
  businessMsBetween,
  isWorkTime
} from './businessTime.js';
import { ext } from './extApi.js';

const DASHBOARDS = [
  {
    key: 'prz',
    label: 'ПРЗ',
    id: '4002',
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/4002'
  },
  {
    key: 'frz',
    label: 'ФРЗ',
    id: '4003',
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/4003'
  },
  {
    key: 'pkm',
    label: 'ПКМ',
    id: '4004',
    url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/4004'
  }
];

const DASHBOARD_ID_RE = /\/SYSRP\/(400[234])(?:\/|$|\?|#)/i;

function extractDashboardId(url) {
  const m = String(url || '').match(DASHBOARD_ID_RE);
  return m ? m[1] : null;
}

const TAB_LABELS = {
  prz: 'ПРЗ',
  frz: 'ФРЗ',
  pkm: 'ПКМ'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  if (!ts) return 'ещё не было';
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function statusLabel(monitorStatus) {
  switch (monitorStatus) {
    case 'monitoring':
    case 'tab-ready':
      return { text: '● Активен', color: '#4caf50' };
    case 'opening-tab':
    case 'starting':
      return { text: '● Запуск', color: '#ff9800' };
    case 'error':
      return { text: '● Ошибка', color: '#f44336' };
    default:
      return { text: '● Ожидание', color: '#9e9e9e' };
  }
}

function schemeLabel(scheme) {
  if (scheme === 'radio') return 'Радио';
  if (scheme === 'vols') return 'ВОЛС';
  return 'Обычная';
}

function liveElapsed(task) {
  const now = Date.now();
  if ((task.scheme || 'default') === 'vols') {
    return {
      label: 'ВОЛС · таймер выкл',
      paused: false,
      color: '#ffffff',
      zone: 'vols'
    };
  }
  const evalResult = evaluateTimer(task, now);
  return {
    label: formatBusinessDuration(
      businessMsBetween(task.appearedAt || now, now)
    ),
    paused: !isWorkTime(new Date(now)),
    color: evalResult.color,
    zone: evalResult.zone
  };
}

function zoneBucket(zone) {
  if (zone === 'green') return 'green';
  if (zone === 'yellow') return 'yellow';
  if (zone === 'red') return 'red';
  if (zone === 'overdue') return 'blue';
  if (zone === 'vols') return 'vols';
  return 'blue';
}

function emptyStats() {
  return { green: 0, yellow: 0, red: 0, blue: 0, vols: 0, total: 0 };
}

function buildStats(history) {
  const stats = {
    prz: emptyStats(),
    frz: emptyStats(),
    pkm: emptyStats()
  };

  for (const task of history) {
    const family = getStepFamily(task.type);
    if (!family || !stats[family]) continue;
    const live = liveElapsed(task);
    const bucket = zoneBucket(live.zone || task.zone);
    stats[family][bucket] += 1;
    stats[family].total += 1;
  }

  return stats;
}

function renderTabStats(el, s) {
  el.innerHTML = `
    <span class="pill green" title="зелёные">${s.green}</span>
    <span class="pill yellow" title="жёлтые">${s.yellow}</span>
    <span class="pill red" title="красные">${s.red}</span>
    <span class="pill blue" title="синие (просрочка)">${s.blue}</span>
    ${s.vols ? `<span class="pill vols" title="ВОЛС">${s.vols}</span>` : ''}
  `;
}

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const metaEl = document.getElementById('meta');
  const errorEl = document.getElementById('error');
  const checkResultEl = document.getElementById('checkResult');
  const historyList = document.getElementById('historyList');
  const taskCount = document.getElementById('taskCount');
  const listTitle = document.getElementById('listTitle');
  const tabHint = document.getElementById('tabHint');
  const checkBtn = document.getElementById('checkBtn');
  const helpBtn = document.getElementById('helpBtn');
  const notifyBtn = document.getElementById('notifyBtn');
  const notifyDot = document.getElementById('notifyDot');
  const schemeModal = document.getElementById('schemeModal');
  const schemeTaskTitle = document.getElementById('schemeTaskTitle');
  const schemeCancel = document.getElementById('schemeCancel');
  const schemeSave = document.getElementById('schemeSave');
  const stepTabs = document.getElementById('stepTabs');

  let currentHistory = [];
  let activeTab = 'prz';
  let schemeTaskId = null;
  let notificationsEnabled = true;

  function syncNotifyUi(enabled) {
    notificationsEnabled = enabled !== false;
    if (notifyBtn) {
      notifyBtn.textContent = notificationsEnabled
        ? 'не показывать уведомления'
        : 'показывать уведомления';
    }
    if (notifyDot) {
      notifyDot.classList.toggle('on', notificationsEnabled);
      notifyDot.classList.toggle('off', !notificationsEnabled);
      notifyDot.title = notificationsEnabled
        ? 'Уведомления включены'
        : 'Уведомления выключены';
    }
  }

  function showCheckResult(text, isError = false) {
    if (!text) {
      checkResultEl.hidden = true;
      checkResultEl.textContent = '';
      return;
    }
    checkResultEl.hidden = false;
    checkResultEl.textContent = text;
    checkResultEl.style.background = isError ? '#ffebee' : '#e3f2fd';
    checkResultEl.style.color = isError ? '#c62828' : '#1565c0';
  }

  function filteredTasks() {
    return currentHistory.filter(
      (t) => getStepFamily(t.type) === activeTab
    );
  }

  function updateTabButtons(stats) {
    renderTabStats(document.getElementById('statsPrz'), stats.prz);
    renderTabStats(document.getElementById('statsFrz'), stats.frz);
    renderTabStats(document.getElementById('statsPkm'), stats.pkm);

    for (const btn of stepTabs.querySelectorAll('.tab')) {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    }
  }

  function renderList() {
    const stats = buildStats(currentHistory);
    updateTabButtons(stats);

    const list = filteredTasks();
    const label = TAB_LABELS[activeTab] || activeTab;
    listTitle.textContent = label;
    taskCount.textContent = String(list.length);
    tabHint.textContent =
      activeTab === 'prz'
        ? 'Для ПРЗ схема одна — смена не требуется.'
        : 'Клик по задаче — сменить схему (обычная / радио / ВОЛС).';

    if (!list.length) {
      historyList.innerHTML = `
        <h4>
          <span>${escapeHtml(label)}</span>
          <span class="count-badge">0</span>
        </h4>
        <div class="tab-hint">${escapeHtml(tabHint.textContent)}</div>
        <div class="history-empty">Нет активных задач на шаге ${escapeHtml(label)}</div>
      `;
      return;
    }

    const items = list
      .map((item) => {
        const live = liveElapsed(item);
        const bg = live.color || item.color || '#eee';
        const clickable = item.supportsSchemeSwitch ? 'clickable' : '';
        const hint = item.supportsSchemeSwitch
          ? 'title="Нажмите, чтобы сменить схему"'
          : '';

        return `
          <div class="history-item ${clickable}" data-id="${escapeHtml(item.id)}" ${hint}
               style="background:${escapeHtml(bg)}; border-color:${item.scheme === 'vols' ? '#bdbdbd' : 'transparent'}">
            <span class="type">${escapeHtml(item.type || 'Задача')}</span>
            <div class="title">${escapeHtml(item.title || 'Без названия')}</div>
            ${item.client ? `<div class="client">Клиент: ${escapeHtml(item.client)}</div>` : ''}
            ${item.address ? `<div class="client">Адрес: ${escapeHtml(item.address)}</div>` : ''}
            ${item.date ? `<div class="date">Старт (со стр.): ${escapeHtml(item.date)}</div>` : ''}
            <div class="scheme">Схема: ${escapeHtml(schemeLabel(item.scheme))}</div>
            <div class="timer-row">
              <span class="timer" data-timer-id="${escapeHtml(item.id)}">${escapeHtml(live.label)}</span>
              <span class="pause">${live.paused ? '⏸ пауза (вне раб. времени)' : '▶ раб. время'}</span>
            </div>
          </div>
        `;
      })
      .join('');

    historyList.innerHTML = `
      <h4>
        <span>${escapeHtml(label)}</span>
        <span class="count-badge">${list.length}</span>
      </h4>
      <div class="tab-hint">${escapeHtml(tabHint.textContent)}</div>
      ${items}
    `;
  }

  function renderHistory(history) {
    currentHistory = history || [];
    renderList();
  }

  function tickTimers() {
    const list = filteredTasks();
    list.forEach((item) => {
      const el = historyList.querySelector(
        `[data-timer-id="${CSS.escape(item.id)}"]`
      );
      const row = historyList.querySelector(
        `.history-item[data-id="${CSS.escape(item.id)}"]`
      );
      if (!el || !row) return;
      const live = liveElapsed(item);
      el.textContent = live.label;
      row.style.background = live.color || item.color || '#eee';
      const pauseEl = row.querySelector('.pause');
      if (pauseEl) {
        pauseEl.textContent = live.paused
          ? '⏸ пауза (вне раб. времени)'
          : '▶ раб. время';
      }
    });
    updateTabButtons(buildStats(currentHistory));
  }

  function syncPrimaryButton(response) {
    const mode = response?.runMode || 'idle';
    checkBtn.disabled = false;
    checkBtn.dataset.mode = mode;
    if (mode === 'idle') {
      checkBtn.textContent = 'Запустить';
    } else if (mode === 'warming') {
      const left = Math.max(0, Math.ceil(((response.warmUntil || 0) - Date.now()) / 1000));
      checkBtn.textContent = left > 0 ? `Ожидание… ${left}с` : 'Проверить сейчас';
      checkBtn.disabled = left > 0;
    } else {
      checkBtn.textContent = 'Проверить сейчас';
    }
  }

  function loadStatus() {
    ext.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      if (ext.runtime.lastError || !response) {
        statusEl.textContent = '● Ошибка';
        statusEl.style.background = '#f44336';
        return;
      }

      const mode = response.runMode || 'idle';
      const modeMap = {
        idle: { text: '● Ожидание запуска', color: '#9e9e9e' },
        warming: { text: '● Прогрев вкладок', color: '#ff9800' },
        running: { text: '● Мониторинг', color: '#4caf50' },
        paused: { text: '● Пауза (нет входа?)', color: '#f44336' }
      };
      const st = modeMap[mode] || statusLabel(response.monitorStatus);
      statusEl.textContent = st.text;
      statusEl.style.background = st.color;
      syncPrimaryButton(response);
      syncNotifyUi(response.notificationsEnabled !== false);

      metaEl.innerHTML = `
        <div><strong>Режим:</strong> ${escapeHtml(mode)}</div>
        <div><strong>Последняя проверка:</strong> ${escapeHtml(formatTime(response.lastCheckAt))}</div>
        <div><strong>Активных:</strong> ${escapeHtml(response.activeCount)} · <strong>известно:</strong> ${escapeHtml(response.knownCount)}</div>
        <div><strong>Рабочие часы (сроки):</strong> ${escapeHtml(response.workHours || 'пн–пт 09:00–18:00')}</div>
        <div><strong>Всплывающие уведомления:</strong> ${
          response.notificationsEnabled !== false ? 'вкл' : 'выкл'
        }</div>
        ${
          response.lastCheckMessage
            ? `<div><strong>Результат:</strong> ${escapeHtml(response.lastCheckMessage)}</div>`
            : ''
        }
      `;

      if (response.lastError) {
        errorEl.hidden = false;
        errorEl.textContent = response.lastError;
      } else {
        errorEl.hidden = true;
        errorEl.textContent = '';
      }
    });
  }

  function loadHistory() {
    ext.runtime.sendMessage({ action: 'getHistory' }, (response) => {
      if (ext.runtime.lastError) return;
      renderHistory(response?.history || []);
    });
  }

  stepTabs.addEventListener('click', (event) => {
    const btn = event.target.closest('.tab');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    renderList();
  });

  historyList.addEventListener('click', (event) => {
    const itemEl = event.target.closest('.history-item.clickable');
    if (!itemEl) return;
    const id = itemEl.getAttribute('data-id');
    const task = currentHistory.find((t) => t.id === id);
    if (!task) return;

    schemeTaskId = id;
    schemeTaskTitle.textContent = task.title || id;
    const current = task.scheme || 'default';
    for (const input of schemeModal.querySelectorAll('input[name="scheme"]')) {
      input.checked = input.value === current;
    }
    schemeModal.classList.add('open');
  });

  schemeCancel.addEventListener('click', () => {
    schemeModal.classList.remove('open');
    schemeTaskId = null;
  });

  schemeSave.addEventListener('click', () => {
    const selected = schemeModal.querySelector('input[name="scheme"]:checked');
    if (!schemeTaskId || !selected) return;

    ext.runtime.sendMessage(
      { action: 'setScheme', taskId: schemeTaskId, scheme: selected.value },
      () => {
        schemeModal.classList.remove('open');
        schemeTaskId = null;
        loadHistory();
      }
    );
  });

  async function openThreeDashboardsFromPopup() {
    const opened = [];
    const usedIds = new Set();

    for (const dash of DASHBOARDS) {
      const existing = await ext.tabs.query({
        url: 'https://workplace.ertelecom.ru/*'
      });
      let tab = existing.find((t) => {
        if (usedIds.has(t.id)) return false;
        const href = `${t.url || ''} ${t.pendingUrl || ''}`;
        return extractDashboardId(href) === dash.id;
      });

      if (tab) {
        // Всегда выставляем точный URL дашборда (4002 / 4003 / 4004)
        tab = await ext.tabs.update(tab.id, {
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

      if (!tab?.id) {
        throw new Error(`Не удалось открыть ${dash.label} (${dash.id})`);
      }

      usedIds.add(tab.id);
      opened.push({
        key: dash.key,
        label: dash.label,
        url: dash.url,
        tabId: tab.id
      });
    }

    // НЕ активируем вкладку здесь — иначе popup закроется до startMonitor
    return opened;
  }

  function sendStartMonitor(opened) {
    return new Promise((resolve) => {
      ext.runtime.sendMessage(
        { action: 'startMonitor', tabsOpenedByPopup: true, opened },
        (response) => {
          resolve({
            err: ext.runtime.lastError,
            response
          });
        }
      );
    });
  }

  if (notifyBtn) {
    notifyBtn.addEventListener('click', () => {
      const next = !notificationsEnabled;
      notifyBtn.disabled = true;
      ext.runtime.sendMessage(
        { action: 'setNotificationsEnabled', enabled: next },
        (response) => {
          notifyBtn.disabled = false;
          if (ext.runtime.lastError) {
            showCheckResult(
              `Не удалось сменить уведомления: ${ext.runtime.lastError.message}`,
              true
            );
            return;
          }
          syncNotifyUi(
            typeof response?.notificationsEnabled === 'boolean'
              ? response.notificationsEnabled
              : next
          );
          showCheckResult(
            response?.message ||
              (next ? 'Уведомления включены' : 'Уведомления выключены')
          );
        }
      );
    });
  }

  checkBtn.addEventListener('click', () => {
    checkBtn.disabled = true;
    const mode = checkBtn.dataset.mode || 'idle';
    const isStart = mode === 'idle';

    if (isStart) {
      checkBtn.textContent = 'Запуск…';
      showCheckResult('Открываю 3 вкладки: ПРЗ(4002), ФРЗ(4003), ПКМ(4004)…');
      (async () => {
        try {
          const opened = await openThreeDashboardsFromPopup();
          const labels = opened.map((o) => `${o.label}:${o.url.split('/').pop()}`).join(', ');
          showCheckResult(`Вкладки: ${labels}. Включаю прогрев…`);

          // Сначала фон (пока popup ещё жив), потом фокус на вкладку
          const { err, response } = await sendStartMonitor(opened);

          if (opened[0]?.tabId != null) {
            try {
              await ext.tabs.update(opened[0].tabId, { active: true });
            } catch (_) {
              /* ignore */
            }
          }

          loadStatus();
          loadHistory();

          if (err) {
            showCheckResult(
              `Вкладки открыты (${opened.length}), но фон не ответил: ${err.message}`,
              true
            );
            checkBtn.disabled = false;
            checkBtn.textContent = 'Запустить';
            checkBtn.dataset.mode = 'idle';
            return;
          }
          if (!response || response.ok === false) {
            showCheckResult(
              response?.message || response?.error || 'Фон не принял запуск',
              true
            );
            checkBtn.disabled = false;
            checkBtn.textContent = 'Запустить';
            checkBtn.dataset.mode = 'idle';
            return;
          }
          showCheckResult(
            response.message ||
              `Открыто: ${opened.length}. Ждите 1 минуту до первой проверки.`
          );
        } catch (e) {
          showCheckResult(`Не удалось открыть вкладки: ${e.message || e}`, true);
          checkBtn.disabled = false;
          checkBtn.textContent = 'Запустить';
          checkBtn.dataset.mode = 'idle';
        }
      })();
      return;
    }

    checkBtn.textContent = 'Проверка...';
    showCheckResult('Проверяю вкладки 4002/4003/4004, затем снимаю данные…');
    ext.runtime.sendMessage({ action: 'manualCheck' }, (response) => {
      const err = ext.runtime.lastError;
      loadStatus();
      loadHistory();
      checkBtn.disabled = false;
      if (err) {
        showCheckResult(`Ошибка: ${err.message}`, true);
        return;
      }
      showCheckResult(
        response?.message ||
          `Найдено активных: ${response?.total ?? 0}, новых: ${response?.newCount ?? 0}`,
        response?.ok === false || response?.needLogin
      );
    });
  });

  helpBtn.addEventListener('click', () => {
    ext.tabs.create({ url: ext.runtime.getURL('help.html') });
  });

  loadStatus();
  loadHistory();
  setInterval(() => {
    loadStatus();
    loadHistory();
  }, 5000);
  setInterval(tickTimers, 1000);
});
