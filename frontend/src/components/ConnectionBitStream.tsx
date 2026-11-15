import { memo, useLayoutEffect, useRef, useState } from "react";
import { createLightningStrikes, lightningPath, LIGHTNING_VARIANTS, type BitContact, type LightningStrike } from "../terminal/connectionLightning";
import { createConnectionOctets } from "../terminal/connectionBits";

function Octets({ octets, illuminated = false }: { octets: readonly string[]; illuminated?: boolean }) {
  return <div className={`connection-octets${illuminated ? " connection-octets-lit" : ""}`}>
    {octets.map((octet, group) => <div className="connection-octet" key={group}>
      <span className="connection-byte-offset">{(group * 8).toString(16).padStart(2, "0")}</span>
      <span className="connection-byte">{Array.from(octet, (bit, index) => <span className="connection-bit" data-bit-index={group * 8 + index} key={index}>{bit}</span>)}</span>
    </div>)}
  </div>;
}

export default memo(function ConnectionBitStream({ running, complete, onComplete }: {
  running: boolean;
  complete: boolean;
  onComplete?: () => void;
}) {
  const signalRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const electricityRef = useRef<SVGSVGElement>(null);
  const renewBoltsRef = useRef<(() => void) | null>(null);
  const [octets, setOctets] = useState(() => createConnectionOctets());
  const measuredOctetsRef = useRef(octets);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const electricity = electricityRef.current;
    if (!track || !electricity) return;
    let strikes: LightningStrike[] = [];
    let hops: { from: BitContact; to: BitContact; start: number; duration: number }[] = [];
    const drawBolts = () => {
      electricity.querySelectorAll<SVGGElement>(".connection-hop").forEach((group, index) => {
        const hop = hops[index];
        const strike = strikes[index];
        const paths = hop && strike ? lightningPath(hop.from, hop.to, strike) : { main: "", branches: "", contact: { x: 0, y: 0 } };
        if (hop && strike) group.setAttribute("data-variant", LIGHTNING_VARIANTS[strike.variant].id);
        else group.removeAttribute("data-variant");
        group.querySelector(".connection-arc-halo")?.setAttribute("d", paths.main);
        group.querySelector(".connection-arc-core")?.setAttribute("d", paths.main);
        group.querySelector(".connection-arc-branches")?.setAttribute("d", paths.branches);
        const contact = group.querySelector("circle");
        contact?.setAttribute("cx", String(paths.contact.x));
        contact?.setAttribute("cy", String(paths.contact.y));
      });
    };
    // Refresh only between passes, after every bolt has faded. No visible
    // geometry changes mid-strike, and the CSS charge timings stay untouched.
    renewBoltsRef.current = () => {
      strikes = createLightningStrikes(47, strikes.slice(0, hops.length));
      // React has committed both text layers. Re-anchor contacts to the new
      // glyphs (0 conducts at its side, 1 at its stem) before the next paint.
      measure();
    };
    const measure = () => {
      // Layout and timings are rebuilt on resize. CSS handles the entire sequence.
      const width = track.clientWidth;
      if (!width) return;
      const height = track.offsetHeight + 36;
      const bits = Array.from(track.querySelectorAll<HTMLElement>(".connection-octets:not(.connection-octets-lit) .connection-bit"));
      const contacts = bits.filter((bit) => bit.offsetWidth > 0).map((bit) => ({
        bitIndex: Number(bit.dataset.bitIndex),
        x: bit.offsetLeft + bit.offsetWidth / 2,
        y: bit.offsetTop + bit.offsetHeight * .48 + 18,
        width: bit.offsetWidth, height: bit.offsetHeight, digit: bit.textContent || "0",
      }));
      if (!contacts.length) return;
      let arrival = 160;
      const arrivals = new Map([[contacts[0].bitIndex, arrival]]);
      hops = contacts.slice(1).map((to, index) => {
        const from = contacts[index];
        const wideGap = to.x - from.x > 24;
        const start = arrival + (wideGap ? 140 : 90);
        const duration = wideGap ? 110 : 90;
        // The receiving digit charges only when the leader reaches it.
        arrival = start + duration * .18;
        arrivals.set(to.bitIndex, arrival);
        return { from, to, start, duration };
      });
      const cycle = arrival + 500;
      // Retain routes/seeds during resize. Hidden octets can return with their
      // original strikes instead of changing a discharge that is already visible.
      if (!strikes.length) strikes = createLightningStrikes(47);
      track.parentElement?.style.setProperty("animation-duration", `${cycle}ms`);
      track.style.setProperty("--connection-charge-attack", String(28 / cycle));
      track.style.setProperty("--connection-charge-decay", String(340 / cycle));
      track.querySelectorAll<HTMLElement>(".connection-bit").forEach((bit) => {
        const at = arrivals.get(Number(bit.dataset.bitIndex));
        bit.style.setProperty("--connection-charge-at", String(at === undefined ? 2 : at / cycle));
      });
      electricity.setAttribute("viewBox", `0 0 ${width} ${height}`);
      electricity.querySelectorAll<SVGGElement>(".connection-hop").forEach((group, index) => {
        const hop = hops[index];
        group.style.setProperty("--connection-hop-at", String(hop ? hop.start / cycle : 2));
        group.style.setProperty("--connection-hop-duration", String(hop ? hop.duration / cycle : 1));
      });
      drawBolts();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(track);
    return () => { observer?.disconnect(); renewBoltsRef.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (measuredOctetsRef.current === octets) return;
    measuredOctetsRef.current = octets;
    renewBoltsRef.current?.();
  }, [octets]);

  useLayoutEffect(() => {
    if (!complete) return;
    const signal = signalRef.current;
    const sweep = signal?.getAnimations?.().find((animation) =>
      "animationName" in animation && animation.animationName === "connection-light-sweep");
    const timing = sweep?.effect?.getComputedTiming();
    const duration = Number(timing?.duration);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      || !sweep?.effect || !Number.isFinite(duration) || duration <= 0) {
      onComplete?.();
      return;
    }

    // Finish this pass, including its afterglow. Changing playback rate preserves
    // the current position; changing CSS duration would jump to a different bit.
    const remaining = duration * (1 - (timing?.progress ?? 0));
    const finishMs = Math.min(650, Math.max(140, remaining / 4));
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(fallback);
      // A hidden/throttled webview must not leave a connected terminal covered.
      sweep.finish();
      onComplete?.();
    };
    const fallback = window.setTimeout(finish, finishMs + 120);
    sweep.addEventListener("finish", finish);
    sweep.effect.updateTiming({ iterations: (timing?.currentIteration ?? 0) + 1, fill: "forwards" });
    sweep.updatePlaybackRate(Math.max(1, remaining / finishMs));
    return () => {
      settled = true;
      window.clearTimeout(fallback);
      sweep.removeEventListener("finish", finish);
      sweep.effect?.updateTiming({ iterations: Infinity, fill: "none" });
      sweep.updatePlaybackRate(1);
    };
  }, [complete, onComplete]);

  return <div ref={signalRef} className={`connection-signal${running || complete ? " is-running" : " is-stopped"}${complete ? " is-finishing" : ""}`}
    onAnimationIteration={(event) => {
      if (event.target === event.currentTarget && event.animationName === "connection-light-sweep" && running && !complete) {
        setOctets(previous => createConnectionOctets(previous));
      }
    }}
    role={running ? "progressbar" : undefined} aria-label={running ? "Waiting for connection" : undefined} aria-hidden={running ? undefined : true}>
    <div className="connection-signal-field" aria-hidden="true" />
    <div className="connection-signal-track" ref={trackRef} aria-hidden="true">
      <Octets octets={octets} />
      <Octets octets={octets} illuminated />
      <svg className="connection-electricity" ref={electricityRef} preserveAspectRatio="none" focusable="false">
        {Array.from({ length: 47 }, (_, hop) => <g className="connection-hop" data-hop-index={hop} key={hop}>
          <path className="connection-arc-halo" pathLength="1" />
          <path className="connection-arc-core" pathLength="1" />
          <path className="connection-arc-branches" />
          <circle className="connection-arc-contact" r=".9" />
        </g>)}
      </svg>
    </div>
    <div className="connection-signal-ruler" aria-hidden="true" />
  </div>;
});
