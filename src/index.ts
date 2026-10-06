import { tool, type Tool } from "ai";
import { z } from "zod";

export const VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://api.pexafy.com";
const QUERY_MAX_LENGTH = 250;
const MAX_RESULTS = 20;

export type PexafyToolOptions = {
  /** Pexafy API key. Defaults to the `PEXAFY_API_KEY` environment variable. */
  apiKey?: string;
  /** Photos per search when the model gives no `count`. Default 6, max 20. */
  maxResults?: number;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Retries on a per-minute rate limit, a 5xx or a network failure. Default 2. */
  maxRetries?: number;
  /** API origin. Default `https://api.pexafy.com`. */
  baseUrl?: string;
  /** A custom fetch, for tests or proxies. */
  fetch?: typeof globalThis.fetch;
};

export type Orientation = "landscape" | "portrait" | "square";

export type SearchPhotosInput = { query: string; orientation?: Orientation[]; count?: number };
export type FindSimilarPhotosInput = { photo_id: string; count?: number };
export type GetPhotoInput = { photo_id: string };

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

export type PexafyPhotos = { photos: PexafyPhoto[] };

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
        "Get a free key at https://pexafy.com/dashboard/api-keys/create/",
    );
  }
  return key;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** How long to wait before retrying this response, or null when retrying cannot help. */
function retryDelay(response: Response, body: any, attempt: number): number | null {
  const header = response.headers.get("retry-after");
  const retryAfter = header === null ? Number.NaN : Number(header);
  const hinted = Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 60;
  const delay = hinted ? retryAfter * 1000 : Math.min(2 ** attempt, 30) * 1000;
  if (response.status >= 500) return delay;
  if (response.status !== 429) return null;
  // A spent daily or monthly quota (DAILY_QUOTA_EXCEEDED, QUOTA_EXCEEDED) does not clear
  // in a minute: only the per-minute rate limit is worth waiting for.
  const code = body?.error?.code;
  if (code ? code !== "RATE_LIMITED" : header !== null && !hinted) return null;
  return delay;
}

async function request(
  options: PexafyToolOptions,
  path: string,
  params: Record<string, string | number | string[] | undefined>,
  signal?: AbortSignal,
): Promise<any> {
  const url = new URL(`${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/api/v1${path}`);
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
  const timeoutMs = options.timeoutMs ?? 30_000;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal!.reason);
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    let body: any;
    try {
      response = await doFetch(url, { headers, signal: controller.signal });
      body = await response.json().catch(() => undefined);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const message = controller.signal.aborted
        ? `Pexafy did not answer within ${timeoutMs} ms`
        : `Could not reach Pexafy: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < maxRetries) {
        await sleep(Math.min(2 ** attempt, 30) * 1000, signal);
        continue;
      }
      throw new PexafyError(message);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (response.ok && body?.success !== false && body && "data" in body) return body;

    const delay = response.ok ? null : retryDelay(response, body, attempt);
    if (delay !== null && attempt < maxRetries) {
      await sleep(delay, signal);
      continue;
    }
    if (response.ok) {
      throw new PexafyError(`Unexpected response from Pexafy (HTTP ${response.status}, no data)`);
    }
    const err = body?.error ?? {};
    const detail = err.message ?? body?.detail ?? response.statusText ?? "request failed";
    const prefix =
      response.status === 429
        ? "Pexafy rate limit or quota reached"
        : response.status === 404
          ? "No such Pexafy photo"
          : response.status === 401 || response.status === 403
            ? "Pexafy rejected the API key"
            : "Pexafy request failed";
    throw new PexafyError(
      `${prefix}: ${typeof detail === "string" ? detail : JSON.stringify(detail)} (HTTP ${response.status})`,
      response.status,
      err.code,
    );
  }
}

function photos(body: any): PexafyPhotos {
  const list: ApiPhoto[] = Array.isArray(body.data) ? body.data : [];
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

/** Search free-to-use stock photos by describing the scene. */
export const searchPhotos = (
  options: PexafyToolOptions = {},
): Tool<SearchPhotosInput, PexafyPhotos> =>
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
export const findSimilarPhotos = (
  options: PexafyToolOptions = {},
): Tool<FindSimilarPhotosInput, PexafyPhotos> =>
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
export const getPhoto = (options: PexafyToolOptions = {}): Tool<GetPhotoInput, PexafyPhoto> =>
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
