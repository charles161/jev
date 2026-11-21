import type { BeforeSendEvent } from "@vercel/analytics";

export function dropUrlFragment(event: BeforeSendEvent): BeforeSendEvent {
  const hash = event.url.indexOf("#");
  return hash === -1 ? event : { ...event, url: event.url.slice(0, hash) };
}
