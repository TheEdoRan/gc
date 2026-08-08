---
"@theedoran/gc": minor
---

Rework the review experience. Generation now shows a spinner with the model, the current phase and
the elapsed time, streams each commit subject as it is written, and prints the reason for every
retry. The plan preview is replaced by an interactive list that navigates, colours by Conventional
Commit type, edits subjects and bodies in place, and expands one commit at a time.

Commit bodies are now opt-in. The new `body` setting takes `manual` (the default, no bodies),
`auto`, or `always`, and is read from the user config, `.gc.yaml`, or `--body`. Ask for a body on a
single commit by expanding its row and pressing `g`, or write one yourself with `i`.

Existing configuration files keep working unchanged and default to `manual`.
