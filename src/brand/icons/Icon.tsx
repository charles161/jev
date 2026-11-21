import type { ReactNode, SVGProps } from "react";

export const ICON_GRID = 24;
export const ICON_STROKE = 1.75;

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & {
  title?: string;
  size?: number | string;
};

type BaseProps = IconProps & { children: ReactNode };

export function Icon({
  title,
  size = ICON_GRID,
  strokeWidth = ICON_STROKE,
  children,
  ...rest
}: BaseProps) {
  const a11y = title
    ? { role: "img" as const, "aria-label": title }
    : { "aria-hidden": true as const, focusable: "false" as const };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...a11y}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/**
 * Four-point spark: the shared AI accent. Concave sides, solid fill so it stays
 * a crisp star at 16px where a 1.75 stroke would blob.
 */
export function sparkPath(cx: number, cy: number, r: number): string {
  const k = r * 0.2;
  const f = (n: number) => Number(n.toFixed(2));
  return [
    `M${f(cx)} ${f(cy - r)}`,
    `Q${f(cx + k)} ${f(cy - k)} ${f(cx + r)} ${f(cy)}`,
    `Q${f(cx + k)} ${f(cy + k)} ${f(cx)} ${f(cy + r)}`,
    `Q${f(cx - k)} ${f(cy + k)} ${f(cx - r)} ${f(cy)}`,
    `Q${f(cx - k)} ${f(cy - k)} ${f(cx)} ${f(cy - r)}Z`,
  ].join("");
}

export function Spark({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return <path d={sparkPath(cx, cy, r)} fill="currentColor" stroke="none" />;
}
