// Content script — парсинг задач на workplace.ertelecom.ru (локально).

const ext = globalThis.browser ?? globalThis.chrome;

async function collectTasksOnPage() {
  const fn = globalThis.__bpmCollectTasks;
  if (typeof fn !== 'function') {
    return { tasks: [], excludedInstances: [], pagerTotal: null, hidden: document.hidden };
  }
  return fn();
}

ext.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action !== 'getTasks' && request.action !== 'manualCheck') {
    return false;
  }

  collectTasksOnPage().then((result) => {
    const tasks = result.tasks || [];
    console.debug(`📤 V2: найдено задач в фрейме: ${tasks.length}`, location.href);

    ext.runtime.sendMessage(
      {
        action: 'frameTasks',
        tasks,
        excludedInstances: result.excludedInstances || [],
        pagerTotal: result.pagerTotal ?? null,
        href: location.href,
        source: result.source || 'none',
        domCount: result.domCount || 0,
        modelCount: result.modelCount || 0,
        softRefreshOk: Boolean(result.softRefreshOk)
      },
      () => {
        void ext.runtime.lastError;
      }
    );

    sendResponse({
      status: 'ok',
      tasks,
      excludedInstances: result.excludedInstances || [],
      pagerTotal: result.pagerTotal ?? null,
      href: location.href,
      source: result.source || 'none',
      domCount: result.domCount || 0,
      modelCount: result.modelCount || 0,
      softRefreshOk: Boolean(result.softRefreshOk)
    });
  });

  return true;
});

// Список задач обновляет только background (alarm / «Проверить сейчас») — полный scrape
// с merge вкладок. Прямой push из content давал неполные снимки и рассинхрон.

console.debug('✅ Content V2 готов:', location.href);
