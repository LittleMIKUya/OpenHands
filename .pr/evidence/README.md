# OpenHands #17941: real application evidence

Code: `f512f7c4bfb67023520754c7b8250fbad7daf6f5`.
Base: `8bb2293410c3488828a532b52691b7aaac10797d`.

Both recordings use the real OpenHands frontend, Microsoft Edge, and
`openhands-agent-server==1.50.1`. `VITE_MOCK_API=false`; no request interception
or fake settings API is used. No model is configured or invoked because the
reproduction only changes settings. Each run starts with the same persisted
settings: `enabled_skills: ["add-skill"]`, `disabled_skills: []`.

| Scenario | Before | After |
| --- | --- | --- |
| First click on an enabled skill, without pre-hover | Remains enabled; 0 settings PATCH requests | Disabled; exactly 1 PATCH request |
| Reload after a successful save | Not applicable: first click did not save | Remains disabled |
| Enable another skill after stopping the real backend | Optimistic toggle remains enabled; Enabled count becomes 2 | Toggle returns to disabled; erroneous Enabled count disappears |

- [Before recording](before-small.webm)
- [After recording](after-small.webm)
- [Before failed save](before-failed-save.png)
- [After failed save](after-failed-save.png)
- [Before measurements](before.json)
- [After measurements](after.json)

The recordings retain their timing and full 1440x1000 frame; only the encoding
and frame rate were reduced to make them smaller. Screenshots are unmodified.

## Reproduce

Install the repository's npm dependencies. Start an isolated real backend:

```powershell
$env:OH_PERSISTENCE_DIR = Join-Path (Get-Location) '.pr/runtime'
$env:OH_CONVERSATIONS_PATH = Join-Path $env:OH_PERSISTENCE_DIR 'conversations'
$env:OH_ENABLE_TELEMETRY = 'false'
uvx --from openhands-agent-server==1.50.1 agent-server --host 127.0.0.1 --port 18120
```

In a second terminal, start the actual frontend:

```powershell
$env:VITE_BACKEND_HOST = '127.0.0.1:18120'
$env:VITE_FRONTEND_PORT = '31120'
$env:VITE_MOCK_API = 'false'
node node_modules/@react-router/dev/bin.js dev
```

In a third terminal run `node .pr/evidence/verify.cjs before <backend-PID>`.
The helper temporarily uses the two source files from the pinned base revision,
restores them in a finally block, seeds the real settings API, records the UI,
and stops the specified backend process to cause a genuine network failure.
Restart the backend, then run `node .pr/evidence/verify.cjs after <new-backend-PID>`.
Use only the PID of the isolated test backend started above. The helper uses
an isolated browser context and seeds its backend selection/onboarding state.

## Validation

- Focused regression/API-boundary suite: 5 files, 31 tests passed.
- Regression negative control: the original source reproduces the lost-click
  failure and unintended settings saves during hydration.
- `npm run lint`, `npm run build`, `npm run build:lib`: passed.
- `npm test -- --maxWorkers=4`: 763 files passed, 5 failed; 8061 tests passed,
  8 failed, 33 skipped, 7 todo. The identical 8 failures reproduce on the original
  source in this Windows environment (path separators, host-platform naming,
  POSIX shell spawning). See `full-tests.log` and `baseline-tests.log`.

This evidence branch is separate from the code PR; none of these temporary
artifacts are part of its proposed changes.
