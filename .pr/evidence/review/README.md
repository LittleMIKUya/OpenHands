# Follow-up: last successful save during delayed settings refetch

Addresses the review on OpenHands/OpenHands#17970. The earlier commit
`f512f7c4bfb67023520754c7b8250fbad7daf6f5` is the before version.

Both recordings use the actual Agent Canvas UI, Microsoft Edge, and
`openhands-agent-server==1.50.1`, with `VITE_MOCK_API=false`. No model is invoked.
A loopback HTTP proxy forwards requests to the real Agent Server. It buffers
the body of the first post-save GET response; successful responses are not
fabricated. After verifying that the real server persisted A's change, the
helper stops this isolated backend, causing B's PATCH to fail through the
same transport. The proxy reports actual connection failures as HTTP 502.

Initial persisted settings: `enabled_skills: ["add-skill", "add-javadoc"]`,
`disabled_skills: []`. A is `add-skill`; B is `add-javadoc`.

| Interaction | Before | After |
| --- | --- | --- |
| Disable A; real PATCH succeeds while the following GET body is delayed | A disabled | A disabled |
| Disable B; its PATCH fails before that GET can reconcile | A enabled again, B enabled; Enabled count 2 | A stays disabled, B restored to enabled; Enabled count 1 |

- [Before video](before-small.webm)
- [After video](after-small.webm)
- [Before screenshot](before.png)
- [After screenshot](after.png)
- [Before measurements](before.json)
- [After measurements](after.json)
- [Before actual persisted skill lists](before-server-settings.json)
- [After actual persisted skill lists](after-server-settings.json)

Screenshots are unmodified. Videos retain their original timing and frame;
only encoding and frame rate were reduced.

## Reproduction

Use the real-backend and Vite startup commands in the parent
[evidence README](../README.md), with backend port 18120 and UI port 31120.
The helper creates the proxy on port 18121 and seeds the actual settings API
and an isolated browser context's backend selection.

```sh
node .pr/evidence/review/verify.cjs before <isolated-backend-PID>
# Restart the real backend after the helper stops it.
node .pr/evidence/review/verify.cjs after <new-isolated-backend-PID>
```

The before run temporarily substitutes the two hooks from the pinned earlier
PR commit and restores the working files in a finally block. Use only the PID
of the isolated test backend. Microsoft Edge and Playwright's recording codec
must be installed.

## Code and regression proof

`useSaveSettings` invokes the optional `onPersisted` callback after its mutation
function succeeds and before awaiting query invalidation/refetch. The skill
controller advances its persisted lists from those successfully applied
variables. Its error guard distinguishes settings hydration from successful
writes, so a successful overlapping write can become the rollback baseline
without letting a stale failure overwrite refreshed settings or newer edits.

- New delayed-refetch tests fail on the earlier PR source for both Local and
  Cloud: the first skill becomes enabled again. See `red.log`.
- An additional test covers A completing after B has already been dispatched;
  B's subsequent failure must still roll back to A's successful state.
- Final related suite: 10 files, 99 tests passed. Includes the original focused
  suite (now 34 tests) plus 65 tests for existing settings-hook consumers.
- The original full-suite log in the parent folder remains evidence for the
  earlier commit, not a new full-suite run of this follow-up.

Final validation: `npm run lint`, `npm run build`, and `npm run build:lib` all passed. No new lint errors; existing style warnings remain.
