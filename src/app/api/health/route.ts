import { jsonNoStore } from "@/lib/server/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return jsonNoStore({
    ok: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
}
