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

## Still open

- **Subagent fan-out inside the measured loop.** The product has `research_fanout`, the benchmark
  does not use it: a measured run is one line of inquiry.
- **A summarization model role.** Context folding reuses the research model; a separate cheap
  model for the ledger is what `open_deep_research` does.
- **Effort scaling by question complexity.** Budgets are still fixed per question rather than
  chosen from the question's shape.
- **A citation pass** over the final answer, separate from the answering turn.
