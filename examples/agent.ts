// An agent that illustrates a blog post outline with real, credited photos.
//
//   npm install pexafy-ai-sdk ai zod @ai-sdk/anthropic
//   PEXAFY_API_KEY=... ANTHROPIC_API_KEY=... npx tsx examples/agent.ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, stepCountIs } from "ai";
import { pexafyTools } from "../src/index";

const { text, steps } = await generateText({
  model: anthropic("claude-haiku-4-5"),
  tools: pexafyTools({ maxResults: 4 }),
  stopWhen: stepCountIs(5),
  system:
    "You illustrate articles. For each section, pick one photo, give its URL, alt text and the exact credit line.",
  prompt:
    "Blog post 'A weekend in Lisbon': sections 'Trams', 'Pastéis de nata', 'Sunset at Miradouro'. One photo each.",
});

console.log(text);
console.error(`\n${steps.flatMap((s) => s.toolCalls).length} tool calls`);
