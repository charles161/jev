import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export function ThemeBootScript({ nonce }: { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />;
}
