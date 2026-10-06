import { asSchema } from "ai";
import { describe, expect, it } from "vitest";
import {
  cleanCredit,
  cleanName,
  cleanText,
  findSimilarPhotos,
  getPhoto,
  pexafyTools,
  PexafyError,
  searchPhotos,
  summarize,
  VERSION,
} from "../src/index";
import pkg from "../package.json";

const PHOTO = {
  photo_id: "019e1ea7-2e82-7a34-a451-4c6c7c8250f4",
  image_url: "https://images.example.com/full.jpg",
  urls: { thumb: "t", small: "s", regular: "r" },
  width: 4896,
  height: 3264,
  orientation: "landscape",
  color_hex: "#CAB8B4",
  photographer_username: "nympha57",
  photographer_full_name: "nympha57 None",
  source: "Pexels",
  license_type: "free",
  source_image_url: "https://www.pexels.com/photo/1",
  alt_description: "Red bicycle​ against\n a white wall",
  attribution: { plain: "Photo by nympha57 None on Pexels (https://pexafy.com/legal/licenses/#pexels)" },
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string };
type Call = { url: URL; headers: Record<string, string> };

/** A fetch that plays the replies in order; `"network"` throws, `"hang"` waits for the abort. */
function fakeFetch(replies: Array<Reply | "network" | "hang">) {
  const calls: Call[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const r = replies.shift()!;
    if (r === "network") throw new TypeError("fetch failed");
    if (r === "hang") {
      return new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    }
    return new Response(r.raw ?? JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data } });
const fail = (status: number, code: string, message: string, headers?: Record<string, string>): Reply => ({
  status,
  headers,
  body: { success: false, data: null, error: { code, message } },
});

// The AI SDK calls execute(input, options); v7 types it on a union, hence `any`.
const run = (t: any, input: unknown, abortSignal?: AbortSignal) =>
  t.execute(input, { toolCallId: "1", messages: [], abortSignal });

describe("what the model receives", () => {
  it("sends the query, filters and key", async () => {
    const { fetch, calls } = fakeFetch([ok([PHOTO])]);
    await run(searchPhotos({ apiKey: "k", fetch, maxResults: 4 }), {
      query: "red bicycle",
      orientation: ["landscape", "square"],
    });
    const { url, headers } = calls[0];
    expect(url.href.startsWith("https://api.pexafy.com/api/v1/search/photos?")).toBe(true);
    expect(url.searchParams.get("q")).toBe("red bicycle");
    expect(url.searchParams.getAll("orientation")).toEqual(["landscape", "square"]);
    expect(url.searchParams.get("per_page")).toBe("4");
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["user-agent"]).toBe(`pexafy-ai-sdk/${VERSION}`);
  });

  it("returns compact, cleaned records", async () => {
    const { fetch } = fakeFetch([ok([PHOTO])]);
    const out = await run(searchPhotos({ apiKey: "k", fetch }), { query: "x", count: 2 });
    expect(out).toEqual({
      photos: [
        {
          rank: 1,
          photo_id: PHOTO.photo_id,
          alt_text: "Red bicycle against a white wall",
          url: "r",
          thumbnail_url: "s",
          width: 4896,
          height: 3264,
          orientation: "landscape",
          dominant_color: "#CAB8B4",
          photographer: "nympha57",
          source: "Pexels",
          source_page_url: "https://www.pexels.com/photo/1",
          license: "free",
          credit: "Photo by nympha57 on Pexels (https://pexafy.com/legal/licenses/#pexels)",
        },
      ],
    });
  });

  it("count overrides maxResults, default is 6", async () => {
    const { fetch, calls } = fakeFetch([ok([]), ok([])]);
    const t = searchPhotos({ apiKey: "k", fetch });
    await run(t, { query: "x" });
    await run(t, { query: "x", count: 12 });
    expect(calls.map((c) => c.url.searchParams.get("per_page"))).toEqual(["6", "12"]);
  });

  it("an empty result is an empty list", async () => {
    const { fetch } = fakeFetch([ok([])]);
    expect(await run(searchPhotos({ apiKey: "k", fetch }), { query: "x" })).toEqual({ photos: [] });
  });

  it("similar and get hit their routes, photo_id is escaped, baseUrl may end with /", async () => {
    const { fetch, calls } = fakeFetch([ok([PHOTO]), ok(PHOTO)]);
    const opts = { apiKey: "k", fetch, baseUrl: "https://example.test/" };
    await run(findSimilarPhotos(opts), { photo_id: "a/b", count: 3 });
    const one = await run(getPhoto(opts), { photo_id: PHOTO.photo_id });
    expect(calls[0].url.href).toBe("https://example.test/api/v1/photos/a%2Fb/similar?per_page=3");
    expect(calls[1].url.pathname).toBe(`/api/v1/photos/${PHOTO.photo_id}`);
    expect(one.photo_id).toBe(PHOTO.photo_id);
  });

  it("the model sees only query, orientation and count", async () => {
    const schema: any = await asSchema(searchPhotos({ apiKey: "k" }).inputSchema).jsonSchema;
    expect(Object.keys(schema.properties)).toEqual(["query", "orientation", "count"]);
    expect(schema.required).toEqual(["query"]);
    expect(schema.properties.orientation.items.enum).toEqual(["landscape", "portrait", "square"]);
  });

  it.each([
    [{ query: "" }],
    [{ query: "x".repeat(251) }],
    [{ query: "x", count: 0 }],
    [{ query: "x", count: 21 }],
    [{ query: "x", orientation: ["vertical"] }],
    [{ query: "x", orientation: "landscape" }],
  ])("refuses invalid input %j", (input) => {
    const schema: any = searchPhotos({ apiKey: "k" }).inputSchema;
    expect(schema.safeParse(input).success).toBe(false);
  });

  it("pexafyTools returns the three tools", () => {
    expect(Object.keys(pexafyTools({ apiKey: "k" }))).toEqual(["searchPhotos", "findSimilarPhotos", "getPhoto"]);
  });

  it("VERSION matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});

describe("errors and retries", () => {
  it("retries a per-minute rate limit", async () => {
    const { fetch, calls } = fakeFetch([fail(429, "RATE_LIMITED", "Retry after 0s.", { "retry-after": "0" }), ok([])]);
    await run(searchPhotos({ apiKey: "k", fetch }), { query: "x" });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["DAILY_QUOTA_EXCEEDED", { "retry-after": "36000" }],
    ["QUOTA_EXCEEDED", undefined],
  ])("does not retry a spent quota (%s)", async (code, headers) => {
    const { fetch, calls } = fakeFetch([fail(429, code, "Quota spent.", headers)]);
    const err = await run(searchPhotos({ apiKey: "k", fetch }), { query: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PexafyError);
    expect(err.message).toBe("Pexafy rate limit or quota reached: Quota spent. (HTTP 429)");
    expect(err.code).toBe(code);
    expect(calls).toHaveLength(1);
  });

  it("retries a 5xx, then reports it", async () => {
    const { fetch, calls } = fakeFetch([
      fail(503, "UNAVAILABLE", "busy", { "retry-after": "0" }),
      fail(500, "INTERNAL", "boom", { "retry-after": "0" }),
    ]);
    const t = searchPhotos({ apiKey: "k", fetch, maxRetries: 1 });
    await expect(run(t, { query: "x" })).rejects.toThrow("Pexafy request failed: boom (HTTP 500)");
    expect(calls).toHaveLength(2);
  });

  it("says when the key is rejected, without retrying", async () => {
    const { fetch, calls } = fakeFetch([fail(401, "AUTH", "Invalid API Key.")]);
    await expect(run(searchPhotos({ apiKey: "k", fetch }), { query: "x" })).rejects.toThrow(
      "Pexafy rejected the API key: Invalid API Key. (HTTP 401)",
    );
    expect(calls).toHaveLength(1);
  });

  it("says when a photo does not exist", async () => {
    const { fetch } = fakeFetch([fail(404, "PHOTO_NOT_FOUND", "Photo 'x' not found")]);
    await expect(run(getPhoto({ apiKey: "k", fetch }), { photo_id: "x" })).rejects.toThrow(
      "No such Pexafy photo: Photo 'x' not found (HTTP 404)",
    );
  });

  it("retries a network failure, then reports it", async () => {
    const { fetch, calls } = fakeFetch(["network", ok([])]);
    await run(searchPhotos({ apiKey: "k", fetch, maxRetries: 1 }), { query: "x" });
    expect(calls).toHaveLength(2);
    const again = fakeFetch(["network"]);
    await expect(run(searchPhotos({ apiKey: "k", fetch: again.fetch, maxRetries: 0 }), { query: "x" })).rejects.toThrow(
      "Could not reach Pexafy: fetch failed",
    );
  });

  it("gives up after timeoutMs", async () => {
    const { fetch } = fakeFetch(["hang"]);
    const t = searchPhotos({ apiKey: "k", fetch, timeoutMs: 50, maxRetries: 0 });
    await expect(run(t, { query: "x" })).rejects.toThrow("Pexafy did not answer within 50 ms");
  });

  it("stops at once when the caller aborts", async () => {
    const { fetch, calls } = fakeFetch(["hang", ok([])]);
    const controller = new AbortController();
    const pending = run(searchPhotos({ apiKey: "k", fetch }), { query: "x" }, controller.signal);
    controller.abort(new Error("stopped by caller"));
    await expect(pending).rejects.toThrow("stopped by caller");
    expect(calls).toHaveLength(1);
  });

  it("refuses a 200 that carries no data", async () => {
    const { fetch } = fakeFetch([{ status: 200, raw: "<html>maintenance</html>" }]);
    await expect(run(searchPhotos({ apiKey: "k", fetch }), { query: "x" })).rejects.toThrow(
      "Unexpected response from Pexafy (HTTP 200, no data)",
    );
  });

  it("refuses to run without a key", async () => {
    const saved = process.env.PEXAFY_API_KEY;
    delete process.env.PEXAFY_API_KEY;
    try {
      await expect(run(searchPhotos(), { query: "x" })).rejects.toThrow(/PEXAFY_API_KEY/);
    } finally {
      if (saved) process.env.PEXAFY_API_KEY = saved;
    }
  });
});

describe("text cleaning", () => {
  it("flattens and strips invisible characters", () => {
    expect(cleanText("a​ b\n\tc\u0007")).toBe("a b c");
    expect(cleanText(null)).toBe("");
  });
  it("caps long text with an ellipsis", () => {
    const text = cleanText("x".repeat(400));
    expect(text).toHaveLength(300);
    expect(text.endsWith("…")).toBe(true);
  });
  it.each([
    ["nympha57 None", "nympha57"],
    ["Unknown photographer", ""],
    ["3345557", ""],
    ["Mitchel Lensink", "Mitchel Lensink"],
  ])("cleans the name %j", (raw, clean) => {
    expect(cleanName(raw)).toBe(clean);
  });
  it("repairs credit lines", () => {
    expect(cleanCredit("Photo by Unknown on Pixabay (u)")).toBe("Photo on Pixabay (u)");
    expect(cleanCredit("Photo by Jane Doe on Unsplash (u)")).toBe("Photo by Jane Doe on Unsplash (u)");
  });
  it("falls back when fields are missing", () => {
    const s = summarize({ photo_id: "p", image_url: "full.jpg", description: "only", photographer_username: "u1" }, 1);
    expect([s.url, s.alt_text, s.photographer]).toEqual(["full.jpg", "only", "u1"]);
  });
});
