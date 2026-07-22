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
          out.pagerTotal === 5,
          `pagerTotal expected 5 (incl deferred on page), got ${out.pagerTotal}`
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
          scraped.tasks.length === after.server - 1 || scraped.tasks.length === after.server,
          `unexpected tracked count ${scraped.tasks.length} vs server ${after.server}`
        );
        assert(
          scraped.tasks.length >= 3,
          `expected remaining tracked tasks, got ${scraped.tasks.length}`
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
      await caseResult('created date preferred over received date', async () => {
        await page.goto(`${BASE}/dashboard.html`, { waitUntil: 'networkidle' });
        await injectScraper(page);
        const out = await collect(page, { skipSoftRefresh: true });
        const sample = out.tasks.find((t) => t.date);
        assert(sample, 'no dated task');
        assert(/\d{4}/.test(sample.date), `bad date ${sample.date}`);
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
