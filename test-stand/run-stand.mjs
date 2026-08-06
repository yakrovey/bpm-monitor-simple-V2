/**
 * Виртуальный стенд: поднимает mock BPM, гоняет scrape + soft-refresh сценарии.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from './server-lib.mjs';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.STAND_PORT || 4177);
const BASE = `http://127.0.0.1:${PORT}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function injectScraper(page) {
  await page.addScriptTag({ url: `${BASE}/ext/gridScrapeInject.js` });
  await page.waitForFunction(() => typeof globalThis.__bpmCollectTasks === 'function');
}

async function collect(page, options = {}) {
  return page.evaluate(async (opts) => {
    return globalThis.__bpmCollectTasks(opts);
  }, options);
}

function caseResult(name, fn) {
  return (async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (err) {
      return { name, ok: false, error: String(err && err.message ? err.message : err) };
    }
  })();
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`BPM virtual stand: ${BASE}/`);

  const results = [];
  let browser;

  try {
    const timersExit = await new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(__dirname, 'run-timers.mjs')], {
        cwd: __dirname,
        stdio: 'inherit'
      });
      p.on('exit', (code) => resolve(code ?? 1));
    });
    results.push({
      name: 'timerEngine unit suite',
      ok: timersExit === 0,
      error: timersExit === 0 ? undefined : `exit ${timersExit}`
    });

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
    await injectScraper(page);

    results.push(
      await caseResult('scrape collects PRZ/FRZ/PKM and skips deferred', async () => {
        const out = await collect(page, { skipSoftRefresh: true });
        const titles = (out.tasks || []).map((t) => t.title);
        assert(out.tasks.length >= 4, `expected >=4 tasks, got ${out.tasks.length}`);
        assert(
          titles.every((t) => /прз|фрз|пкм/i.test(t)),
          'non-target titles leaked'
        );
        assert(
          !titles.some((t) => /отложен/i.test(t)),
          'deferred task should be skipped'
        );
        assert(
          out.pagerTotal === 7,
          `pagerTotal expected 7 (incl deferred on page), got ${out.pagerTotal}`
        );
        assert(
          titles.some((t) => /подключен/i.test(t)),
          'ПКМ: Подключение should be scraped'
        );
        assert(
          out.tasks.some((t) => /дроп/i.test(t.sos || '')),
          'ДРОП SOS should be on a FRZ task'
        );
        assert(
          !out.tasks.some((t) => /дроп/i.test(t.client || '')),
          'ДРОП must not become client'
        );
      })
    );

    results.push(
      await caseResult('SOS not used as client when columns correct', async () => {
        const out = await collect(page, { skipSoftRefresh: true });
        const liga = out.tasks.find((t) => /ЛИГА/i.test(t.instanceName || t.client || ''));
        assert(liga, 'ЛИГА task missing');
        assert(
          !/медн|волс|кабел/i.test(liga.client || ''),
          `client looks like SOS: ${liga.client}`
        );
        assert(/медн|кабел/i.test(liga.sos || ''), `sos missing: ${liga.sos}`);
      })
    );

    results.push(
      await caseResult('corrupt SOS-as-instanceName is not treated as client org', async () => {
        await page.evaluate(() => window.__stand.corruptSos());
        const out = await collect(page, { skipSoftRefresh: true });
        const bad = out.tasks.find(
          (t) =>
            (t.instanceName || '') === 'Медный кабель' ||
            (t.client || '') === 'Медный кабель'
        );
        if (bad) {
          assert(
            !bad.client || !/медн|кабел/i.test(bad.client),
            `client still SOS label: ${bad.client}`
          );
        }
      })
    );

    results.push(
      await caseResult('ghost FRZ with title/date/SOS but no identity is discarded', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        await page.evaluate(() => window.__stand.addGhostFrz());
        const out = await collect(page, { skipSoftRefresh: true });
        const ghosts = out.tasks.filter(
          (t) =>
            /фрз/i.test(t.title || '') &&
            !String(t.instanceName || '').trim() &&
            !String(t.client || '').trim() &&
            !String(t.address || '').trim()
        );
        assert(ghosts.length === 0, `ghost FRZ leaked: ${JSON.stringify(ghosts)}`);
      })
    );

    results.push(
      await caseResult('deferred rows are exposed as excluded instances', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        const out = await collect(page, { skipSoftRefresh: true });
        assert(
          Array.isArray(out.excludedInstances) && out.excludedInstances.length > 0,
          'excludedInstances missing'
        );
        assert(
          out.excludedInstances.some((name) => /ООО СКИП/i.test(name)),
          `deferred instance not exposed: ${JSON.stringify(out.excludedInstances)}`
        );
      })
    );

    results.push(
      await caseResult('address abbreviations do not leak into client name', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        await page.evaluate(() => {
          const viewport = document.getElementById('viewport');
          const row = document.createElement('div');
          row.className = 'taskGridRow ng-scope';
          row.innerHTML = `
            <div class="ui-grid-cell ui-grid-col-0">ФРЗ: Финальный расчет затрат</div>
            <div class="ui-grid-cell ui-grid-col-1">Санкт-Петербург, Большой В.О., Пр-Кт, 55. СПБ ГУП "АТС Смольного"</div>
            <div class="ui-grid-cell ui-grid-col-2">Медный кабель</div>
            <div class="ui-grid-cell ui-grid-col-3">29 июля 2026 г., 13:16:39</div>
            <div class="ui-grid-cell ui-grid-col-4">29 июля 2026 г., 13:10:00</div>
          `;
          viewport.prepend(row);
        });
        const out = await collect(page, { skipSoftRefresh: true });
        const task = out.tasks.find((t) => /Смольного/i.test(t.instanceName || ''));
        assert(task, 'abbreviation task missing');
        assert(task.client === 'СПБ ГУП "АТС Смольного"', `bad client: ${task.client}`);
        assert(
          task.address === 'Санкт-Петербург, Большой В.О., Пр-Кт, 55',
          `bad address: ${task.address}`
        );
      })
    );

    results.push(
      await caseResult('stale mode: soft refresh does not sync until real refresh', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        await page.evaluate(() => {
          window.__stand.setStaleMode(true);
          window.__stand.completeOldest();
        });
        const before = await page.evaluate(() => ({
          page: window.__stand.getPageTasks().length,
          server: window.__stand.getServerTasks().length
        }));
        assert(before.page > before.server, 'page should still show completed task');

        await page.evaluate(async () => {
          await globalThis.__bpmSoftRefreshDashboard(true);
        });
        const mid = await page.evaluate(() => window.__stand.getPageTasks().length);
        assert(mid === before.page, `stale soft-refresh changed page size ${before.page}→${mid}`);

        await page.evaluate(() => {
          window.__stand.setStaleMode(false);
          window.__stand.softRefreshFromServer();
        });
        const after = await page.evaluate(() => ({
          page: window.__stand.getPageTasks().length,
          server: window.__stand.getServerTasks().length
        }));
        assert(after.page === after.server, 'after refresh page/server mismatch');

        const scraped = await collect(page, { skipSoftRefresh: true });
        assert(
          scraped.tasks.length >= 3,
          `expected remaining tracked tasks, got ${scraped.tasks.length} (server ${after.server})`
        );
      })
    );

    results.push(
      await caseResult('search Enter (empty) soft-reloads dashboard', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        await page.evaluate(() => {
          window.__stand.setStaleMode(true);
          window.__stand.completeOldest();
        });
        const before = await page.evaluate(() => window.__stand.getPageTasks().length);
        await page.evaluate(() => window.__stand.setStaleMode(false));

        const soft = await page.evaluate(async () =>
          globalThis.__bpmSoftRefreshDashboard(true)
        );
        assert(soft.searchEnter === true, `searchEnter not used: ${JSON.stringify(soft)}`);

        const after = await page.evaluate(() => ({
          page: window.__stand.getPageTasks().length,
          server: window.__stand.getServerTasks().length
        }));
        assert(after.page === after.server, 'Enter search did not sync page to server');
        assert(after.page < before, 'completed task should disappear after Enter refresh');
      })
    );

    results.push(
      await caseResult('soft refresh from hidden page calls refresh path', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        await page.evaluate(() => {
          Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => true
          });
          window.__stand.setStaleMode(false);
          window.__stand.addPrz();
        });
        const soft = await page.evaluate(async () =>
          globalThis.__bpmSoftRefreshDashboard(true)
        );
        assert(
          soft && soft.skipped === false,
          `soft refresh skipped unexpectedly: ${JSON.stringify(soft)}`
        );
        assert(
          (soft.clicked || 0) + (soft.called || 0) > 0 || soft.searchEnter === true,
          `no refresh action taken: ${JSON.stringify(soft)}`
        );
      })
    );

    results.push(
      await caseResult('received date preferred over created date for timer', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        const out = await collect(page, { skipSoftRefresh: true });
        const liga = out.tasks.find((t) => /ЛИГА/i.test(t.instanceName || t.client || ''));
        assert(liga, 'ЛИГА task missing');
        assert(liga.date, 'date missing');
        const pageDates = await page.evaluate(() => {
          const row = [...document.querySelectorAll('.taskGridRow')].find((r) =>
            /ЛИГА/i.test(r.textContent || '')
          );
          const cells = row ? [...row.querySelectorAll('.ui-grid-cell')].map((c) => c.textContent.trim()) : [];
          return { received: cells[3] || '', created: cells[4] || '' };
        });
        assert(pageDates.received, 'received cell empty');
        assert(
          liga.date === pageDates.received,
          `timer date should be received (${pageDates.received}), got ${liga.date} (created=${pageDates.created})`
        );
      })
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
  }

  const failed = results.filter((r) => !r.ok);
  const report = {
    suite: 'virtual-stand',
    at: new Date().toISOString(),
    base: BASE,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    bugs: failed.map((f) => ({
      id: f.name,
      severity: 'high',
      summary: f.error
    }))
  };

  const outPath = path.join(__dirname, 'reports', 'stand-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== Virtual stand report ===');
  console.log(`${report.passed}/${report.total} passed`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} · ${r.name}${r.error ? ' · ' + r.error : ''}`);
  }
  if (failed.length) {
    console.log('\nBugs:');
    for (const b of report.bugs) console.log(`- ${b.id}: ${b.summary}`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
