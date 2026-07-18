import { DateTime } from 'luxon';
import type { CallingWindow } from '../../schemas/country-pack.schema';

export interface WindowRules {
  callingWindows: CallingWindow[];
  publicHolidays: string[];
}

/**
 * Timezone-aware legal-window check per LEAD-06 / CP-02. Evaluated in the
 * lead's local timezone, which handles DST divergence (e.g. QLD vs NSW)
 * automatically via IANA zones.
 */
export function isWithinCallingWindow(rules: WindowRules, timezone: string, at: Date = new Date()): boolean {
  const local = DateTime.fromJSDate(at, { zone: timezone });
  if (!local.isValid) return false;

  if (rules.publicHolidays.includes(local.toISODate() ?? '')) return false;

  const windows = rules.callingWindows.filter((w) => w.weekday === local.weekday);
  if (windows.length === 0) return false;

  const minutes = local.hour * 60 + local.minute;
  return windows.some((w) => {
    const [sh, sm] = w.start.split(':').map(Number);
    const [eh, em] = w.end.split(':').map(Number);
    return minutes >= (sh ?? 0) * 60 + (sm ?? 0) && minutes < (eh ?? 0) * 60 + (em ?? 0);
  });
}

/**
 * Next instant the window opens for this timezone — used to hold leads until
 * their window opens per LEAD-06. Scans up to 14 days ahead.
 */
export function nextWindowOpen(rules: WindowRules, timezone: string, from: Date = new Date()): Date | null {
  let cursor = DateTime.fromJSDate(from, { zone: timezone });
  if (!cursor.isValid) return null;

  for (let day = 0; day < 14; day += 1) {
    const date = cursor.plus({ days: day }).startOf('day');
    if (rules.publicHolidays.includes(date.toISODate() ?? '')) continue;
    const windows = rules.callingWindows
      .filter((w) => w.weekday === date.weekday)
      .sort((a, b) => a.start.localeCompare(b.start));
    for (const w of windows) {
      const [sh, sm] = w.start.split(':').map(Number);
      const [eh, em] = w.end.split(':').map(Number);
      const start = date.set({ hour: sh ?? 0, minute: sm ?? 0 });
      const end = date.set({ hour: eh ?? 0, minute: em ?? 0 });
      if (day === 0 && cursor >= end) continue;
      const candidate = day === 0 && cursor > start ? cursor : start;
      if (candidate < end) return candidate.toJSDate();
    }
  }
  return null;
}
