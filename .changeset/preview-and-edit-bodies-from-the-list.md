---
"@theedoran/gc": patch
---

Bring commit bodies forward in the review list. A collapsed row now previews the first three lines
of its body, marked with an ellipsis when there is more, instead of a line-count badge, so the list
says what each commit explains without being expanded.

The body editor opens with `b` from any row, collapsed or not, and expands that row on the way in.
It replaces `i`, which only worked on an already expanded row. `g` and `x` still live in the
expanded view.

Leaving the body editor now saves. `esc` writes the body back to the commit and closes the box, and
`ctrl+d` is no longer bound, so it deletes forward as readline does everywhere else. An unwanted
line is deleted by hand rather than thrown away with a key.

A lone `esc` is also read faster: readline waits half a second to tell it from an arrow key, which
is now shortened to 50ms.
