import { NextResponse } from "next/server";
import { getMomentById } from "@/database/moments";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const moment = await getMomentById(id);
  if (!moment) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ moment });
}
