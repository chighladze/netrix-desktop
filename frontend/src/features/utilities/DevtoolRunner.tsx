import { useEffect, useRef, useState } from "react";
import { executeDevtoolCommand } from "../../utils/devtoolCli";
import { copyTextWithAutoClear } from "../../utils/clipboard";

export default function DevtoolRunner() {
  const [input, setInput] = useState("devtool help");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const invalidate = () => {
    generation.current++;
    setBusy(false);
    setOutput("");
    setError("");
  };
  const run = async () => {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true);
    setOutput("");
    setError("");
    try {
      if (!input.trim().startsWith("devtool "))
        throw new Error("Start with devtool, for example: devtool help");
      const result = await executeDevtoolCommand(input);
      if (current === generation.current) setOutput(result.replace(/\x1b\[[0-9;]*m/g, ""));
    } catch (failure) {
      if (current === generation.current)
        setError(failure instanceof Error ? failure.message : "Local tool failed");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return (
    <section className="ui-card p-4 space-y-3">
      <h3 className="text-sm font-semibold text-white">Local DevTool Runner</h3>
      <p className="text-xs text-gray-400">
        Run text tools locally. Input and results stay in this panel until cleared or closed.
        Commands typed into a connected terminal send keystrokes to that host.
      </p>
      <textarea
        aria-label="Local DevTool command"
        spellCheck={false}
        maxLength={65536}
        rows={3}
        value={input}
        onChange={(event) => {
          invalidate();
          setInput(event.target.value);
        }}
        className="ui-input font-mono text-xs"
      />
      <div className="flex gap-3 text-xs">
        <button
          onClick={() => void run()}
          disabled={busy}
          className="ui-button ui-button-primary"
        >
          {busy ? "Running locally..." : "Run locally"}
        </button>
        <button
          onClick={() => {
            invalidate();
            setInput("");
          }}
          className="text-gray-300"
        >
          Clear local input
        </button>
        {output && (
          <button
            onClick={() =>
              void copyTextWithAutoClear(output).catch(() =>
                setError("Could not copy local result"),
              )
            }
            className="text-gray-300"
          >
            Copy local result
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      )}
      {output && (
        <pre
          aria-label="Local DevTool result"
          className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-gray-200 font-mono"
        >
          {output}
        </pre>
      )}
    </section>
  );
}
