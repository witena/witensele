# Architecture review checklist

Work through these in order. For each one, either state the finding or say the
item does not apply and why.

## 1. Boundaries

- What is inside this component and what is outside it? Can you say it in one
  sentence?
- Which other components does it depend on, and does any of them depend back?
- If this had to be moved to another process or another machine, what would
  break first?

## 2. Data and state

- Where is the single source of truth for each piece of state?
- What is duplicated, and what keeps the copies in agreement?
- What happens to in-flight state when the process dies halfway through?

## 3. Failure modes

- List every external call. For each: what happens on a timeout, on an error,
  and on a response that is valid but wrong?
- Which failures are retried, and is the operation safe to retry?
- What does the user see for each failure? "Nothing" is an answer, and usually
  the wrong one.

## 4. Concurrency

- What runs at the same time as what?
- Which shared thing could two of those touch at once?
- Is there an ordering the design assumes but does not enforce?

## 5. Cost and limits

- What grows without bound — memory, rows, files, context, connections?
- What is the cost of the common path, and of the worst path?
- Where is the first limit this design will hit, and at what scale?

## 6. Change

- What is the most likely next requirement, and how much of this would it touch?
- What is hard-coded that will need to be configurable?
- How would you test this? If the answer is "end to end only", that is a
  finding.
