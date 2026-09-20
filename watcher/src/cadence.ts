/** Four decisions per Stockholm day, on the hour at 00, 06, 12 and 18.
 *
 * That is a handful, not a firehose: a week stays inside the 32-entry on-chain
 * ring instead of wrapping it on day two. Each tick uses the 15-minute price
 * window that starts at that hour.
 */

export const CADENCE_HOURS = [0, 6, 12, 18] as const;
export const STOCKHOLM = "Europe/Stockholm";

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function wallInZone(at: Date, timeZone: string): Wall {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(at);
  const pick = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) throw new Error(`cadence: missing ${type}`);
    return Number.parseInt(value, 10);
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
  };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const wall = wallInZone(instant, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - instant.getTime();
}

export function zonedLocalToDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = STOCKHOLM,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = new Date(utcGuess);
  const offset = zoneOffsetMs(instant, timeZone);
  instant = new Date(utcGuess - offset);
  const offset2 = zoneOffsetMs(instant, timeZone);
  if (offset2 !== offset) {
    instant = new Date(utcGuess - offset2);
  }
  return instant;
}

export function dueSlots(now: Date): Date[] {
  const wall = wallInZone(now, STOCKHOLM);
  const slots: Date[] = [];
  for (const hour of CADENCE_HOURS) {
    const slot = zonedLocalToDate(wall.year, wall.month, wall.day, hour, 0);
    if (slot.getTime() <= now.getTime()) slots.push(slot);
  }
  return slots;
}

export function nextSlot(now: Date): Date {
  const wall = wallInZone(now, STOCKHOLM);
  for (const hour of CADENCE_HOURS) {
    const slot = zonedLocalToDate(wall.year, wall.month, wall.day, hour, 0);
    if (slot.getTime() > now.getTime()) return slot;
  }
  const tomorrow = new Date(zonedLocalToDate(wall.year, wall.month, wall.day, 0, 0).getTime() + 36 * 60 * 60 * 1000);
  const tWall = wallInZone(tomorrow, STOCKHOLM);
  return zonedLocalToDate(tWall.year, tWall.month, tWall.day, CADENCE_HOURS[0], 0);
}

export function msUntil(then: Date, now: Date): number {
  const delta = then.getTime() - now.getTime();
  return delta > 0 ? delta : 0;
}
