---
"@theedoran/gc": patch
---

Commit and push in one keystroke. `⇧↵` in the review list creates the commits and then pushes the
branch, setting the upstream to `origin` when the branch has none yet. The hint bar names it next to
`↵ commit`.

Telling `⇧↵` apart from `↵` needs the Kitty keyboard protocol, so the review turns it on while the
list has the keys and off again for the two in-place editors, the external editor, and the way out.
Under it `⇧↵`, `esc` and every `ctrl+key` arrive as escape codes Node has no rule for, so the review
names them itself and raises `SIGINT` for `ctrl+c`. Terminals that do not speak the protocol ignore
the request and `⇧↵` stays a plain commit.
