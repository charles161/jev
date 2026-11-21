/** Strip the URL fragment (#room=…&k=…: room id + E2E key) before Vercel Analytics or Speed Insights send it. */
export function dropUrlFragment<T extends { url: string }>(event: T): T {
  const hash = event.url.indexOf("#");
  return hash === -1 ? event : { ...event, url: event.url.slice(0, hash) };
}
