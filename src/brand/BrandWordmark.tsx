import { BRAND_NAME } from "@/brand/brand";
import { SkotMark } from "@/brand/icons";

/** Header wordmark: logo mark, product name and a Beta pill. */
export function BrandWordmark() {
  return (
    <>
      <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-[#D94E28] text-white shadow-xs">
        <SkotMark className="h-[18px] w-[18px]" />
      </span>
      <span className="font-editorial text-[21px] font-semibold leading-none tracking-[-0.02em] text-foreground">
        {BRAND_NAME}
      </span>
      <span
        data-beta-badge
        className="rounded-full border border-[#D94E28]/45 bg-[#D94E28]/10 px-1.5 py-[1px] font-sans text-[10px] font-bold uppercase leading-[14px] tracking-[0.1em] text-[#D94E28] dark:text-[#FF9A76]"
      >Beta</span>
    </>
  );
}
