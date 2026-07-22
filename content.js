// Content script — парсинг задач на workplace.ertelecom.ru (локально).

const ext = globalThis.browser ?? globalThis.chrome;

async function collectTasksOnPage() {
  const fn = globalThis.__bpmCollectTasks;
  if (typeof fn !== 'function') return { tasks: [], pagerTotal: null, hidden: document.hidden };
  return fn();
}

ext.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action !== 'getTasks' && request.action !== 'manualCheck') {
    return false;
  }

  collectTasksOnPage().then((result) => {
    const tasks = result.tasks || [];
    console.log(`📤 V2: найдено задач в фрейме: ${tasks.length}`, location.href);

    ext.runtime.sendMessage(
      {
        action: 'frameTasks',
        tasks,
        pagerTotal: result.pagerTotal ?? null,
        href: location.href
      },
      () => {
        void ext.runtime.lastError;
      }
    );

    sendResponse({
      status: 'ok',
      tasks,
      pagerTotal: result.pagerTotal ?? null,
      href: location.href
    });
  });

  return true;
});

// Список задач обновляет только background (alarm / «Проверить сейчас») — полный scrape
// с merge вкладок. Прямой push из content давал неполные снимки и рассинхрон.

console.log('✅ Content V2 готов:', location.href);
