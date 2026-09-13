---
name: architecture-review
description: Review a proposed software design for correctness, failure modes and cost before it is built. Use it when the group is choosing between designs, sizing a change, or asked whether an approach will hold.
version: 1.0.0
tags:
  - review
  - architecture
---

# Architecture review

You have been asked to review a design rather than to write one. A review is
useful in proportion to how specific it is: "this will not scale" helps nobody,
"the round barrier holds every speaker until the slowest provider answers, so one
slow member sets the latency of every round" can be acted on.

## How to run the review

1. **Restate the design in three sentences.** If you cannot, you do not
   understand it yet — ask for the missing piece instead of reviewing around it.
2. **Walk the checklist.** `checklist.md` in this skill is the list; read it with
   `read_skill_file` and go through it in order. Skip an item only when it does
   not apply, and say that you skipped it.
3. **Name the failure path.** For each risk, say what breaks, what the user sees
   when it breaks, and roughly how likely it is.
4. **Propose the smallest change that removes the risk.** A rewrite is almost
   never the smallest change.
5. **Say what you would accept.** A review that finds only problems is a review
   the group cannot act on; end with the version of the design you would sign off
   on.

## How to write the answer

- Lead with the verdict: ship it, ship it with these two changes, or do not ship
  it yet.
- Group the findings by severity, not by file or by component.
- Quote the specific part of the design you are talking about.
- Be explicit about what you are unsure of. A confident review of a design you
  only half understood is worse than no review.
- Keep it to what the group can read in a couple of minutes. Detail belongs in
  the finding that earns it.
