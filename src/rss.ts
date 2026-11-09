export interface FeedItem {
  /** Стабільний ключ для дедуплікації (посилання без query/hash) */
  key: string;
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

export interface Feed {
  title: string;
  items: FeedItem[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Текст тега: знімає CDATA, декодує entities, обрізає пробіли. */
function textOf(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  const raw = m[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : decodeEntities(raw)).trim();
}

function atomLink(entry: string): string {
  const m = entry.match(/<link\b[^>]*\bhref="([^"]+)"[^>]*>/i);
  return m ? decodeEntities(m[1]) : "";
}

export function normalizeKey(link: string): string {
  try {
    const u = new URL(link);
    return u.origin + u.pathname;
  } catch {
    return link;
  }
}

export function parseFeed(xml: string): Feed | null {
  const isRss = /<rss\b/i.test(xml) || /<channel\b/i.test(xml);
  const isAtom = /<feed\b/i.test(xml);
  if (!isRss && !isAtom) return null;

  const blocks = isRss
    ? xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []
    : xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];

  // Заголовок стрічки — перший <title> до початку перших елементів
  const head = xml.split(isRss ? /<item\b/i : /<entry\b/i)[0];
  const title = textOf(head, "title");

  const items: FeedItem[] = blocks.map((b) => {
    const link = isRss ? textOf(b, "link") : atomLink(b);
    return {
      key: normalizeKey(link || textOf(b, "guid") || textOf(b, "id")),
      title: textOf(b, "title"),
      link,
      description: textOf(b, isRss ? "description" : "summary"),
      pubDate: textOf(b, isRss ? "pubDate" : "updated") || undefined,
    };
  });

  return { title, items };
}

export type FetchFeedResult =
  | { ok: true; feed: Feed }
  | {
      ok: false;
      error: string;
      /** invalid = посилання/вміст неправильні; unreachable = не вдалося отримати (мережа, 403, 5xx) */
      kind: "invalid" | "unreachable";
      status?: number;
    };

export async function fetchFeed(url: string): Promise<FetchFeedResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, kind: "invalid", error: "Це не схоже на посилання." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, kind: "invalid", error: "Підтримуються лише http(s)-посилання." };
  }

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      headers: {
        "user-agent": "dou-jobs-bot/0.1 (personal RSS reader)",
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, kind: "unreachable", error: "Не вдалося завантажити стрічку (таймаут або помилка мережі)." };
  }
  if (!res.ok) {
    return { ok: false, kind: "unreachable", status: res.status, error: `Сервер відповів ${res.status}.` };
  }

  const feed = parseFeed(await res.text());
  if (!feed) return { ok: false, kind: "invalid", error: "За цим посиланням немає RSS/Atom-стрічки." };
  return { ok: true, feed };
}
