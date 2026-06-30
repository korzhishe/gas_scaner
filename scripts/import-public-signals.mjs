const COLLECTOR_URL = env("COLLECTOR_URL", "http://127.0.0.1:8090");
const COLLECTOR_TOKEN = process.env.COLLECTOR_TOKEN || "";
const SIGNAL_MAX_AGE_HOURS = Number(env("SIGNAL_MAX_AGE_HOURS", "48"));
const SIGNAL_QUERIES = listEnv("SIGNAL_QUERIES", "бензин,АЗС,заправка,топливо,очередь");
const SIGNAL_PARSE_LINKS = env("SIGNAL_PARSE_LINKS", "1") !== "0";
const SIGNAL_ARTICLE_MAX_PER_RUN = Number(env("SIGNAL_ARTICLE_MAX_PER_RUN", "16"));
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

  const sourceSignals = uniqueBy(posts, (post) => post.url)
    .filter((post) => isRelevantSignal(post.text))
    .filter((post) => isFresh(post.observedAt, SIGNAL_MAX_AGE_HOURS))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));

  const articleSignals = SIGNAL_PARSE_LINKS ? await loadLinkedArticleSignals(sourceSignals) : [];
  const uniquePosts = uniqueBy([...sourceSignals, ...articleSignals], (post) => post.url).sort(
    (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
  );

  if (DRY_RUN) {
    console.log(`Telegram sources: ${TELEGRAM_SOURCES.length}`);
    console.log(`RSS sources: ${RSS_SOURCES.length}`);
    console.log(`Linked article candidates: ${articleSignals.length}`);
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
      ...(post.category ? { category: post.category } : {}),
      ...(post.confidence ? { confidence: post.confidence } : {}),
      ...(post.fuelTypes?.length ? { fuelTypes: post.fuelTypes } : {}),
      ...(post.note ? { note: post.note } : {}),
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

    const textHtml = textMatch[1];
    const text = normalizeText(htmlToText(textHtml));
    if (!text) continue;

    posts.push({
      source: "telegram",
      sourceName: source.name,
      channel: source.channel,
      postId: postMatch[1],
      url: `https://t.me/${postMatch[1]}`,
      observedAt: new Date(dateMatch[1]).toISOString(),
      text,
      links: extractLinks(textHtml, `https://t.me/${postMatch[1]}`).filter(isArticleLink),
    });
  }

  return posts;
}

async function loadLinkedArticleSignals(posts) {
  const candidates = uniqueBy(
    posts.flatMap((post) => (post.links || []).map((url) => ({ url, post }))),
    (candidate) => candidate.url,
  ).slice(0, SIGNAL_ARTICLE_MAX_PER_RUN);
  const signals = [];

  for (const candidate of candidates) {
    const signal = await loadArticleSignal(candidate.url, candidate.post).catch((error) => {
      console.warn(`Article ${candidate.url} skipped: ${error.message}`);
      return null;
    });
    if (signal) signals.push(signal);
    await sleep(250);
  }

  return signals;
}

async function loadArticleSignal(url, sourcePost) {
  const html = await fetchText(url);
  const article = parseArticleHtml(html, url);
  const articleText = normalizeText(`${article.title}\n${article.text}`);
  if (!articleText || !isRelevantSignal(articleText)) {
    return null;
  }

  const observedAt = isFresh(article.publishedAt, SIGNAL_MAX_AGE_HOURS) ? article.publishedAt : sourcePost.observedAt;
  const fuelTypes = extractFuelTypes(articleText);
  const place = extractPlaceLabel(articleText);
  const addressHints = extractAddressHints(article.text);
  const count = extractStationCount(article.text);
  const hasCardOnly = /топлив[а-яё]*\s+карт|исключительно\s+по\s+карт/i.test(article.text);
  const articleHost = new URL(url).hostname.replace(/^www\./, "");
  const noteParts = [];

  if (place) noteParts.push(place);
  if (count) noteParts.push(`${count} АЗС`);
  noteParts.push(`есть ${fuelTypes.length ? fuelTypes.join(", ") : "топливо"}`);
  if (hasCardOnly) noteParts.push("есть АЗС только по топливным картам");
  if (addressHints.length) {
    const extraCount = addressHints.length > 7 ? ` +${addressHints.length - 7}` : "";
    noteParts.push(`где: ${addressHints.slice(0, 7).join(", ")}${extraCount}`);
  }

  return {
    source: "article",
    sourceName: `${sourcePost.sourceName} -> ${article.siteName || articleHost}`,
    url,
    observedAt,
    text: normalizeText([article.title, sourcePost.text, article.text, `Пост-источник: ${sourcePost.url}`].join("\n\n")),
    category: "fuel_available",
    confidence: 0.84,
    fuelTypes,
    note: truncateText(noteParts.join("; "), 240),
  };
}

function parseArticleHtml(html, url) {
  const title = normalizeText(htmlToText(metaValue(html, ["og:title", "twitter:title"]) || titleValue(html) || ""));
  const siteName = normalizeText(htmlToText(metaValue(html, ["og:site_name"]) || ""));
  const publishedAt = parseDateValue(
    metaValue(html, ["article:published_time", "datePublished", "pubdate", "publishdate"]) || timeValue(html),
  );
  const bodyHtml = articleBodyHtml(html);
  const htmlText = normalizeText(articleHtmlToText(bodyHtml || html));
  const schemaText = normalizeText(jsonLdArticleBody(html));
  const text = htmlText.length > schemaText.length ? htmlText : schemaText || htmlText;

  return {
    url,
    title,
    siteName,
    publishedAt,
    text,
  };
}

function articleBodyHtml(html) {
  const entryMatch = html.match(
    /<div\b[^>]*class=["'][^"']*(?:entry-content|article-content|post-content|js-entry-content)[^"']*["'][^>]*>([\s\S]*?)(?:<div\b[^>]*class=["'][^"']*(?:related-posts|entry-footer|post-navigation)|<\/article>|<\/main>)/i,
  );
  if (entryMatch) return entryMatch[1];

  const articleMatch = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) return articleMatch[1];

  const mainMatch = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) return mainMatch[1];

  const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

function articleHtmlToText(html) {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  );
}

function jsonLdArticleBody(html) {
  const scripts = html.match(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  for (const script of scripts) {
    const raw = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    if (!raw) continue;

    try {
      const body = findArticleBody(JSON.parse(raw));
      if (body) return body;
    } catch {
      continue;
    }
  }
  return "";
}

function findArticleBody(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.articleBody === "string") return value.articleBody;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArticleBody(item);
      if (found) return found;
    }
    return "";
  }

  for (const item of Object.values(value)) {
    const found = findArticleBody(item);
    if (found) return found;
  }
  return "";
}

function metaValue(html, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const key = attrValue(tag, "property") || attrValue(tag, "name") || attrValue(tag, "itemprop");
    if (key && wanted.has(key.toLowerCase())) {
      return attrValue(tag, "content");
    }
  }
  return "";
}

function titleValue(html) {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1]) : "";
}

function timeValue(html) {
  const match = html.match(/<time\b[^>]*datetime=(["'])(.*?)\1/i);
  return match ? decodeHtml(match[2]) : "";
}

function attrValue(tag, name) {
  const match = tag.match(new RegExp(`\\b${escapeRegex(name)}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decodeHtml(match[2] || match[3] || match[4] || "") : "";
}

function parseDateValue(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\b[^>]*\bhref=(["'])(.*?)\1/gi;
  let match;

  while ((match = regex.exec(html))) {
    try {
      const url = new URL(decodeHtml(match[2]).trim(), baseUrl);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|yclid|fbclid|gclid|from)$/i.test(key)) url.searchParams.delete(key);
      }
      links.push(url.toString());
    } catch {
      continue;
    }
  }

  return uniqueBy(links, (url) => url);
}

function isArticleLink(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const blockedHosts = [
      "t.me",
      "telegram.me",
      "telegram.org",
      "max.ru",
      "vk.com",
      "vk.ru",
      "ok.ru",
      "youtube.com",
      "youtu.be",
      "rutube.ru",
      "instagram.com",
      "facebook.com",
      "x.com",
      "twitter.com",
      "whatsapp.com",
    ];

    if (blockedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) return false;
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|mp4|mov|mp3|zip|rar|7z)$/i.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
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
  return /(нет|есть|будет|привез|завоз|очеред|закрыт|работа|залил|заправил|кончил|дефицит|поставка|лампочка|налич|продаж|отпуска)/i.test(
    lowered,
  );
}

function isFresh(value, maxAgeHours) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() <= maxAgeHours * 60 * 60 * 1000;
}

function extractFuelTypes(text) {
  const lowered = text.toLowerCase().replace(/ё/g, "е");
  const fuels = [];
  if (/аи[-\s–—]?100/.test(lowered)) fuels.push("АИ-100");
  if (/аи[-\s–—]?98/.test(lowered)) fuels.push("АИ-98");
  if (/аи[-\s–—]?95/.test(lowered)) fuels.push("АИ-95");
  if (/аи[-\s–—]?92/.test(lowered)) fuels.push("АИ-92");
  if (/\bдт\b|дизел/.test(lowered)) fuels.push("ДТ");
  if (/\bгаз\b|метан|пропан/.test(lowered)) fuels.push("Газ");
  if (!fuels.length && /бензин|топлив|заправ/.test(lowered)) fuels.push("Бензин");
  return fuels;
}

function extractPlaceLabel(text) {
  const match = text.match(
    /(?:^|[\s,.;:])в\s+(Краснодаре|Новороссийске|Темрюке|Крымске|Анапе|Геленджике|Сочи|Туапсе|Ейске|Армавире|Славянске-на-Кубани)(?=$|[\s,.;:])/i,
  );
  return match ? `в ${capitalizeFirst(match[1].toLowerCase())}` : "";
}

function extractStationCount(text) {
  const match = text.match(/\b(?:на\s+)?(\d{1,3})\s+(?:АЗС|автозаправ|заправк)/i);
  return match ? match[1] : "";
}

function extractAddressHints(text) {
  const sentences = uniqueBy(
    text
      .replace(/\r/g, "")
      .split(/\n+|(?<=[.!?])\s+/)
      .map((item) => normalizeText(item)),
    (item) => item.toLowerCase(),
  );
  const hints = [];

  for (const sentence of sentences) {
    if (!/(улиц|ул\.|шоссе|проспект|пр-т|сел[аое]|сёл[аое]|станиц|пос[её]лк|км)/i.test(sentence)) continue;
    if (!/(АЗС|заправ|топлив|бензин|отпуска|работа)/i.test(sentence)) continue;
    hints.push(...extractAddressPieces(sentence));
  }

  return uniqueBy(hints, (item) => item.toLowerCase()).slice(0, 12);
}

function extractAddressPieces(sentence) {
  const markerMatch = sentence.match(/(?:расположены|находятся|адрес[аы]?|АЗС\s+на|заправк[а-яё]*\s+на)\s+(.+)/i);
  let chunk = markerMatch ? markerMatch[1] : sentence;
  chunk = chunk
    .replace(/\s+(?:отпускают|отпускали|дают|дали|сообщил[а-яё]*|жителей\s+просят|куда\s+не\s+стоит)(?:\s|$)[\s\S]*$/i, "")
    .replace(/(^|[\s,.;:])а\s+также(?=$|[\s,.;:])/gi, ",")
    .replace(/(^|[\s,.;:])и(?=$|[\s,.;:])/gi, ",");

  return chunk
    .split(",")
    .map(cleanAddressHint)
    .filter(Boolean);
}

function cleanAddressHint(value) {
  const cleaned = value
    .replace(/^[-–—:;.\s]+/g, "")
    .replace(/\s+/g, " ")
    .replace(
      /^(?:(?:на|в|во|по)\s+)*(?:улицах?|улице|ул\.?|проспекте?|проспект|пр-т|селах?|сёлах?|селе|пос[её]лке|станице|ст\.?)\s+/i,
      "",
    )
    .replace(/[.;,:\s]+$/g, "")
    .trim();

  if (cleaned.length < 3 || cleaned.length > 80) return "";
  if (/(АЗС|заправк|топлив|бензин|работающ|расположен|исключительно)$/i.test(cleaned)) return "";
  return capitalizeFirst(cleaned);
}

function capitalizeFirst(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "";
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

function truncateText(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trim()}...`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
