import { evaluateTimer, getStepFamily } from './timerEngine.js';
import {
  formatBusinessDuration,
  businessMsBetween,
  isWorkTime
} from './businessTime.js';

const TARGET_URL =
  'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/RESPONSIVE_WORK';

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
  const openBtn = document.getElementById('openBtn');
  const helpBtn = document.getElementById('helpBtn');
  const schemeModal = document.getElementById('schemeModal');
  const schemeTaskTitle = document.getElementById('schemeTaskTitle');
  const schemeCancel = document.getElementById('schemeCancel');
  const schemeSave = document.getElementById('schemeSave');
  const stepTabs = document.getElementById('stepTabs');

  let currentHistory = [];
  let activeTab = 'prz';
  let schemeTaskId = null;

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

  function loadStatus() {
    chrome.runtime.sendMessage({ action: 'getStatus' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        statusEl.textContent = '● Ошибка';
        statusEl.style.background = '#f44336';
        return;
      }

      const st = statusLabel(response.monitorStatus);
      statusEl.textContent = st.text;
      statusEl.style.background = st.color;

      metaEl.innerHTML = `
        <div><strong>Последняя проверка:</strong> ${escapeHtml(formatTime(response.lastCheckAt))}</div>
        <div><strong>Активных:</strong> ${escapeHtml(response.activeCount)} · <strong>известно:</strong> ${escapeHtml(response.knownCount)}</div>
        <div><strong>Сбор статуса:</strong> всегда · <strong>Уведомления:</strong> ${
          response.notificationsEnabled
            ? 'сейчас включены'
            : 'на паузе (вне раб. времени)'
        }</div>
        <div><strong>Рабочие часы:</strong> ${escapeHtml(response.workHours || 'пн–пт 09:00–18:00')}</div>
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
    chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
      if (chrome.runtime.lastError) return;
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

    chrome.runtime.sendMessage(
      { action: 'setScheme', taskId: schemeTaskId, scheme: selected.value },
      () => {
        schemeModal.classList.remove('open');
        schemeTaskId = null;
        loadHistory();
      }
    );
  });

  checkBtn.addEventListener('click', () => {
    const original = checkBtn.textContent;
    checkBtn.textContent = 'Проверка...';
    checkBtn.disabled = true;
    showCheckResult('Идёт проверка страницы BPM, подождите…');

    chrome.runtime.sendMessage({ action: 'manualCheck' }, (response) => {
      const err = chrome.runtime.lastError;
      loadStatus();
      loadHistory();
      checkBtn.disabled = false;

      if (err) {
        checkBtn.textContent = 'Ошибка';
        showCheckResult(err.message, true);
      } else if (!response || response.ok === false) {
        checkBtn.textContent = 'Ошибка';
        showCheckResult(
          response?.message || response?.error || 'Проверка не удалась',
          true
        );
      } else {
        checkBtn.textContent = 'Готово';
        showCheckResult(
          response.message ||
            `Найдено активных: ${response.total ?? 0}, новых: ${response.newCount ?? 0}`
        );
      }

      setTimeout(() => {
        checkBtn.textContent = original;
      }, 2000);
    });
  });

  openBtn.addEventListener('click', async () => {
    const tabs = await chrome.tabs.query({
      url: 'https://workplace.ertelecom.ru/ProcessPortal/dashboards/*'
    });
    if (tabs[0]) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) {
        await chrome.windows.update(tabs[0].windowId, { focused: true });
      }
      return;
    }
    await chrome.tabs.create({ url: TARGET_URL, active: true });
  });

  helpBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('help.html') });
  });

  loadStatus();
  loadHistory();
  setInterval(() => {
    loadStatus();
    loadHistory();
  }, 5000);
  setInterval(tickTimers, 1000);
});
