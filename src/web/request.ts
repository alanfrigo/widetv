/** Only small control responses pass here; video and keepalive progress do not. */
let session = new AbortController();

export const sessionSignal = (): AbortSignal => session.signal;

export function resetRequests(): void {
  session.abort();
  session = new AbortController();
}

export function isCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export async function controlRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const parents = [session.signal, init.signal].filter((s): s is AbortSignal => s != null);
  const cancel = () => controller.abort(new DOMException('Request cancelled', 'AbortError'));
  for (const parent of parents) {
    parent.addEventListener('abort', cancel, { once: true });
    if (parent.aborted) cancel();
  }
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 15_000);
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    if (controller.signal.aborted) throw controller.signal.reason;
    return new Response([204, 205, 304].includes(response.status) || init.method === 'HEAD' ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    // Reading a fetch body often throws AbortError even when its reason was a timeout.
    // Preserve that distinction so a slow server gets a retry UI, not silent cancellation.
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    for (const parent of parents) parent.removeEventListener('abort', cancel);
  }
}
