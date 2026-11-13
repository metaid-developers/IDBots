/**
 * Initial main-window size for the display's work area. A fixed 1200x800
 * window left the Studio conversation column and the browser beside it
 * cramped on every common laptop/desktop display, so the window now opens at
 * ~88% of the work area (bounded to a comfortable range) and never larger
 * than the work area itself.
 */
export const INITIAL_WINDOW_MIN = { width: 1200, height: 800 } as const;
export const INITIAL_WINDOW_MAX = { width: 1680, height: 1050 } as const;

export function resolveInitialWindowSize(workArea: { width: number; height: number } | null | undefined): {
  width: number;
  height: number;
} {
  const areaWidth = Number(workArea?.width);
  const areaHeight = Number(workArea?.height);
  if (!(areaWidth > 0) || !(areaHeight > 0)) return { ...INITIAL_WINDOW_MIN };
  const fit = (area: number, ratio: number, min: number, max: number): number => (
    Math.min(area, Math.max(Math.min(min, area), Math.min(max, Math.round(area * ratio))))
  );
  return {
    width: fit(areaWidth, 0.88, INITIAL_WINDOW_MIN.width, INITIAL_WINDOW_MAX.width),
    height: fit(areaHeight, 0.9, INITIAL_WINDOW_MIN.height, INITIAL_WINDOW_MAX.height),
  };
}
