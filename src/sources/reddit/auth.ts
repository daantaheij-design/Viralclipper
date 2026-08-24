import { env } from "@/lib/env";
import { SourceUnavailableError } from "@/sources/types";

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

export async function getRedditAccessToken(): Promise<string> {
  if (!env.redditClientId || !env.redditClientSecret) {
    throw new SourceUnavailableError(
      "reddit",
      "REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set — the Reddit source cannot authenticate.",
    );
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const basicAuth = Buffer.from(`${env.redditClientId}:${env.redditClientSecret}`).toString(
    "base64",
  );
  const res = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": env.redditUserAgent,
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new SourceUnavailableError(
      "reddit",
      `Reddit token request failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.accessToken;
}
