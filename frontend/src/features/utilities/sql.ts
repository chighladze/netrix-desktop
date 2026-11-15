const clauses =
  /\b(UNION ALL|INSERT INTO|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE|LEFT JOIN|RIGHT JOIN|INNER JOIN|OUTER JOIN|ORDER BY|GROUP BY|IS NOT NULL|IS NULL|SELECT|FROM|WHERE|AND|OR|JOIN|ON|HAVING|LIMIT|OFFSET|VALUES|UPDATE|SET|UNION|AS|IN|NOT|BETWEEN|LIKE|EXISTS|CASE|WHEN|THEN|ELSE|END)\b/gi;

/** A conservative display formatter: strings, quoted identifiers and comments are opaque. */
export function formatSql(input: string): string {
  if (input.length > 262144) throw new Error("SQL formatting is limited to 256 KiB");
  let output = "",
    plain = "",
    i = 0;
  const flush = () => {
    output += plain
      .replace(/\s+/g, " ")
      .replace(
        clauses,
        (keyword) => `\n${/^(AND|OR)$/i.test(keyword) ? "  " : ""}${keyword.toUpperCase()}`,
      );
    plain = "";
  };
  while (i < input.length) {
    const start = i;
    if (input.startsWith("--", i) || input[i] === "#") {
      const end = input.indexOf("\n", i);
      i = end < 0 ? input.length : end + 1;
    } else if (input.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < input.length && depth) {
        if (input.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (input.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error("Unterminated SQL comment");
    } else {
      const delimiter = input[i];
      const dollar =
        delimiter === "$"
          ? input.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
          : undefined;
      if (dollar) {
        const end = input.indexOf(dollar, i + dollar.length);
        if (end < 0) throw new Error("Unterminated SQL dollar string");
        i = end + dollar.length;
      } else if (["'", '"', "`", "["].includes(delimiter)) {
        const close = delimiter === "[" ? "]" : delimiter;
        i++;
        let closed = false;
        while (i < input.length) {
          if (input[i] === "\\" && delimiter !== "[") {
            // Backslash-quote rules vary by dialect; refuse to guess a closing boundary.
            if (input[i + 1] === close)
              throw new Error("Backslash-escaped quotes require a dialect-aware formatter");
          }
          if (input[i] === close) {
            i++;
            if (input[i] === close) {
              i++;
              continue;
            }
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) throw new Error("Unterminated SQL quoted value");
      } else {
        plain += input[i++];
        continue;
      }
    }
    flush();
    output += input.slice(start, i);
  }
  flush();
  return output.trim();
}
