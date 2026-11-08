// The template config intentionally uses JSON-compatible values. These small
// scanners handle comments and trailing commas without introducing a runtime
// dependency into the customer repository. Both track JSON strings, so string
// contents such as "//", "/*" or ", }" are never rewritten.

function stripComments(source: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
}

// Runs after stripComments, so only whitespace can separate a trailing comma
// from the closing bracket.
function stripTrailingCommas(source: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
    } else if (character === ",") {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === "}" || source[next] === "]") continue;
    }
    output += character;
  }
  return output;
}

export function parseJsonc(source: string): unknown {
  return JSON.parse(stripTrailingCommas(stripComments(source))) as unknown;
}
