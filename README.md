# pexafy-ai-sdk

[AI SDK](https://ai-sdk.dev) tools for [Pexafy](https://pexafy.com): semantic search over
9M+ free stock photos (Unsplash, Pexels, Pixabay and six more sources). Each photo comes
back with its URL, alt text, licence and credit line.

## Install

```bash
npm install pexafy-ai-sdk ai zod
```

Set `PEXAFY_API_KEY`. Free key, no card: [pexafy.com/dashboard/api-keys/create](https://pexafy.com/dashboard/api-keys/create/)
(5,000 requests a month).

## Use

```ts
import { anthropic } from "@ai-sdk/anthropic"; // any AI SDK provider works
import { generateText, isStepCount } from "ai";
import { pexafyTools } from "pexafy-ai-sdk";

const { text } = await generateText({
  model: anthropic("claude-haiku-4-5"),
  tools: pexafyTools(),
  stopWhen: isStepCount(5),
  prompt: "Find a header photo for a post about remote work, with its credit line.",
});
console.log(text);
```

On AI SDK 5 and 6, import `stepCountIs` instead of `isStepCount`.

## Tools

| Function | Arguments the model fills |
|---|---|
| `searchPhotos()` | `query`, optional `orientation`, `count` |
| `findSimilarPhotos()` | `photo_id`, optional `count` |
| `getPhoto()` | `photo_id` |

`pexafyTools()` returns all three. Options on each: `apiKey` (default `PEXAFY_API_KEY`),
`maxResults` (photos per search when the model gives no `count`; default 6, max 20),
`timeoutMs` (default 30000), `maxRetries` (default 2).

## Output

`searchPhotos` and `findSimilarPhotos` return `{ photos: [...] }`, `getPhoto` one record:

```json
{
  "rank": 1,
  "photo_id": "019e1ea7-2e82-7a34-a451-4c6c7c8250f4",
  "alt_text": "Red bicycle parked against white wall with front wheel facing left and back wheel right",
  "url": "https://images.unsplash.com/photo-1520538254843-27a40bae5e3a?w=1280",
  "thumbnail_url": "https://images.unsplash.com/photo-1520538254843-27a40bae5e3a?w=400",
  "width": 4896,
  "height": 3264,
  "orientation": "landscape",
  "dominant_color": "#CAB8B4",
  "photographer": "Mitchel Lensink",
  "source": "Unsplash",
  "source_page_url": "https://unsplash.com/photos/red-bicycle-near-white-wall-Hx_dY7Xeszo",
  "license": "free",
  "credit": "Photo by Mitchel Lensink on Unsplash (https://pexafy.com/legal/licenses/#unsplash)"
}
```

## Errors

- Spent quota, unknown `photo_id`, invalid key: the tool throws a `PexafyError`, which the
  AI SDK passes to the model as a tool error (see `steps` for `tool-error` parts).
- Per-minute rate limit, server error, network failure: retried automatically.

## Licence

MIT. On the free plan, show the `credit` line next to each photo you publish.
