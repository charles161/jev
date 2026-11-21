export type DragMode = "pan" | "move" | "resize" | "connect" | "draw_shape" | "freedraw" | "marquee";

/**
 * When a canvas gesture takes pointer capture. Capturing on pointerdown retargets the following
 * click and dblclick to the canvas container, so select-tool gestures (move, marquee) wait for
 * the first move: a double-click then still reaches the element under the pointer.
 */
export function pointerCaptureTiming(mode: DragMode): "down" | "move" {
  return mode === "move" || mode === "marquee" ? "move" : "down";
}

export function shouldCaptureOnMove(mode: DragMode | null, buttons: number, hasCapture: boolean): boolean {
  return mode !== null && pointerCaptureTiming(mode) === "move" && (buttons & 1) === 1 && !hasCapture;
}
