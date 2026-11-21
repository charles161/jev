import { connection } from "next/server";
import { JevWorkspace } from "@/components/jev/JevWorkspace";

export default async function HomePage() {
  // Opt into per-request dynamic rendering so Next.js 16 applies the per-request
  // CSP nonce from src/proxy.ts to framework and hydration scripts.
  await connection();
  // Collaboration signalling keeps rooms in one server process; Vercel serverless can't host it yet (Charles: collab later).
  return <JevWorkspace collabEnabled={process.env.VERCEL !== "1"} />;
}
