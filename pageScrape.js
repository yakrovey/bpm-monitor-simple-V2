/**
 * Точка входа для executeScript (после gridScrapeInject.js).
 */
export async function pageFindTasks() {
  const fn = globalThis.__bpmCollectTasks;
  if (typeof fn !== 'function') {
    return { tasks: [], pagerTotal: null, hidden: true };
  }
  return fn();
}
