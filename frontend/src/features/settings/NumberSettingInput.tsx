import { useEffect, useState } from "react";
import { parseSettingNumber } from "./settings";

/** Keep an unfinished edit local; only commit a valid bounded integer. */
export default function NumberSettingInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => boolean | void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = parseSettingNumber(draft, min, max);
    const saved = next !== null && onChange(next) !== false;
    setDraft(String(saved ? next : value));
  };
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={1}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      className="w-24 bg-[#11111b] border border-[#2a2a35] rounded-xl py-2 px-4 text-sm text-center text-white focus:outline-none focus:border-primary/50 transition-all font-bold"
    />
  );
}
