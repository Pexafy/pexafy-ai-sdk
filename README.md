# @pexafy/ai-sdk

[AI SDK](https://ai-sdk.dev) tools for [Pexafy](https://pexafy.com): semantic search
over 9M+ free stock photos from Unsplash, Pexels, Pixabay and six more libraries,
behind one API. Your agent describes the picture it needs in plain English and gets
back real photographs, each with its image URL, alt text, licence and the credit line
to print.

```bash
npm install @pexafy/ai-sdk ai zod
```

Get a key at [pexafy.com/dashboard/api-keys/create](https://pexafy.com/dashboard/api-keys/create/)
(choose **Pexafy API**) and set it as `PEXAFY_API_KEY`. The free plan gives 5,000 requests a month at 20 a
minute; the key is issued immediately, with no card and no app review.

## Usage

```ts
import { generateText, isStepCount } from "ai";
import { searchPhotos } from "@pexafy/ai-sdk";

const { text } = await generateText({
  model: "anthropic/claude-haiku-4.5",
  tools: { searchPhotos: searchPhotos() },
  stopWhen: isStepCount(3),
  prompt: "Find a header photo for a blog post about remote work, with its credit line.",
});

console.log(text);
```

(On AI SDK 5 and 6, import `stepCountIs` instead of `isStepCount`.)

All three tools at once:

```ts
import { pexafyTools } from "@pexafy/ai-sdk";

const tools = pexafyTools({ maxResults: 4 });
// { searchPhotos, findSimilarPhotos, getPhoto }
```

## Tools

| Export | What it does |
|---|---|
| `searchPhotos(options?)` | Search by describing the scene; optional `orientation` filter (`landscape`, `portrait`, `square`) |
| `findSimilarPhotos(options?)` | Photos that look like one already found, by `photo_id` |
| `getPhoto(options?)` | One photo's details and credit line, by `photo_id` |
| `pexafyTools(options?)` | The three tools above, sharing the same options |

Options: `apiKey` (defaults to `PEXAFY_API_KEY`), `maxResults` (default 6, max 20),
`baseUrl`, `maxRetries` (default 2, on 429 and 5xx, honouring `Retry-After`), `fetch`.

Each photo comes back as a compact record, sized for a model's context:

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

`searchPhotos` and `findSimilarPhotos` return `{ photos: [...] }`; `getPhoto` returns
one record.

## Writing queries

Search runs on meaning, not keywords: `two people hiking on a ridge at dawn` ranks
better than `hiking dawn people`. The tool descriptions already tell the model to
describe what should be in the picture and to leave `orientation` unset unless a
shape is really needed, so an agent writes good queries without help.

## Errors

A rate limit, an exhausted quota or an unknown `photo_id` throws a `PexafyError`
with a short, readable message; the AI SDK hands it to the model as the tool's
error, so the agent can react. A missing key throws on the first call.

## Credits and licences

Photos are free to use under their library's licence; `license` and
`source_page_url` say which. On the free plan, print the `credit` line next to each
photo you publish. Pexafy finds existing photographs: it does not generate images.

## Compatibility

AI SDK 5, 6 and 7, with zod 3.25+ or 4. Node 18+, edge runtimes and the browser
(keep your key on the server).

## Links

- [Pexafy API docs](https://docs.pexafy.com)
- [LangChain / LangGraph tools](https://github.com/Pexafy/langchain-pexafy) (`pip install langchain-pexafy`)
- [Pexafy MCP server](https://github.com/Pexafy/pexafy-mcp) for MCP clients (`https://mcp.pexafy.com/mcp`)

MIT licence.
