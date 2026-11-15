/** Dotted decimal only. Reject empty, fractional, exponent, hexadecimal and ambiguous octets. */
export function ipToLong(input: string): number {
  const parts = input.trim().split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)
  )
    return -1;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}
export const longToIp = (value: number): string =>
  `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
