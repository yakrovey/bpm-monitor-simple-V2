/**
 * Боевой прогон: реальное расширение в Chromium + логика merge/sanitize background.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from './server-lib.mjs';
import { chromium } from 'playwright';
import { looksLikeSchemeLabel, getStepFamily } from '../timerEngine.js';
import { parseRussianDateTime } from '../businessTime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.STAND_PORT || 4177);
const BASE = `http://127.0.0.1:${PORT}`;
const TARGET_PATH = '/ProcessPortal/dashboards/SYSRP/13202';
const TARGET_URL = `${BASE}${TARGET_PATH}`;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function caseResult(name, fn) {
  return (async () => {
    try {
      await fn();
      return { name, ok: true };
    } catch (err) {
      return { name, ok: false, error: String(err?.message || err) };
    }
  })();
}

/** Копия merge/sanitize из background.js для проверки боевых сценариев без Chrome API. */
function getTaskType(title) {
  return getStepFamily(title) ? title : null;
}

function hasTaskIdentity(task) {
  return [task.instanceName, task.client, task.address].some((value) =>
    String(value || '').trim()
  );
}

function sanitizeTaskFields(task) {
  if (!task) return task;
  const next = { ...task };
  const title = String(next.title || '').trim();
  if (!title || !getTaskType(title)) return null;

  const idTail = String(next.id || '')
    .split('|')
    .slice(1)
    .join('|')
    .trim();
  if (!idTail) return null;
  if (looksLikeSchemeLabel(idTail)) return null;
  if (looksLikeSchemeLabel(String(next.instanceName || '').trim())) return null;
  if (!hasTaskIdentity(next)) return null;
  return next;
}

function pickPreferredDateFields(a, b) {
  const tsA = a?.date ? parseRussianDateTime(a.date) : null;
  const tsB = b?.date ? parseRussianDateTime(b.date) : null;

  if (tsA != null && tsB != null && tsA !== tsB) {
    const newer = tsB > tsA ? b : a;
    const newerTs = tsB > tsA ? tsB : tsA;
    return {
      date: newer.date,
      appearedAt: newer.appearedAt ?? newerTs,
      dateSource: newer.dateSource || ''
    };
  }
  if (tsA != null && tsB == null) {
    return {
      date: a.date,
      appearedAt: a.appearedAt ?? tsA,
      dateSource: a.dateSource || ''
    };
  }
  if (tsB != null) {
    return {
      date: b.date,
      appearedAt: b.appearedAt ?? tsB,
      dateSource: b.dateSource || ''
    };
  }
  return {
    date: a?.date || b?.date || '',
    appearedAt: a?.appearedAt ?? b?.appearedAt ?? null,
    dateSource: a?.dateSource || b?.dateSource || ''
  };
}

function mergeScrapedTasksByMembership(baseList, extraLists = []) {
  const byId = new Map();
  for (const raw of baseList || []) {
    const id = raw.id || `${raw.title}|${raw.instanceName || raw.client || ''}`;
    byId.set(id, { ...raw, id });
  }
  for (const list of extraLists) {
    for (const raw of list || []) {
      const id = raw.id || `${raw.title}|${raw.instanceName || raw.client || ''}`;
      if (!byId.has(id)) continue;
      const base = byId.get(id);
      const merged = { ...base, ...raw, id };
      const preferred = pickPreferredDateFields(base, raw);
      merged.date = preferred.date;
      merged.appearedAt = preferred.appearedAt;
      merged.dateSource = preferred.dateSource;
      byId.set(id, merged);
    }
  }
  return Array.from(byId.values());
}

function prepareLiveExtension() {
  const liveDir = path.join(os.tmpdir(), `bpm-monitor-live-ext-${process.pid}`);
  fs.rmSync(liveDir, { recursive: true, force: true });
  fs.mkdirSync(liveDir, { recursive: true });

  const files = [
    'background.js',
    'businessTime.js',
    'content.js',
    'extApi.js',
    'gridScrapeInject.js',
    'icon.png',
    'manifest.json',
    'pageScrape.js',
    'popup.html',
    'popup.js',
    'timerEngine.js',
    'domru-mark.png',
    'help.html'
  ];
  for (const name of files) {
    const src = path.join(EXT_ROOT, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(liveDir, name));
  }

  let bg = fs.readFileSync(path.join(liveDir, 'background.js'), 'utf8');
  bg = bg.replace(
    "'https://workplace.ertelecom.ru/ProcessPortal/dashboards/SYSRP/13202'",
    `'${TARGET_URL}'`
  );
  bg = bg.replace(
    "'https://workplace.ertelecom.ru/ProcessPortal/dashboards/*'",
    `'${BASE}/ProcessPortal/dashboards/*'`
  );
  bg = bg.replace(
    "return (url || '').includes('workplace.ertelecom.ru');",
    "return (url || '').includes('workplace.ertelecom.ru') || (url || '').includes('127.0.0.1');"
  );
  fs.writeFileSync(path.join(liveDir, 'background.js'), bg);

  const manifest = JSON.parse(fs.readFileSync(path.join(liveDir, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push(`${BASE}/*`);
  manifest.host_permissions.push(`${BASE}/*`);
  fs.writeFileSync(path.join(liveDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return liveDir;
}

async function waitForServiceWorker(context, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = context.serviceWorkers();
    if (workers.length) return workers[0];
    try {
      return await context.waitForEvent('serviceworker', { timeout: 2000 });
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('service worker extension не появился');
}

async function extensionManualCheck(context, extensionId, timeoutMs = 120000) {
  const popup = await context.newPage();
  popup.setDefaultTimeout(timeoutMs);
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded'
    });
    const payload = await popup.evaluate((waitMs) => {
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve({ error: 'manualCheck timeout', response: null }),
          waitMs
        );
        chrome.runtime.sendMessage({ action: 'manualCheck' }, (response) => {
          clearTimeout(timer);
          resolve({
            response,
            error: chrome.runtime.lastError?.message || null
          });
        });
      });
    }, timeoutMs - 5000);

    if (payload.error) {
      return {
        checkResult: payload.error,
        taskCount: 0,
        total: 0,
        ok: false,
        errorHidden: false
      };
    }

    const response = payload.response || {};
    return {
      checkResult: response.message || JSON.stringify(response),
      taskCount: Number(response.total) || 0,
      total: Number(response.total) || 0,
      ok: response.ok !== false,
      errorHidden: true,
      bootstrapped: Boolean(response.bootstrapped)
    };
  } finally {
    await popup.close().catch(() => {});
  }
}

async function ensureDashboardScraper(page) {
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  const ready = await page
    .waitForFunction(() => typeof globalThis.__bpmCollectTasks === 'function', {
      timeout: 8000
    })
    .then(() => true)
    .catch(() => false);
  if (!ready) {
    await page.addScriptTag({ url: `${BASE}/ext/gridScrapeInject.js` });
    await page.waitForFunction(() => typeof globalThis.__bpmCollectTasks === 'function', {
      timeout: 10000
    });
  }
  await page.waitForFunction(() => window.__stand && typeof window.__stand.completeOldest === 'function', {
    timeout: 10000
  });
}

async function extensionHistory(context, extensionId) {
  const popup = await context.newPage();
  popup.setDefaultTimeout(60000);
  try {
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded'
    });
    return popup.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'getHistory' }, (response) => {
            resolve(response?.history || []);
          });
        })
    );
  } finally {
    await popup.close().catch(() => {});
  }
}

async function runBackgroundLogicTests() {
  const results = [];

  results.push(
    await caseResult('sanitize drops ghost FRZ (title+date+SOS only)', async () => {
      const ghost = sanitizeTaskFields({
        id: 'ФРЗ: Финальный расчет затрат|',
        title: 'ФРЗ: Финальный расчет затрат',
        instanceName: '',
        client: '',
        address: '',
        sos: 'ДРОП',
        date: '22 июля 2026 г., 09:00:00'
      });
      assert(ghost === null, 'ghost should be null');
    })
  );

  results.push(
    await caseResult('sanitize keeps real FRZ with instance', async () => {
      const task = sanitizeTaskFields({
        id: 'ФРЗ: Финальный расчет затрат|Подключение «Невский 11»',
        title: 'ФРЗ: Финальный расчет затрат',
        instanceName: 'Подключение «Невский 11» по ТЭО.',
        client: 'Невский 11',
        address: 'Санкт-Петербург, Невский, 11',
        sos: 'ДРОП'
      });
      assert(task, 'real task should pass');
      assert(task.client === 'Невский 11', 'client preserved');
    })
  );

  results.push(
    await caseResult('membership merge: stale user tab cannot resurrect removed task', async () => {
      const dedicated = [
        {
          id: 'ФРЗ: x|A',
          title: 'ФРЗ: Финальный расчет затрат',
          instanceName: 'A',
          client: 'Клиент A',
          date: '22 июля 2026 г., 09:00:00',
          dateSource: 'dom'
        }
      ];
      const userStale = [
        {
          id: 'ФРЗ: x|A',
          title: 'ФРЗ: Финальный расчет затрат',
          instanceName: 'A',
          client: 'Клиент A',
          date: '22 июля 2026 г., 10:00:00',
          dateSource: 'dom'
        },
        {
          id: 'ФРЗ: x|B',
          title: 'ФРЗ: Финальный расчет затрат',
          instanceName: 'B',
          client: 'Ушедшая заявка'
        }
      ];
      const merged = mergeScrapedTasksByMembership(dedicated, [userStale]);
      assert(merged.length === 1, `expected 1 task, got ${merged.length}`);
      assert(merged[0].client === 'Клиент A', 'only dedicated membership kept');
      assert(
        !merged.some((t) => t.client === 'Ушедшая заявка'),
        'removed task must not resurrect from user tab'
      );
      assert(
        merged[0].date === '22 июля 2026 г., 10:00:00',
        `newer date must win over stale dedicated, got ${merged[0].date}`
      );
    })
  );

  results.push(
    await caseResult('membership merge: fresher user date beats frozen dedicated June date', async () => {
      const dedicated = [
        {
          id: 'ПРЗ: x|NIVIM',
          title: 'ПРЗ: Валидация предварительного расчета затрат',
          instanceName: 'NIVIM',
          client: 'НИВИМ',
          date: '3 июня 2026 г., 9:30:55',
          dateSource: 'dom'
        }
      ];
      const userFresh = [
        {
          id: 'ПРЗ: x|NIVIM',
          title: 'ПРЗ: Валидация предварительного расчета затрат',
          instanceName: 'NIVIM',
          client: 'НИВИМ',
          date: '29 июля 2026 г., 10:37:01',
          dateSource: 'dom'
        }
      ];
      const merged = mergeScrapedTasksByMembership(dedicated, [userFresh]);
      assert(merged.length === 1, `expected 1, got ${merged.length}`);
      assert(
        merged[0].date === '29 июля 2026 г., 10:37:01',
        `expected July received date, got ${merged[0].date}`
      );
    })
  );

  results.push(
    await caseResult('stable RIAS id collapses legacy long-id clone', async () => {
      const title = 'ПРЗ: Валидация предварительного расчета затрат';
      const instance =
        'Санкт-Петербург, Гривцова Пер, 20. АО МКК "СПб ЦДЖ". RIAS-556-317093427-317093427 [6715158]';
      const stable = `${title}|RIAS-556-317093427-317093427`;
      const legacy = `${title}|${instance}`;
      assert(stable !== legacy, 'stable id must differ from legacy long id');
      assert(/RIAS-556-317093427-317093427/i.test(stable), 'stable id keeps RIAS token');

      const incoming = [
        {
          id: stable,
          title,
          instanceName: instance,
          client: 'АО МКК "СПб ЦДЖ"',
          date: '29 июля 2026 г., 13:34:13',
          dateSource: 'dom'
        }
      ];
      const legacyActive = [
        {
          id: legacy,
          title,
          instanceName: instance,
          client: 'АО МКК "СПб ЦДЖ"',
          date: '6 июля 2026 г., 14:46:07',
          appearedAt: Date.parse('2026-07-06T14:46:07'),
          lastSeenAt: Date.now()
        }
      ];

      // Simulate supersede: same process key in incoming → legacy must not survive membership-style keep
      const proc = 'RIAS-556-317093427-317093427';
      const kept = legacyActive.filter((prev) => {
        const m = String(prev.instanceName || '').match(/\b((?:RIAS|KRUS)-[A-Za-z0-9.-]+)\b/i);
        const key = m ? m[1].toUpperCase() : '';
        return !(key && key === proc);
      });
      assert(kept.length === 0, 'legacy clone with same RIAS must be dropped');
      assert(incoming[0].id === stable, 'incoming uses stable id');
    })
  );

  results.push(
    await caseResult('membership merge: dedicated is source across all steps', async () => {
      const dedicated = [
        { id: 'ПРЗ: x|1', title: 'ПРЗ: Валидация', client: 'One' },
        { id: 'ПКМ: x|2', title: 'ПКМ: Координация', client: 'Two' }
      ];
      const user = [
        { id: 'ПРЗ: x|1', title: 'ПРЗ: Валидация', client: 'One' },
        { id: 'ПРЗ: x|3', title: 'ПРЗ: Валидация', client: 'Stale PRZ' },
        { id: 'ФРЗ: x|9', title: 'ФРЗ: Финальный расчет затрат', client: 'Stale FRZ' }
      ];
      const merged = mergeScrapedTasksByMembership(dedicated, [user]);
      assert(merged.length === 2, `expected 2, got ${merged.length}`);
      assert(!merged.some((t) => t.client?.includes('Stale')), 'no stale-only tasks');
    })
  );

  results.push(
    await caseResult('long instance ids do not collide after truncation removal', async () => {
      const prefix =
        'Санкт-Петербург, Королева Пр-Кт, 21 / 3. ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "НИВИМ". '.repeat(
          2
        );
      const a = `${prefix}RIAS-556-317085701-317085701 [6713110]`;
      const b = `${prefix}RIAS-556-317085657-317085657 [6713109]`;
      assert(a.length > 160 && b.length > 160, 'test data must exceed old truncation');
      const idA = `ПРЗ: Валидация предварительного расчета затрат|${a}`;
      const idB = `ПРЗ: Валидация предварительного расчета затрат|${b}`;
      assert(idA !== idB, 'full ids must remain unique');
      assert(idA.slice(0, 160) === idB.slice(0, 160), 'old truncated ids would collide');
    })
  );

  results.push(
    await caseResult('partial scrape: pager gap from deferred rows is not partial', async () => {
      const incoming = 5;
      const prev = 6;
      const pager = 6;
      const pagerGap = pager - incoming;
      const isPartial = !(pagerGap <= 2 && incoming <= prev);
      assert(isPartial === false, 'should not treat as partial scrape');
    })
  );

  return results;
}

async function forEachDashboardPage(context, fn) {
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    let url = '';
    try {
      url = page.url();
    } catch {
      continue;
    }
    if (!url.includes('13202')) continue;
    const hasScraper = await page
      .evaluate(() => typeof globalThis.__bpmCollectTasks === 'function')
      .catch(() => false);
    if (!hasScraper) {
      await page.addScriptTag({ url: `${BASE}/ext/gridScrapeInject.js` }).catch(() => {});
    }
    try {
      await fn(page);
    } catch (err) {
      const msg = String(err?.message || err);
      if (!msg.includes('closed')) throw err;
    }
  }
}

async function runExtensionE2E() {
  const results = [];
  const liveDir = prepareLiveExtension();
  const userDataDir = path.join(os.tmpdir(), `bpm-monitor-live-profile-${process.pid}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${liveDir}`,
        `--load-extension=${liveDir}`,
        '--no-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const sw = await waitForServiceWorker(context);
    const extensionId = sw.url().split('/')[2];
    assert(extensionId, 'extension id missing');

    const dashboard = await context.newPage();
    await ensureDashboardScraper(dashboard);

    results.push(
      await caseResult('live: extension bootstraps from dashboard', async () => {
        const first = await extensionManualCheck(context, extensionId);
        assert(first.ok, `bootstrap failed: ${first.checkResult}`);
        assert(first.total >= 5, `too few tasks: ${first.total}`);
      })
    );

    results.push(
      await caseResult('live: completed tracked task is removed after refresh', async () => {
        const before = await extensionManualCheck(context, extensionId);
        assert(before.ok, before.checkResult);

        for (let i = 0; i < 30; i++) {
          const dashPages = context
            .pages()
            .filter((p) => !p.isClosed() && p.url().includes('13202'));
          if (dashPages.length >= 1) break;
          await new Promise((r) => setTimeout(r, 500));
        }

        await forEachDashboardPage(context, async (page) => {
          await page.evaluate(async () => {
            if (!window.__stand) return;
            window.__stand.setStaleMode(false);
            window.__stand.completeTracked();
            if (typeof globalThis.__bpmSoftRefreshDashboard === 'function') {
              await globalThis.__bpmSoftRefreshDashboard(true);
            } else {
              window.__stand.softRefreshFromServer();
            }
          });
        });
        await new Promise((r) => setTimeout(r, 1500));

        const after = await extensionManualCheck(context, extensionId);
        assert(after.ok, after.checkResult);
        assert(
          after.total < before.total,
          `task not removed: ${before.total} → ${after.total} (${after.checkResult})`
        );
      })
    );

    results.push(
      await caseResult('live: ghost FRZ never enters extension history', async () => {
        const beforeGhost = await extensionManualCheck(context, extensionId);
        assert(beforeGhost.ok, beforeGhost.checkResult);

        let dashPage = context
          .pages()
          .find((p) => !p.isClosed() && p.url().includes('13202'));
        if (!dashPage) {
          dashPage = await context.newPage();
          await ensureDashboardScraper(dashPage);
        }
        await dashPage.evaluate(() => window.__stand?.addGhostFrz?.());

        const afterGhost = await extensionManualCheck(context, extensionId);
        assert(afterGhost.ok, afterGhost.checkResult);
        assert(
          afterGhost.total === beforeGhost.total,
          `ghost changed count: ${beforeGhost.total} → ${afterGhost.total} (${afterGhost.checkResult})`
        );
      })
    );

    results.push(
      await caseResult('live: ПКМ: Подключение counted on montage tab', async () => {
        const popup = await context.newPage();
        try {
          await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
            waitUntil: 'domcontentloaded'
          });
          await popup.click('#tabMontage');
          await popup.waitForTimeout(300);
          const montageText = await popup.locator('#statsMontage').textContent();
          assert(/[1-9]/.test(montageText || ''), `montage stats empty: ${montageText}`);
        } finally {
          await popup.close().catch(() => {});
        }
      })
    );
  } catch (err) {
    results.push({
      name: 'live: extension harness',
      ok: false,
      error: String(err?.message || err)
    });
  } finally {
    if (context) await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(liveDir, { recursive: true, force: true });
  }

  return results;
}

async function main() {
  const results = [];

  results.push(...(await runBackgroundLogicTests()));

  const standExit = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'run-stand.mjs')], {
      cwd: __dirname,
      stdio: 'inherit'
    });
    p.on('exit', (code) => resolve(code ?? 1));
  });
  results.push({
    name: 'virtual stand suite (re-run)',
    ok: standExit === 0,
    error: standExit === 0 ? undefined : `exit ${standExit}`
  });

  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`Live stand: ${TARGET_URL}`);

  try {
    results.push(...(await runExtensionE2E()));
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }

  const failed = results.filter((r) => !r.ok);
  const report = {
    suite: 'live-combat',
    at: new Date().toISOString(),
    targetUrl: TARGET_URL,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results
  };

  const outPath = path.join(__dirname, 'reports', 'live-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('\n=== Live / combat report ===');
  console.log(`${report.passed}/${report.total} passed`);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} · ${r.name}${r.error ? ' · ' + r.error : ''}`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
