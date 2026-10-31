// The server assigns Beijing 06:00 through next 06:00 to one business date.
// UTC + 8 hours - 6 hours = UTC + 2 hours; independent of the browser timezone.
export function businessDate(now = new Date()): string {
  return new Date(now.getTime() + 2 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
