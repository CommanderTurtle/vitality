import { UsageError } from "./args.js";

function validatePathSegments(pathname: string, original: string): void {
  const decoded = pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new UsageError(`base contains invalid percent encoding: ${JSON.stringify(original)}`);
    }
  });
  if (decoded.some((segment) => segment === "." || segment === "..")) {
    throw new UsageError(`base cannot contain . or .. path segments: ${JSON.stringify(original)}`);
  }
}

export function normalizeBase(raw: string): string {
  const value = raw.trim();
  if (value === "" || value === "./") return value;
  if (value.includes("\\") || /[\r\n\t]/u.test(value)) {
    throw new UsageError(`base contains unsupported characters: ${JSON.stringify(raw)}`);
  }

  if (/^https?:\/\//iu.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new UsageError(`base is not a valid URL: ${JSON.stringify(raw)}`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new UsageError("base URLs cannot contain credentials, a query, or a fragment");
    }
    validatePathSegments(parsed.pathname, raw);
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    return parsed.href;
  }

  if (!value.startsWith("/")) {
    throw new UsageError(`base must be /, /project/, ./, empty, or an http(s) URL: ${JSON.stringify(raw)}`);
  }
  if (value.includes("?") || value.includes("#") || value.startsWith("//")) {
    throw new UsageError(`base is not a valid absolute URL path: ${JSON.stringify(raw)}`);
  }
  validatePathSegments(value, raw);
  return value.endsWith("/") ? value : `${value}/`;
}
