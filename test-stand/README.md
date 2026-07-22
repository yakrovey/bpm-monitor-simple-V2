# Виртуальный стенд BPM Monitor

Локальный mock дашборда SYSRP/13202 + автопрогон scrape/таймеров.

## Быстрый старт

```bash
cd test-stand
npm install
npx playwright install chromium
npm run stand
```

Отчёты: `test-stand/reports/stand-report.json`, `timers-report.json`.

## Только UI mock

```bash
npm run server
# http://127.0.0.1:4177/
```

Кнопки на стенде:
- **Обновить** — soft refresh
- **Отработать первую** — убрать задачу с «сервера»
- **Режим «окно неактивно»** — страница перестаёт синхронизироваться (баг BPM в фоне)
- **Подложить СОС в client** — имитация смещения колонок
