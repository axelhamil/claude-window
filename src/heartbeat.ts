const TIMEOUT_MS = 10_000;

export async function ping(
  url: string | null,
  outcome: "success" | "fail",
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (url === null) return null;

  const target = outcome === "fail" ? `${url.replace(/\/+$/, "")}/fail` : url;

  try {
    const response = await fetchImpl(target, {
      method: "GET",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return `heartbeat ping returned HTTP ${response.status}`;
    return null;
  } catch (error) {
    return `heartbeat ping failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
