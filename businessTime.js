// Рабочее время: пн–пт 09:00–18:00 (локальный часовой пояс ОС).
// Пока браузер закрыт таймер не «тикает» в JS, но при следующем запуске
// прошедшие рабочие часы пересчитываются по wall-clock меткам.

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 18;

const MS_PER_MIN = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MIN;

export function hours(h) {
  return h * MS_PER_HOUR;
}

export function hoursMinutes(h, m) {
  return h * MS_PER_HOUR + m * MS_PER_MIN;
}

export function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

export function isWorkTime(date = new Date()) {
  if (isWeekend(date)) return false;
  const minutes = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  return minutes >= WORK_START_HOUR * 60 && minutes < WORK_END_HOUR * 60;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Сколько рабочих миллисекунд прошло между startMs и endMs.
 */
export function businessMsBetween(startMs, endMs) {
  if (endMs == null || startMs == null) return 0;
  if (endMs <= startMs) return 0;

  const start = new Date(startMs);
  const end = new Date(endMs);
  let total = 0;

  let day = startOfDay(start);
  const lastDay = startOfDay(end);

  while (day <= lastDay) {
    if (!isWeekend(day)) {
      const workStart = new Date(day);
      workStart.setHours(WORK_START_HOUR, 0, 0, 0);
      const workEnd = new Date(day);
      workEnd.setHours(WORK_END_HOUR, 0, 0, 0);

      const from = Math.max(start.getTime(), workStart.getTime());
      const to = Math.min(end.getTime(), workEnd.getTime());
      if (to > from) total += to - from;
    }
    day = addDays(day, 1);
  }

  return total;
}

export function formatBusinessDuration(ms) {
  const safe = Math.max(0, Math.floor(ms));
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}ч ${String(m).padStart(2, '0')}м ${String(s).padStart(2, '0')}с`;
}

/** Разбор даты со страницы BPM («23 сент. 2024 г., 14:36:44» и др.) → timestamp */
export function parseRussianDateTime(dateStr) {
  if (!dateStr) return null;
  const clean = String(dateStr).trim();
  const months = {
    янв: 0,
    фев: 1,
    мар: 2,
    апр: 3,
    мая: 4,
    май: 4,
    июн: 5,
    июл: 6,
    авг: 7,
    сен: 8,
    окт: 9,
    ноя: 10,
    дек: 11
  };

  const rusMatch = clean.match(
    /(\d{1,2})\s+([а-я]{3,})\.?\s+(\d{4})\s*г?\.?,?\s*(\d{1,2}):(\d{2}):(\d{2})/i
  );
  if (rusMatch) {
    const month = months[rusMatch[2].toLowerCase().substring(0, 3)];
    if (month === undefined) return null;
    return new Date(
      parseInt(rusMatch[3], 10),
      month,
      parseInt(rusMatch[1], 10),
      parseInt(rusMatch[4], 10) || 0,
      parseInt(rusMatch[5], 10) || 0,
      parseInt(rusMatch[6], 10) || 0
    ).getTime();
  }

  const dotMatch = clean.match(
    /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/
  );
  if (dotMatch) {
    return new Date(
      parseInt(dotMatch[3], 10),
      parseInt(dotMatch[2], 10) - 1,
      parseInt(dotMatch[1], 10),
      parseInt(dotMatch[4], 10),
      parseInt(dotMatch[5], 10),
      parseInt(dotMatch[6], 10)
    ).getTime();
  }

  const isoMatch = clean.match(
    /(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/
  );
  if (isoMatch) {
    return new Date(
      parseInt(isoMatch[1], 10),
      parseInt(isoMatch[2], 10) - 1,
      parseInt(isoMatch[3], 10),
      parseInt(isoMatch[4], 10),
      parseInt(isoMatch[5], 10),
      parseInt(isoMatch[6], 10)
    ).getTime();
  }

  return null;
}
