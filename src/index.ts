import { tool } from "ai";
import { z } from "zod";

export const VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://api.pexafy.com";
const QUERY_MAX_LENGTH = 250;
const MAX_RESULTS = 20;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export type PexafyToolOptions = {
  /** Pexafy API key. Falls back to the `PEXAFY_API_KEY` environment variable. */
  apiKey?: string;
  /** How many photos a search returns when the model does not ask for a number. Default 6. */
  maxResults?: number;
  /** API origin. Default `https://api.pexafy.com`. */
  baseUrl?: string;
  /** Retries on 429 and 5xx, honouring `Retry-After`. Default 2. */
  maxRetries?: number;
  /** A custom fetch, for tests or proxies. */
  fetch?: typeof globalThis.fetch;
};

/** What the model reads of one photo. */
export type PexafyPhoto = {
  rank: number;
  photo_id: string;
  alt_text: string;
  url: string;
  thumbnail_url: string;
  width: number | null;
  height: number | null;
  orientation: string;
  dominant_color: string;
  photographer: string;
  source: string;
  source_page_url: string | null;
  license: string;
  credit: string;
};

export class PexafyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PexafyError";
  }
}

// -- what the model reads ----------------------------------------------------

const FREE_TEXT_MAX_LENGTH = 300;
const NO_NAME = new Set(["unknown", "none", "null", "undefined", "n/a", "nan"]);
const CREDIT_LINE = /^(Photo) by (.*?)( on .*)$/s;

/** Third-party text as the model may read it: one line, no control or format character, capped. */
export function cleanText(value: unknown, limit = FREE_TEXT_MAX_LENGTH): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** A photographer's name without placeholder words; "" when nothing real is left. */
export function cleanName(name: unknown): string {
  const words = cleanText(name).split(" ").filter(Boolean);
  let kept = words.filter((w) => !NO_NAME.has(w.toLowerCase()));
  if (kept.length < words.length && kept.length === 1 && kept[0].toLowerCase() === "photographer") {
    kept = [];
  }
  const cleaned = kept.join(" ");
  return /^\d+$/.test(cleaned) ? "" : cleaned;
}

/** "Photo by nympha57 None on Pexels" -> "Photo by nympha57 on Pexels". */
export function cleanCredit(line: unknown): string {
  const text = cleanText(line, 400);
  const match = CREDIT_LINE.exec(text);
  if (!match) return text;
  const [, lead, who, rest] = match;
  const name = cleanName(who);
  return name ? `${lead} by ${name}${rest}` : `${lead}${rest}`;
}

type ApiPhoto = Record<string, any>;

export function summarize(photo: ApiPhoto, rank: number): PexafyPhoto {
  const urls = photo.urls ?? {};
  return {
    rank,
    photo_id: photo.photo_id ?? "",
    alt_text: cleanText(photo.alt_description || photo.description || photo.source_description),
    url: urls.regular || photo.image_url || "",
    thumbnail_url: urls.small || urls.thumb || "",
    width: photo.width ?? null,
    height: photo.height ?? null,
    orientation: photo.orientation ?? "",
    dominant_color: photo.color_hex ?? "",
    photographer: cleanName(photo.photographer_full_name) || cleanName(photo.photographer_username),
    source: photo.source ?? "",
    source_page_url: photo.source_image_url ?? null,
    license: photo.license_type ?? "",
    credit: cleanCredit(photo.attribution?.plain),
  };
}

// -- the API -----------------------------------------------------------------

function resolveKey(options: PexafyToolOptions): string {
  const key =
    options.apiKey ??
    (typeof process !== "undefined" ? process.env?.PEXAFY_API_KEY : undefined);
  if (!key) {
    throw new PexafyError(
      "No Pexafy API key. Pass { apiKey } or set PEXAFY_API_KEY. " +
        "Keys are created at https://pexafy.com/dashboard/api-keys/ (free plan, no card).",
    );
  }
  return key;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

async function request(
  options: PexafyToolOptions,
  path: string,
  params: Record<string, string | number | string[] | undefined>,
  signal?: AbortSignal,
): Promise<any> {
  const url = new URL(`${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/api/v1${path}`);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(v));
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const headers = {
    "x-api-key": resolveKey(options),
    accept: "application/json",
    "user-agent": `pexafy-ai-sdk/${VERSION}`,
  };
  const maxRetries = options.maxRetries ?? 2;

  for (let attempt = 0; ; attempt++) {
    const response = await doFetch(url, { headers, signal });
    if (RETRY_STATUS.has(response.status) && attempt < maxRetries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 60) * 1000
        : Math.min(2 ** attempt, 30) * 1000;
      await sleep(delay, signal);
      continue;
    }
    let body: any = {};
    try {
      body = await response.json();
    } catch {
      // Not JSON: the status line below says enough.
    }
    if (response.ok && body.success !== false) return body;
    const err = body.error ?? {};
    const message = err.message ?? body.detail ?? response.statusText ?? "request failed";
    const prefix =
      response.status === 429
        ? "Pexafy rate limit or quota reached"
        : response.status === 404
          ? "No such Pexafy photo"
          : "Pexafy request failed";
    throw new PexafyError(
      `${prefix}: ${typeof message === "string" ? message : JSON.stringify(message)} (HTTP ${response.status})`,
      response.status,
      err.code,
    );
  }
}

function photos(body: any) {
  const list: ApiPhoto[] = body.data ?? [];
  return { photos: list.map((p, i) => summarize(p, i + 1)) };
}

// -- the tools ---------------------------------------------------------------

const photoId = z
  .string()
  .min(1)
  .describe(
    "A Pexafy photo_id, as returned by a previous Pexafy search (e.g. '019e1ecb-0039-7da6-b1ca-987ee4d337c0').",
  );
const count = z
  .number()
  .int()
  .min(1)
  .max(MAX_RESULTS)
  .optional()
  .describe(`How many photos to return, 1 to ${MAX_RESULTS}.`);

/**
 * Search free-to-use stock photos by describing the scene.
 *
 * ```ts
 * import { generateText, stepCountIs } from "ai";
 * import { searchPhotos } from "@pexafy/ai-sdk";
 *
 * const { text } = await generateText({
 *   model: "anthropic/claude-haiku-4.5",
 *   tools: { searchPhotos: searchPhotos() },
 *   stopWhen: stepCountIs(3),
 *   prompt: "Find a header photo for a post about remote work.",
 * });
 * ```
 */
export const searchPhotos = (options: PexafyToolOptions = {}) =>
  tool({
    description:
      "Find real, free-to-use stock photographs (Unsplash, Pexels, Pixabay and other libraries) " +
      "by describing the scene in plain English. Use it whenever you need a photo: a blog or " +
      "article header, a hero image, an illustration for a section, a slide or newsletter " +
      "picture. It finds photographs that already exist; it does not generate or edit images, " +
      "and does not find illustrations, logos, icons or named people. Each result has an image " +
      "URL, alt text, its licence and the credit line to print next to the photo.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(QUERY_MAX_LENGTH)
        .describe(
          "The photograph you want, as one concise English sentence about its visible subject " +
            "and scene, e.g. 'two colleagues laughing in a bright open-plan office'. Full " +
            "sentences rank better than keyword lists: the search matches meaning. Describe " +
            "what should be in the picture, not what it is for.",
        ),
      orientation: z
        .array(z.enum(["landscape", "portrait", "square"]))
        .optional()
        .describe(
          "Leave unset unless a shape is actually required (a wide banner: landscape; a phone " +
            "wallpaper or a vertical story: portrait). It is a hard filter that drops every " +
            "photo of another shape before ranking, so setting it without need loses the best " +
            "matches. Several values may be combined.",
        ),
      count,
    }),
    execute: async ({ query, orientation, count }, { abortSignal }) =>
      photos(
        await request(
          options,
          "/search/photos",
          { q: query, orientation, per_page: count ?? options.maxResults ?? 6 },
          abortSignal,
        ),
      ),
  });

/** Find photos that look like one returned by an earlier search. */
export const findSimilarPhotos = (options: PexafyToolOptions = {}) =>
  tool({
    description:
      "Find stock photographs that look like a photo returned by an earlier Pexafy search: same " +
      "subject, composition and mood. Use it to offer alternatives to a photo that is close but " +
      "not quite right, or to build a consistent set. Takes the photo_id of that photo.",
    inputSchema: z.object({ photo_id: photoId, count }),
    execute: async ({ photo_id, count }, { abortSignal }) =>
      photos(
        await request(
          options,
          `/photos/${encodeURIComponent(photo_id)}/similar`,
          { per_page: count ?? options.maxResults ?? 6 },
          abortSignal,
        ),
      ),
  });

/** One photo's details and credit line, by photo_id. */
export const getPhoto = (options: PexafyToolOptions = {}) =>
  tool({
    description:
      "Get the details of one Pexafy photo by its photo_id: image URL, size, alt text, licence " +
      "and the credit line to print next to it.",
    inputSchema: z.object({ photo_id: photoId }),
    execute: async ({ photo_id }, { abortSignal }) =>
      summarize(
        (await request(options, `/photos/${encodeURIComponent(photo_id)}`, {}, abortSignal)).data,
        1,
      ),
  });

/** The three tools, sharing one set of options. */
export const pexafyTools = (options: PexafyToolOptions = {}) => ({
  searchPhotos: searchPhotos(options),
  findSimilarPhotos: findSimilarPhotos(options),
  getPhoto: getPhoto(options),
});
