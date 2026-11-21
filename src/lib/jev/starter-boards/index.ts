import { chat } from "./chat";
import type { StarterBoard } from "./kit";
import { newsFeed } from "./news-feed";
import { notifications } from "./notifications";
import { payments } from "./payments";
import { rateLimiter } from "./rate-limiter";
import { urlShortener } from "./url-shortener";

export type { StarterBoard } from "./kit";

export const STARTER_BOARDS: readonly StarterBoard[] = [urlShortener, chat, newsFeed, rateLimiter, payments, notifications];

export function findStarterBoard(id: string): StarterBoard | undefined {
  return STARTER_BOARDS.find((b) => b.id === id);
}
