/**
 * A stream response whose body calls `onError` if it breaks — the network
 * dropped, not the caller aborting. A node that keeps accepting streams and
 * then dropping them is failed over the same as one that refuses them, which
 * needs the break to be seen by the layer that routed the stream.
 */
export function watchBody(res: Response, onError: () => void, signal?: AbortSignal): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        if (!signal?.aborted) onError();
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
