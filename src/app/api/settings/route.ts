import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSettings, updateSettings } from "@/database/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(request: NextRequest) {
  const patch = await request.json();
  const settings = await updateSettings(patch);
  return NextResponse.json({ settings });
}
