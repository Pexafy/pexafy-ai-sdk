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
} from "../src/index";

const PHOTO = {
  photo_id: "019e1ea7-2e82-7a34-a451-4c6c7c8250f4",
  image_url: "https://images.unsplash.com/photo-1",
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

type Call = { url: URL; headers: Record<string, string> };

function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ctx = { toolCallId: "1", messages: [] } as any;

describe("text cleaning", () => {
  it("flattens and strips invisible characters", () => {
    expect(cleanText("a​ b\n\tc\u0007")).toBe("a b c");
  });
  it("caps long text with an ellipsis", () => {
    expect(cleanText("x".repeat(400))).toHaveLength(300);
  });
  it("drops placeholder names", () => {
    expect(cleanName("nympha57 None")).toBe("nympha57");
    expect(cleanName("Unknown photographer")).toBe("");
    expect(cleanName("3345557")).toBe("");
  });
  it("repairs credit lines", () => {
    expect(cleanCredit("Photo by Unknown on Pixabay")).toBe("Photo on Pixabay");
  });
});

describe("searchPhotos", () => {
  it("sends the query, filters and key, and returns compact photos", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { success: true, data: [PHOTO] } }]);
    const t = searchPhotos({ apiKey: "k", fetch, maxResults: 4 });
    const out: any = await t.execute!({ query: "red bicycle", orientation: ["landscape", "square"] }, ctx);
    const url = calls[0].url;
    expect(url.pathname).toBe("/api/v1/search/photos");
    expect(url.searchParams.get("q")).toBe("red bicycle");
    expect(url.searchParams.getAll("orientation")).toEqual(["landscape", "square"]);
    expect(url.searchParams.get("per_page")).toBe("4");
    expect(calls[0].headers["x-api-key"]).toBe("k");
    expect(out.photos[0]).toMatchObject({
      rank: 1,
      photo_id: PHOTO.photo_id,
      alt_text: "Red bicycle against a white wall",
      url: "r",
      thumbnail_url: "s",
      photographer: "nympha57",
      credit: "Photo by nympha57 on Pexels (https://pexafy.com/legal/licenses/#pexels)",
    });
  });

  it("retries a 429 and honours Retry-After", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 429, body: {}, headers: { "retry-after": "0.01" } },
      { status: 200, body: { success: true, data: [] } },
    ]);
    const out: any = await searchPhotos({ apiKey: "k", fetch }).execute!({ query: "x" }, ctx);
    expect(calls).toHaveLength(2);
    expect(out.photos).toEqual([]);
  });

  it("raises a readable error once retries are spent", async () => {
    const { fetch } = fakeFetch([
      { status: 429, body: { error: { message: "Monthly quota exceeded", code: "QUOTA" } } },
    ]);
    await expect(
      searchPhotos({ apiKey: "k", fetch, maxRetries: 0 }).execute!({ query: "x" }, ctx),
    ).rejects.toThrow(/rate limit or quota reached: Monthly quota exceeded/);
  });

  it("refuses to run without a key", async () => {
    const saved = process.env.PEXAFY_API_KEY;
    delete process.env.PEXAFY_API_KEY;
    await expect(searchPhotos().execute!({ query: "x" }, ctx)).rejects.toBeInstanceOf(PexafyError);
    if (saved) process.env.PEXAFY_API_KEY = saved;
  });
});

describe("photo tools", () => {
  it("findSimilarPhotos calls the similar endpoint", async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: { success: true, data: [PHOTO] } }]);
    await findSimilarPhotos({ apiKey: "k", fetch }).execute!({ photo_id: "abc", count: 2 }, ctx);
    expect(calls[0].url.pathname).toBe("/api/v1/photos/abc/similar");
    expect(calls[0].url.searchParams.get("per_page")).toBe("2");
  });

  it("getPhoto returns one compact photo, and a 404 says so", async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { success: true, data: PHOTO } },
      { status: 404, body: { success: false, error: { message: "Photo not found" } } },
    ]);
    const t = getPhoto({ apiKey: "k", fetch });
    const out: any = await t.execute!({ photo_id: "abc" }, ctx);
    expect(out.photo_id).toBe(PHOTO.photo_id);
    await expect(t.execute!({ photo_id: "nope" }, ctx)).rejects.toThrow(/No such Pexafy photo/);
  });

  it("pexafyTools returns the three tools", () => {
    expect(Object.keys(pexafyTools({ apiKey: "k" }))).toEqual([
      "searchPhotos",
      "findSimilarPhotos",
      "getPhoto",
    ]);
  });
});
