import type { Metadata } from "next";
import { connection } from "next/server";
import { ContactSheet } from "@/brand/icons/ContactSheet";

export const metadata: Metadata = {
  title: "Skot icons",
  robots: { index: false },
};

export default async function IconsPage() {
  // Per-request render so the CSP nonce from src/proxy.ts reaches framework scripts.
  await connection();
  return (
    <div style={{ height: "100%", overflowY: "auto" }}>
      <ContactSheet />
    </div>
  );
}
