const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const SIGNAL_MAX_AGE_HOURS = Number(env("SIGNAL_MAX_AGE_HOURS", "48"));
const SIGNAL_QUERIES = listEnv("SIGNAL_QUERIES", "бензин,АЗС,заправка,топливо,очередь");
const TELEGRAM_SOURCES = parseTelegramSources(
  env(
    "SIGNAL_TELEGRAM_CHANNELS",
    "krd_tipich_ru:Типичный Краснодар,krddtp1:КРДДТП,KrasnodarUMR:Краснодар ЮМР,chp_krd:ЧП Краснодар,kuban24:Кубань 24,krd_chp:Новости Краснодара",
  ),
);
const RSS_SOURCES = parseNamedUrls(env("SIGNAL_RSS_FEEDS", ""));
const DRY_RUN = process.argv.includes("--dry-run");

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const posts = [];

  for (const source of TELEGRAM_SOURCES) {
    const sourcePosts = await loadTelegramSource(source).catch((error) => {
      console.warn(`Telegram ${source.channel} skipped: ${error.message}`);
      return [];
    });
    posts.push(...sourcePosts);
    await sleep(250);
  }

  for (const source of RSS_SOURCES) {
    const sourcePosts = await loadRssSource(source).catch((error) => {
      console.warn(`RSS ${source.url} skipped: ${error.message}`);
      return [];
    });
    posts.push(...sourcePosts);
    await sleep(250);
  }

  const uniquePosts = uniqueBy(posts, (post) => post.url)
    .filter((post) => isRelevantSignal(post.text))
    .filter((post) => isFresh(post.observedAt, SIGNAL_MAX_AGE_HOURS))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

  if (DRY_RUN) {
    console.log(`Telegram sources: ${TELEGRAM_SOURCES.length}`);
    console.log(`RSS sources: ${RSS_SOURCES.length}`);
    console.log(`Signal candidates: ${uniquePosts.length}`);
    console.log(JSON.stringify(uniquePosts.slice(0, 12), null, 2));
    return;
  }

  let imported = 0;
  for (const post of uniquePosts) {
    await postSignal({
      rawText: post.text,
      sourceName: post.sourceName,
      sourceUrl: post.url,
      observedAt: post.observedAt,
    });
    imported += 1;
  }

  console.log(`Imported ${imported} public fuel signal candidates`);
}

async function loadTelegramSource(source) {
  const posts = [];
  const urls = [
    `https://t.me/s/${encodeURIComponent(source.channel)}`,
    ...SIGNAL_QUERIES.map((query) => `https://t.me/s/${encodeURIComponent(source.channel)}?q=${encodeURIComponent(query)}`),
  ];

  for (const url of urls) {
    const html = await fetchText(url);
    posts.push(...parseTelegramPosts(html, source));
    await sleep(150);
  }

  return posts;
}

async function loadRssSource(source) {
  const xml = await fetchText(source.url);
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  return blocks
    .map((block) => {
      const title = rssValue(block, "title");
      const description = htmlToText(rssValue(block, "description") || rssValue(block, "content:encoded"));
      const link = rssValue(block, "link") || source.url;
      const pubDate = rssValue(block, "pubDate") || rssValue(block, "dc:date") || new Date().toISOString();
      const date = new Date(pubDate);
      return {
        source: "rss",
        sourceName: source.name,
        url: link,
        observedAt: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString(),
        text: normalizeText(`${title}\n${description}`),
      };
    })
    .filter((post) => post.text);
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "gas-scaner-public-signals/1.0 (+https://github.com/korzhishe/gas_scaner)",
    },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function parseTelegramPosts(html, source) {
  const blocks = html.split(/<div class="tgme_widget_message\b/).slice(1);
  const posts = [];

  for (const rawBlock of blocks) {
    const block = `<div class="tgme_widget_message ${rawBlock}`;
    const postMatch = block.match(/\bdata-post="([^"]+)"/);
    const textMatch = block.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/);
    const dateMatch = block.match(/<time datetime="([^"]+)"/);
    if (!postMatch || !textMatch || !dateMatch) continue;

    const text = normalizeText(htmlToText(textMatch[1]));
    if (!text) continue;

    posts.push({
      source: "telegram",
      sourceName: source.name,
      channel: source.channel,
      postId: postMatch[1],
      url: `https://t.me/${postMatch[1]}`,
      observedAt: new Date(dateMatch[1]).toISOString(),
      text,
    });
  }

  return posts;
}

async function postSignal(signal) {
  const response = await fetch(`${COLLECTOR_URL.replace(/\/$/, "")}/api/signals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(COLLECTOR_TOKEN ? { authorization: `Bearer ${COLLECTOR_TOKEN}` } : {}),
    },
    body: JSON.stringify(signal),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Collector rejected signal ${signal.sourceUrl}: ${payload.error || response.statusText}`);
  }
}

function isRelevantSignal(text) {
  const lowered = text.toLowerCase().replace(/ё/g, "е");
  if (!/(бензин|топлив|азс|заправ|\bдт\b|дизел|очеред.*заправ|очеред.*азс|лукойл|роснефть|газпромнефть)/i.test(lowered)) return false;
  if (/(реклам|скидк|ваканси|такси|розыгрыш)/i.test(lowered)) return false;
  return /(нет|есть|будет|привез|завоз|очеред|закрыт|работа|залил|заправил|кончил|дефицит|поставка|лампочка)/i.test(lowered);
}

function isFresh(value, maxAgeHours) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= maxAgeHours * 60 * 60 * 1000;
}

function htmlToText(html) {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  );
}

function decodeHtml(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
    if (code[0] === "#") {
      const radix = code[1]?.toLowerCase() === "x" ? 16 : 10;
      const raw = radix === 16 ? code.slice(2) : code.slice(1);
      const value = Number.parseInt(raw, radix);
      return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
    }
    return named[code.toLowerCase()] || entity;
  });
}

function normalizeText(value) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseTelegramSources(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [channel, ...nameParts] = item.split(":");
      return {
        channel: channel.trim().replace(/^@/, ""),
        name: nameParts.join(":").trim() || channel.trim().replace(/^@/, ""),
      };
    });
}

function parseNamedUrls(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separator = item.lastIndexOf("|");
      if (separator === -1) {
        return { url: item, name: item };
      }
      return {
        url: item.slice(0, separator).trim(),
        name: item.slice(separator + 1).trim() || item.slice(0, separator).trim(),
      };
    });
}

function rssValue(block, tag) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  if (!match) return "";
  return decodeHtml(match[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim());
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function listEnv(name, fallback) {
  return env(name, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function env(name, fallback) {
  return process.env[name] || fallback;
}
