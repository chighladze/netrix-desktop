/** Change whitespace only: preserve numeric spelling/precision, duplicate keys and escape sequences. */
export function formatJson(input: string, indent: string | null = "  "): string {
  if (input.length > 262144) throw new Error("JSON formatting is limited to 256 KiB");
  JSON.parse(input); // Syntax validation only. Never serialize the rounded JS number representation.
  let output = "",
    depth = 0,
    inString = false,
    escaped = false;
  const line = () => (indent === null ? "" : `\n${indent.repeat(depth)}`);
  const significant = (from: number, direction: number) => {
    while (from >= 0 && from < input.length && /\s/.test(input[from])) from += direction;
    return input[from];
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inString) {
      output += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      output += c;
    } else if (c === "{" || c === "[") {
      output += c;
      depth++;
      if (depth > 128) throw new Error("JSON formatting is limited to 128 nesting levels");
      if (significant(i + 1, 1) !== (c === "{" ? "}" : "]")) output += line();
    } else if (c === "}" || c === "]") {
      depth--;
      if (significant(i - 1, -1) !== (c === "}" ? "{" : "[")) output += line();
      output += c;
    } else if (c === ",") output += c + line();
    else if (c === ":") output += indent === null ? c : ": ";
    else if (!/\s/.test(c)) output += c;
    if (output.length > 2097152) throw new Error("Formatted JSON exceeds 2 MiB");
  }
  return output;
}
