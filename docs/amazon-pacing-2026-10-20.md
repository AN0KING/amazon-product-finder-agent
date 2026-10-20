# Local pacing adjustment (0.9.67)

The existing 0.9.67 parser, weight selection and profit rules remain in place.
The source before this adjustment is preserved in
`D:\deliverables\backups\scout-0.9.67-before-amazon-slowdown-20261020-140001.zip`.
This archive contains tracked and non-ignored source files, not live business data or dependencies installed by npm.

- Amazon request pacing intervals increase by 50%: CA 1,200 → 1,800 ms;
  default 1,400 → 2,100 ms; DE/BR 3,000 → 4,500 ms.
- Background collection detail concurrency changes from 2 to 1.
- Interactive detail concurrency defaults to 2 instead of 3.
- The HTTP transport uses a sliding request window; these intervals are not a
  promise of one completed product per interval. Browser loading, existing
  collection scheduling, retries and cooldowns also determine throughput.
- Existing verification pauses, recovery budgets and single-page access policy
  remain in force. Slower requests cannot guarantee the absence of verification.

1688 ordinary searches retain one worker, a minimum 60-second start gap and an
additional 120-second rest every ten items (roughly 50 starts/hour before page
processing time). The stopped 90/hour experiment is historical, not active policy.
