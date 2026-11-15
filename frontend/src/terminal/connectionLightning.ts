interface Point { x: number; y: number }
export interface BitContact extends Point { bitIndex: number; width: number; height: number; digit: string }
type Route = "upper" | "lower" | "cross" | "split" | "center";
interface Variant {
  id: string;
  route: Route;
  profile: readonly number[];
  source: number;
  target: number;
  forks?: number;
  double?: boolean;
}

// Profiles describe the large-scale route; every strike adds fresh fine branches,
// jagged leaders and contact positions. Values are relative to the glyph size.
export const LIGHTNING_VARIANTS: readonly Variant[] = [
  { id: "upper-arc", route: "upper", profile: [0, -.7, -1, -.7, 0], source: -.2, target: -.2 },
  { id: "lower-arc", route: "lower", profile: [0, .7, 1, .7, 0], source: .2, target: .2 },
  { id: "upper-fork", route: "upper", profile: [0, -.4, -1, -.1, -.7, 0], source: -.15, target: -.25, forks: 2 },
  { id: "lower-fork", route: "lower", profile: [0, .7, .1, 1, .4, 0], source: .25, target: .15, forks: 2 },
  { id: "falling-cross", route: "cross", profile: [0, -.5, .5, -.3, 0], source: -.28, target: .28, forks: 1 },
  { id: "rising-cross", route: "cross", profile: [0, .5, -.5, .3, 0], source: .28, target: -.28, forks: 1 },
  { id: "double-strike", route: "split", profile: [0, -.65, -.8, -.4, 0], source: 0, target: 0, double: true },
  { id: "upper-step", route: "upper", profile: [0, 0, -1, -1, -.2, -.2, 0], source: -.1, target: .08 },
  { id: "lower-step", route: "lower", profile: [0, 0, 1, 1, .2, .2, 0], source: .1, target: -.08 },
  { id: "central-zigzag", route: "center", profile: [0, -.45, .5, -.5, .45, 0], source: 0, target: 0, forks: 1 },
];

export interface LightningStrike { variant: number; seed: number }

/** Random bags use all ten forms without repeating a route on consecutive hops.
 * Also avoid reusing a pair's previous form on the next pass. Small (10-item)
 * backtracking prevents a shuffle from leaving two upper/lower forms at its end.
 */
export function createLightningStrikes(count: number, previous: readonly LightningStrike[] = [], random = Math.random): LightningStrike[] {
  const result: LightningStrike[] = [];
  let last = previous[previous.length - 1]?.variant;
  while (result.length < count) {
    const shuffled = LIGHTNING_VARIANTS.map((_, index) => index);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const order: number[] = [];
    const arrange = (remaining: number[], preceding?: number): boolean => {
      if (!remaining.length) return true;
      for (const candidate of remaining) {
        if (preceding !== undefined && LIGHTNING_VARIANTS[candidate].route === LIGHTNING_VARIANTS[preceding].route) continue;
        if (previous[result.length + order.length]?.variant === candidate) continue;
        order.push(candidate);
        if (arrange(remaining.filter(value => value !== candidate), candidate)) return true;
        order.pop();
      }
      return false;
    };
    if (!arrange(shuffled, last)) {
      // Keep generation bounded even if a future variant set cannot form a bag.
      order.push(shuffled.find(candidate => candidate !== previous[result.length]?.variant
        && (last === undefined || LIGHTNING_VARIANTS[candidate].route !== LIGHTNING_VARIANTS[last].route))!);
    }
    for (const variant of order) {
      if (result.length === count) break;
      result.push({ variant, seed: random() * 10_000 });
      last = variant;
    }
  }
  return result;
}

const pointText = ({ x, y }: Point) => `${x.toFixed(2)},${y.toFixed(2)}`;
const polyline = (points: Point[]) => points.map((point, i) => `${i ? "L" : "M"}${pointText(point)}`).join("");

export function lightningPath(from: BitContact, to: BitContact, strike: LightningStrike) {
  const variant = LIGHTNING_VARIANTS[strike.variant];
  const noise = (sample: number) => Math.sin(sample * 127.1 + strike.seed * 73.9);
  const attach = (bit: BitContact, band: number, incoming: boolean, sample: number): Point => ({
    // 0 conducts along its side, 1 along its stem; endpoints stay on the glyph.
    x: bit.x + ((bit.digit === "0" ? .23 : .02) * (incoming ? -1 : 1) + noise(sample) * .06) * bit.width,
    y: bit.y + (band + noise(sample + 1) * .09) * bit.height,
  });
  const source = attach(from, variant.source, false, 19);
  const contact = attach(to, variant.target, true, 29);
  const distance = contact.x - source.x;
  const amplitude = Math.min(12, Math.max(5, Math.min(from.height, to.height) * .32 + distance * .035));
  const steps = Math.max(8, Math.min(24, Math.ceil(distance / 4)));
  const points: Point[] = [source];
  for (let step = 1; step < steps; step++) {
    const t = step / steps;
    const position = t * (variant.profile.length - 1);
    const index = Math.floor(position), fraction = position - index;
    const bend = variant.profile[index] * (1 - fraction) + variant.profile[index + 1] * fraction;
    points.push({
      x: source.x + distance * (t + noise(step + 40) * .22 / steps),
      y: source.y + (contact.y - source.y) * t + amplitude * (bend + noise(step) * .2 * Math.sin(Math.PI * t)),
    });
  }
  points.push(contact);
  let main = polyline(points), branches = "";
  if (variant.double) {
    main += polyline(points.map((point, index) => {
      const t = index / steps;
      const baseline = source.y + (contact.y - source.y) * t;
      return { x: point.x, y: baseline - (point.y - baseline) * .8 };
    }));
  }
  for (let fork = 0; fork < (variant.forks ?? 0); fork++) {
    const index = 2 + Math.floor((noise(60 + fork) + 1) * .5 * (steps - 4));
    const point = points[index];
    const direction = variant.route === "upper" ? -1 : variant.route === "lower" ? 1 : noise(70 + fork) > 0 ? 1 : -1;
    const reach = 4 + Math.abs(noise(80 + fork)) * 4;
    branches += polyline([point,
      { x: point.x + distance * .13, y: point.y + direction * reach * .4 },
      { x: point.x + distance * .06, y: point.y + direction * reach * .7 },
      { x: point.x + distance * .18, y: point.y + direction * reach },
    ]);
  }
  return { main, branches, source, contact };
}
