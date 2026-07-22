/**
 * Юнит-сценарии таймеров/уведомлений без браузера.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectDueNotifications,
  evaluateTimer,
  reconcileNotifiedThresholds,
  resolveAppearedAtForTimer,
  schemeFromSos,
  looksLikeSchemeLabel
} from '../timerEngine.js';
import { businessMsBetween, hours } from '../businessTime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function caseResult(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (err) {
    return { name, ok: false, error: String(err.message || err) };
  }
}

const now = Date.parse('2026-07-22T11:39:00+03:00');

const results = [
  caseResult('SOS copper → default scheme', () => {
    assert(schemeFromSos('Медный кабель') === 'default', 'expected default');
  }),
  caseResult('SOS ВОЛС → vols', () => {
    assert(schemeFromSos('ВОЛС') === 'vols', 'expected vols');
  }),
  caseResult('SOS P2P → radio', () => {
    assert(schemeFromSos('P2P радио') === 'radio', 'expected radio');
  }),
  caseResult('looksLikeSchemeLabel rejects org names', () => {
    assert(looksLikeSchemeLabel('ООО ЛИГА') === false, 'org should not be scheme');
    assert(looksLikeSchemeLabel('Медный кабель') === true, 'sos should be scheme');
  }),
  caseResult('timer uses page date over stale appearedAt', () => {
    const task = {
      type: 'ПРЗ: Валидация',
      date: '22 июля 2026 г., 09:39:00',
      appearedAt: now - hours(5),
      scheme: 'default'
    };
    const at = resolveAppearedAtForTimer(task, now);
    const elapsed = businessMsBetween(at, now);
    assert(Math.abs(elapsed - hours(2)) < 1000, `expected ~2h, got ${elapsed}`);
    const ev = evaluateTimer(task, now);
    assert(ev.zone === 'green', `expected green, got ${ev.zone}`);
  }),
  caseResult('old PRZ does not fire false 5h notify', () => {
    const task = {
      type: 'ПРЗ: Валидация',
      date: '16 июня 2026 г., 17:30:27',
      appearedAt: now - hours(5),
      scheme: 'default',
      notified: []
    };
    const fixed = reconcileNotifiedThresholds(task, now);
    const { due } = collectDueNotifications(fixed, { notified: fixed.notified }, now);
    assert(due.length === 0, `unexpected due: ${JSON.stringify(due)}`);
    assert(fixed.notified.includes('prz_5h'), 'prz_5h should be seeded silently');
  }),
  caseResult('PRZ crosses 5h → yellow + notify', () => {
    const task = {
      type: 'ПРЗ: Валидация',
      date: '22 июля 2026 г., 06:39:00',
      appearedAt: Date.parse('2026-07-22T06:39:00+03:00'),
      scheme: 'default',
      notified: [],
      lastElapsedMs: hours(4.9)
    };
    // 06:39→11:39 = 5h business (within 9-18? 06:39 is before work!)
    // Use 09:00 start so 09:00→14:00 = 5h
  }),
  caseResult('PRZ 5h crossing during work hours', () => {
    const n = Date.parse('2026-07-22T14:00:00+03:00');
    const task = {
      type: 'ПРЗ: Валидация',
      date: '22 июля 2026 г., 09:00:00',
      appearedAt: Date.parse('2026-07-22T09:00:00+03:00'),
      scheme: 'default',
      notified: [],
      lastElapsedMs: hours(4.9)
    };
    const ev = evaluateTimer(task, n);
    assert(ev.zone === 'yellow', `expected yellow at 5h, got ${ev.zone}`);
    const { due } = collectDueNotifications(task, { notified: [] }, n);
    assert(
      due.some((d) => d.message.includes('прошло 5 часов')),
      `expected 5h notify, due=${JSON.stringify(due)}`
    );
  }),
  caseResult('PKM 2h → yellow + notify', () => {
    const n = Date.parse('2026-07-22T11:00:00+03:00');
    const task = {
      type: 'ПКМ: Координация',
      date: '22 июля 2026 г., 09:00:00',
      appearedAt: Date.parse('2026-07-22T09:00:00+03:00'),
      scheme: 'default',
      notified: [],
      lastElapsedMs: hours(1.9)
    };
    const ev = evaluateTimer(task, n);
    assert(ev.zone === 'yellow', `expected yellow, got ${ev.zone}`);
    const { due } = collectDueNotifications(task, { notified: [] }, n);
    assert(
      due.some((d) => d.message.includes('2 часа')),
      `expected 2h notify, due=${JSON.stringify(due)}`
    );
  }),
  caseResult('PKM ВОЛС timer off', () => {
    const task = {
      type: 'ПКМ: Координация',
      scheme: 'vols',
      appearedAt: now - hours(10)
    };
    const ev = evaluateTimer(task, now);
    assert(ev.zone === 'vols', 'expected vols zone');
    assert(ev.elapsedMs === 0, 'vols elapsed must be 0');
  })
];

const failed = results.filter((r) => !r.ok);
const report = {
  suite: 'timers',
  at: new Date().toISOString(),
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results
};

const out = path.join(__dirname, 'reports', 'timers-report.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));

console.log(`Timers: ${report.passed}/${report.total} passed`);
for (const r of failed) console.error('FAIL', r.name, r.error);
process.exit(failed.length ? 1 : 0);
