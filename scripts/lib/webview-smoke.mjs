import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function until(description, check, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let failure;
  while (Date.now() < end) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { failure = error; }
    await delay(100);
  }
  throw new Error(`${description} timed out`, { cause: failure });
}

export async function views(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(500) });
  return (await response.json()).filter(page => page.type === "page" && /^https?:\/\/tauri\.localhost\//.test(page.url));
}

export async function evaluate(view, expression, timeoutMs = 8000) {
  const socket = new WebSocket(view.webSocketDebuggerUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    await once(socket, "open", { signal });
    const message = once(socket, "message", { signal });
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const response = JSON.parse((await message)[0].data);
    if (response.error || response.result.exceptionDetails) {
      const exception = response.result?.exceptionDetails?.exception;
      throw new Error(response.error?.message || exception?.description || exception?.value || "Isolated webview evaluation failed");
    }
    return response.result.result.value;
  } finally { socket.close(); }
}

export function invoke(command, args) {
  return `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args || {})})`;
}
