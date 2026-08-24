export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = params.next && params.next.startsWith("/") ? params.next : "/";

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-8 shadow-xl">
        <h1 className="text-xl font-semibold text-neutral-100">Viral Clip Finder</h1>
        <p className="mt-1 text-sm text-neutral-400">Enter the password to continue.</p>

        {params.error && (
          <p className="mt-4 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-300">
            Wrong password. Try again.
          </p>
        )}

        <form method="POST" action="/api/auth/login" className="mt-6 space-y-4">
          <input type="hidden" name="next" value={next} />
          <input
            type="password"
            name="password"
            placeholder="Password"
            autoFocus
            required
            className="w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100 placeholder-neutral-500 outline-none focus:border-orange-500"
          />
          <button
            type="submit"
            className="w-full rounded-lg bg-orange-600 px-3 py-2 font-medium text-white transition hover:bg-orange-500"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}
