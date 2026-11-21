export const BOARD_STORAGE_PREFIX = "jev_board_";

export function boardStorageKey(roomId: string): string {
  return `${BOARD_STORAGE_PREFIX}${roomId}`;
}
