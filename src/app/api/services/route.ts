import { NextResponse } from "next/server";
import { getServicesFromDb, saveServicesToDb } from "@/lib/server-db";
import { handleConditionalGet } from "@/lib/http-cache";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId =
      url.searchParams.get("workspaceId") ||
      req.headers.get("x-workspace-id") ||
      url.searchParams.get("userId") ||
      req.headers.get("x-user-id") ||
      undefined;

    const services = await getServicesFromDb(workspaceId);
    return handleConditionalGet(req, services);
  } catch (error) {
    console.error("Error fetching services:", error);
    return NextResponse.json({ error: "Failed to fetch services" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const body = await req.json();
    const services = Array.isArray(body) ? body : body.services || [];
    const workspaceId =
      body.workspaceId ||
      url.searchParams.get("workspaceId") ||
      req.headers.get("x-workspace-id") ||
      body.userId ||
      url.searchParams.get("userId") ||
      undefined;

    const saved = await saveServicesToDb(services, workspaceId);
    return NextResponse.json(saved);
  } catch (error) {
    console.error("Error saving services:", error);
    return NextResponse.json({ error: "Failed to save services" }, { status: 500 });
  }
}
