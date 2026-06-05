# Original editor engine (preserved snapshot)

These two files are a **byte-exact copy of the minimax/MCTS engine the puzzle
editor was running** as of this session (root `hexuki.wasm` + `hexuki.js`,
commit `0ec26fd`).

**Why it's preserved separately:** the C++ *source* that produced this binary no
longer exists in the repo (it was overwritten before the initial commit). So this
binary is the ONLY copy of that engine version. It is the "old / fast" minimax:
on the test position it explores ~1209 nodes (vs ~2030 for the current source
build), but it predates a correctness fix and may give non-deterministic scores
on some positions. See the BUGFIX comment in `c++engine/src/ai/minimax.cpp:198-212`.

- `hexuki.wasm` — 198,106 bytes, sha256 9959B5C4…
- `hexuki.js`   — web-only glue (ENVIRONMENT=web; will NOT load under Node)

## Restore it to the editor

If we ever deploy a new engine to root and you want the original back:

```powershell
Copy-Item bench\original-engine\hexuki.wasm,bench\original-engine\hexuki.js . -Force
```

Or from git (it's also committed at 0ec26fd and on both remotes):

```powershell
git checkout 0ec26fd -- hexuki.wasm hexuki.js
```

Then hard-refresh the editor (Ctrl+F5). This binary is safe in four places:
this folder, the live root files, git history, and both GitHub remotes.
