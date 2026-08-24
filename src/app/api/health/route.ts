import { NextResponse } from "next/server";

/** Unauthenticated liveness check for the platform's health probe (e.g. Railway). */
export async function GET() {
  return NextResponse.json({ status: "ok" });
}
