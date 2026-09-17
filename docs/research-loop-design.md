# Research loop design: what the field does, and what this repository does

This note records the mechanisms the well-regarded research agents use, the evidence for each,
and where this repository stands against them. It exists so the next change to the research
path starts from the field's consensus instead of from a guess.

## Sources

- Anthropic, *How we built our multi-agent research system* — https://www.anthropic.com/engineering/multi-agent-research-system
- `dzhng/deep-research` — https://github.com/dzhng/deep-research
- `langchain-ai/open_deep_research` — https://github.com/langchain-ai/open_deep_research
- OpenAI, *BrowseComp* — https://openai.com/index/browsecomp

## What the field does

| Mechanism | Where it comes from | Why it matters |
| --- | --- | --- |
| Token spend is the dominant performance term | Anthropic: on BrowseComp, token usage alone explains **80%** of the variance; tool calls and model choice are the other two factors | Effort budget is a first-class capability, not a knob to minimise |
| Orchestrator + parallel subagents with separate contexts | Anthropic (3–5 subagents, each with 3+ parallel tools), `open_deep_research` (supervisor + parallel researchers) | A single context cannot hold breadth; separate contexts compress independently |
| Every subagent gets an objective, an output format, sources to prefer, and boundaries | Anthropic ("Teach the orchestrator how to delegate") | Vague delegation duplicates work and leaves gaps |
| **Learnings + directions ledger**, updated every round | `dzhng/deep-research` (Learnings / Directions, breadth × depth), `open_deep_research` (compression step) | The loop carries findings, not raw pages; the next queries come from what is still unknown |
| Dedicated summarization and compression steps | `open_deep_research` (separate summarization and compression models) | Keeps the working context small and sharp; token cost moves to the cheap model |
| Start wide, then narrow | Anthropic ("agents default to overly long, specific queries that return few results") | A narrow first query returns nothing and teaches nothing |
| Source-quality heuristics | Anthropic: human testers found agents preferred SEO content farms over academic PDFs | The index rewards the pages that stuff the query, not the pages that hold the fact |
| Citation pass over the final answer | Anthropic (a CitationAgent attributes every claim) | A claim without its source cannot be checked |
| Effort scaled to query complexity | Anthropic (1 agent/3–10 calls for facts, 2–4 subagents/10–15 calls for comparisons, 10+ for complex) | Prevents both under- and over-investment |
| Evaluate with a small set immediately, LLM judge with a rubric | Anthropic | Effect sizes are large early; twenty cases show them |

## What this repository measured on itself

| Observation | Evidence |
| --- | --- |
| A shallow budget hid reachability | One question whose answer never appeared in evidence at 10 searches / 20 reads reached **100%** of its answer tokens at 30 / 60 |
| Reads carried too much context | 10k–68k tokens of raw page text per question; the worst run held ~68k |
| The strict reach metric was wrong | Requiring the whole answer string to appear contiguously reported "unreachable" for multi-part answers; per-token reach showed 50–67% for the same runs |
| Reference lists carry the answer | A Crossref record for a review of the target book named the answer verbatim in its `reference` list |
| Reading a search page is not searching | 41% of reads were search-engine result pages; handing one to the reader now runs the discovery pipeline instead |
| Closing turns produced fragments | `. Hmm`, `20000` were scored as answers until a fragment stopped counting as one |

## What the code actually does

Read from the sources rather than from their summaries:

**`dzhng/deep-research`, `src/deep-research.ts`**

- `generateSerpQueries(query, numQueries = breadth, learnings)`: one structured call returning
  `{query, researchGoal}` per query, with the instruction that queries be unique and unlike each
  other, and that the goal say how to *advance* once the results are in. Previous learnings are fed
  back in so the next round is more specific.
- `processSerpResult`: one structured call per search returning `{learnings, followUpQuestions}`.
  The prompt demands density and **explicitly requires entities, exact metrics, numbers, and dates**.
- Recursion: each query descends with `depth - 1` and `ceil(breadth / 2)`, carrying
  `learnings` and `visitedUrls` forward; the next round's query is built from
  `Previous research goal: … Follow-up research directions: …`.
- `writeFinalAnswer(prompt, learnings)` returns a structured `{exactAnswer}` with the instruction
  "just the answer, no other text".
- Per-query `try/catch` returns empty results, so one failing query does not sink the round;
  per-result content is trimmed (`trimPrompt(content, 25_000)`).

**`anthropics/anthropic-cookbook`, `patterns/agents/prompts/`**

- `research_lead_agent.md`: the lead must classify the query as depth-first, breadth-first, or
  straightforward, then size the team (1 / 2-3 / 3-5 / 5-10, max 20), and every subagent gets one
  objective, an output format, background context, key questions, suggested sources, the tools to
  use, and scope boundaries. The lead coordinates and synthesizes; it does not do the primary
  research. Citations are a separate agent's job.
- `research_subagent.md`, verbatim: **"Avoid overly specific searches… Keep queries shorter since
  this will return more useful results — under 5 words. If specific searches yield few results,
  broaden slightly."** It also sets a per-task budget (under 5 tool calls for simple, about 10 for
  hard, up to 15), requires reasoning after every tool result, forbids repeating the same query,
  and tells the agent to judge source quality (aggregators, speculation, unnamed sources, marketing
  language) rather than taking results at face value.

**`assafelovic/gpt-researcher`, `gpt_researcher/skills/deep_research.py`**

- The same learnings/follow-up schema, but with a JSON-schema prompt *and* layered parsers
  (`json_repair`, then line patterns for `Query:`/`Goal:`/`Learning [citation]:`/`Question:`) —
  the shape is enforced hard because models drift from it.
- `generate_research_plan` runs **initial searches first**, then asks for questions that explore
  different aspects and time periods, with the current date injected.
- Each query spawns a nested researcher with its own context and shared `visited_urls`, so the
  parent keeps learnings, citations, and URLs rather than pages; context is trimmed to a word
  budget keeping the most recent material.

## What this repository adopted

1. **Effort scales with evidence** — a phase that keeps returning new evidence extends itself,
   bounded by a ceiling (`productiveCallBonus`). A phase that stops producing evidence stops.
2. **Learnings + directions ledger** — the research loop folds read material into
   `ESTABLISHED` (fact + source) and `OPEN` (the search that would answer it), and hands the open
   questions back as the next searches.
3. **A page is read for the reason it was found** — the window follows the run's question and the
   search that produced the lead, and a page that fits is returned whole.
4. **Search pages are queries** — a search-engine result URL is answered with ranked results.
5. **Publications are indexed by their own record** — Crossref (keyless) plus the works a record
   cites.
6. **Collections are one link away** — the article that was found links to the list page that
   holds the item the question asks about, and that page is ranked first for such questions.
7. **Source quality** — a page that merely mirrors the query is demoted; a source that can record
   the fact is read before one that mentions it.
8. **A claim is checked against what was read** — an answer naming something no opened page
   contains is sent back, and an ungrounded conclusion is asked for its source.
9. **Choices are made between candidates** — the closing request lists the candidates the pages
   put forward and the clue each fails.
10. **The user's own Chrome is a fallback channel, off by default.** With the Browser Use plugin
    connected and the setting on, a thin result set is retried in their session, briefly and with
    the tab closed again, and the results are labelled as coming from it. What the engines actually
    do when measured: Google answers this kind of traffic with a challenge, so a channel that hides
    its origin gains nothing there; Bing answers with a complete page about something else, which is
    why a page whose results share no word with the query is discarded rather than reported.

## Measured effect of the adopted mechanisms

| Change | Measurement |
| --- | --- |
| Crossref source, then cited works in its records | One question's answer tokens in evidence: 0% → 67% → 83% at the same budget |
| Deeper effort budget (30 searches / 60 reads) | The same question reached 100% of its answer tokens, the first time any configuration did |
| Queries held under six words | Adopted from the subagent prompt, where the runs here had used twelve to seventeen |
| Per-token reach reporting | Replaced a strict whole-string test that reported multi-part answers as unreachable |

## Still open

- **Subagent fan-out inside the measured loop.** The product has `research_fanout`, the benchmark
  does not use it: a measured run is one line of inquiry.
- **A summarization model role.** Context folding reuses the research model; a separate cheap
  model for the ledger is what `open_deep_research` does.
- **Effort scaling by question complexity.** Budgets are still fixed per question rather than
  chosen from the question's shape.
- **A citation pass** over the final answer, separate from the answering turn.
