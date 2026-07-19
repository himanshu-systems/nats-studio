<!-- Thanks for contributing! Keep PRs focused — one feature/fix each. -->

## What & why

<!-- What does this change, and why? Link the issue it closes, e.g. "Closes #12". -->

## Checklist

- [ ] `cargo fmt --all` + `cargo clippy --workspace --all-targets -- -D warnings` pass
- [ ] `cargo xtask check-layers` passes
- [ ] `cargo test --workspace` passes
- [ ] If I changed `ns-types`, I ran `cargo xtask gen-types` and committed the result
- [ ] `cd apps/desktop && pnpm build` (tsc + vite) passes
- [ ] Updated docs/README for any user-facing change

## Notes for reviewers

<!-- Anything worth calling out: tradeoffs, follow-ups, screenshots. -->
