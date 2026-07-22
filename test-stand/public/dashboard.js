/**
 * Виртуальный дашборд BPM: имитирует грид и «заморозку» данных в фоне.
 */
(function () {
  const viewport = document.getElementById('viewport');
  const pager = document.getElementById('pager');
  const meta = document.getElementById('meta');
  const logEl = document.getElementById('log');

  /** true = poll/refresh не обновляют список (как неактивное окно BPM) */
  let staleMode = false;
  let seq = 1;

  /** Источник истины «сервера» */
  let serverTasks = [];
  /** То, что видит страница (может отставать в staleMode) */
  let pageTasks = [];

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`;
    logEl.textContent = `${line}\n${logEl.textContent}`.slice(0, 4000);
    console.log(line);
  }

  function fmtRu(ts) {
    const d = new Date(ts);
    const months = [
      'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
      'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'
    ];
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getDate()} ${months[d.getMonth()]}. ${d.getFullYear()} г., ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function makeTask({ title, client, address, sos, createdOffsetMin }) {
    const id = `T${seq++}`;
    const createdAt = Date.now() - (createdOffsetMin || 30) * 60 * 1000;
    const instanceName = `Подключение «${client}» по ТЭО. ${address}`;
    return {
      id,
      title,
      instanceName,
      client,
      address,
      sos: sos || '',
      createdAt,
      receivedAt: createdAt + 60 * 1000
    };
  }

  function seed() {
    serverTasks = [
      makeTask({
        title: 'ПРЗ: Валидация предварительного расчета затрат',
        client: 'ООО ЛИГА',
        address: 'Санкт-Петербург, Большая Морская, 18',
        sos: 'Медный кабель',
        createdOffsetMin: 120
      }),
      makeTask({
        title: 'ПКМ: Координация',
        client: 'АО ТЕСТ',
        address: 'Санкт-Петербург, Мебельная, 12',
        sos: 'ВОЛС',
        createdOffsetMin: 90
      }),
      makeTask({
        title: 'ФРЗ: Финальный расчет затрат',
        client: 'ООО РАДИО',
        address: 'Санкт-Петербург, Невский, 1',
        sos: 'P2P радио',
        createdOffsetMin: 200
      }),
      makeTask({
        title: 'ПКМ: Состояние НМУ КРУС',
        client: 'ИП Монтаж',
        address: 'Санкт-Петербург, Садовая, 5',
        sos: 'Медный кабель',
        createdOffsetMin: 40
      }),
      makeTask({
        title: 'Управление отложенной заявкой',
        client: 'ООО СКИП',
        address: 'Санкт-Петербург, Литейный, 2',
        sos: '',
        createdOffsetMin: 10
      })
    ];
    pageTasks = serverTasks.map((t) => ({ ...t }));
    render();
    log(`Seed: ${serverTasks.length} задач на «сервере»`);
  }

  function render() {
    viewport.innerHTML = '';
    pageTasks.forEach((task) => {
      const row = document.createElement('div');
      row.className = 'taskGridRow ng-scope';
      row.dataset.id = task.id;
      row.innerHTML = `
        <div class="ui-grid-cell ui-grid-col-0">${escapeHtml(task.title)}</div>
        <div class="ui-grid-cell ui-grid-col-1">${escapeHtml(task.instanceName)}</div>
        <div class="ui-grid-cell ui-grid-col-2">${escapeHtml(task.sos || '')}</div>
        <div class="ui-grid-cell ui-grid-col-3">${escapeHtml(fmtRu(task.receivedAt))}</div>
        <div class="ui-grid-cell ui-grid-col-4">${escapeHtml(fmtRu(task.createdAt))}</div>
      `;
      viewport.appendChild(row);
    });
    const n = pageTasks.length;
    pager.textContent = n ? `1–${n} of ${n}` : '0–0 of 0';
    meta.textContent = `На странице: ${n} · на сервере: ${serverTasks.length} · staleMode=${staleMode} · hidden=${document.hidden}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function softRefreshFromServer() {
    if (staleMode) {
      log('Refresh проигнорирован (staleMode / неактивное окно)');
      return false;
    }
    // Как в Angular ui-grid: мутируем тот же массив, не переназначаем ссылку
    pageTasks.length = 0;
    for (const t of serverTasks) pageTasks.push({ ...t });
    render();
    log(`Refresh: страница синхронизирована (${pageTasks.length})`);
    return true;
  }

  // Minimal Angular-like surface for soft-refresh probes
  window.angular = {
    element(el) {
      return {
        scope() {
          return {
            gridOptions: { data: pageTasks, totalItems: pageTasks.length },
            gridApi: {
              grid: { rows: pageTasks.map((entity) => ({ entity })) },
              core: {
                refresh() {
                  softRefreshFromServer();
                }
              }
            },
            refresh() {
              softRefreshFromServer();
            },
            refreshTasks() {
              softRefreshFromServer();
            },
            $parent: null
          };
        }
      };
    }
  };

  document.getElementById('btnRefresh').addEventListener('click', () => {
    softRefreshFromServer();
  });

  const searchInput = document.getElementById('searchInput');
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      // Как на реальном BPM: Enter в поиске (даже пустом) перезагружает дашборд
      softRefreshFromServer();
      log(`Search Enter (value="${searchInput.value}") → soft reload`);
    }
  });

  document.getElementById('btnAddPrz').addEventListener('click', () => {
    serverTasks.unshift(
      makeTask({
        title: 'ПРЗ: Предварительный расчет затрат',
        client: `ООО НОВАЯ ${seq}`,
        address: 'Санкт-Петербург, Тестовая, 1',
        sos: 'Медный кабель',
        createdOffsetMin: 5
      })
    );
    if (!staleMode) softRefreshFromServer();
    else {
      render();
      log('Сервер +1 ПРЗ, страница не обновлена (stale)');
    }
  });

  document.getElementById('btnAddPkm').addEventListener('click', () => {
    serverTasks.unshift(
      makeTask({
        title: 'ПКМ: Координация',
        client: `ООО ПКМ ${seq}`,
        address: 'Санкт-Петербург, Заячья, 3',
        sos: 'ВОЛС',
        createdOffsetMin: 15
      })
    );
    if (!staleMode) softRefreshFromServer();
    else log('Сервер +1 ПКМ, страница stale');
  });

  document.getElementById('btnAddFrz').addEventListener('click', () => {
    serverTasks.unshift(
      makeTask({
        title: 'ФРЗ: Финальный расчет затрат',
        client: `ООО ФРЗ ${seq}`,
        address: 'Санкт-Петербург, Фрунзе, 7',
        sos: 'P2MP',
        createdOffsetMin: 50
      })
    );
    if (!staleMode) softRefreshFromServer();
    else log('Сервер +1 ФРЗ, страница stale');
  });

  document.getElementById('btnCompleteOldest').addEventListener('click', () => {
    if (!serverTasks.length) return;
    const done = serverTasks.pop();
    log(`Отработана на сервере: ${done.client}`);
    if (!staleMode) softRefreshFromServer();
    else {
      render();
      log('Страница всё ещё показывает отработанную (stale)');
    }
  });

  document.getElementById('btnCorruptSos').addEventListener('click', () => {
    // Имитация бага смещения колонок: в instanceName кладём только СОС
    if (!pageTasks[0]) return;
    pageTasks[0] = {
      ...pageTasks[0],
      instanceName: pageTasks[0].sos || 'Медный кабель'
    };
    render();
    log('Испорчена первая строка: instanceName = СОС');
  });

  document.getElementById('btnStaleMode').addEventListener('click', () => {
    staleMode = !staleMode;
    meta.textContent = `staleMode=${staleMode}`;
    log(`staleMode → ${staleMode}`);
  });

  document.getElementById('btnHiddenSim').addEventListener('click', () => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true
    });
    log('document.hidden принудительно true');
    render();
  });

  // API для автотестов
  window.__stand = {
    seed,
    softRefreshFromServer,
    getServerTasks: () => serverTasks.map((t) => ({ ...t })),
    getPageTasks: () => pageTasks.map((t) => ({ ...t })),
    setStaleMode: (v) => {
      staleMode = Boolean(v);
    },
    completeOldest: () => {
      document.getElementById('btnCompleteOldest').click();
    },
    addPrz: () => document.getElementById('btnAddPrz').click(),
    corruptSos: () => document.getElementById('btnCorruptSos').click()
  };

  seed();
})();
