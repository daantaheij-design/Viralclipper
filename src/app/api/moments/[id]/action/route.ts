import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { applyMomentAction, type MomentAction } from "@/database/moments";

const VALID_ACTIONS: MomentAction[] = ["save", "reject", "use", "editing", "unsave"];

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { action?: string };

  if (!body.action || !VALID_ACTIONS.includes(body.action as MomentAction)) {
    return NextResponse.json(
      { error: `action must be one of: ${VALID_ACTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  const moment = await applyMomentAction(id, body.action as MomentAction);
  return NextResponse.json({ moment });
}
