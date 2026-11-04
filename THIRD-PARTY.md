# Third-party material

`dsh-session-suite` itself is MIT licensed (see [LICENSE](LICENSE)). It bundles
one third-party data file, listed here with its licence and provenance.

## `lib/data/jieba-dict.txt`

A Chinese word list used for word-boundary segmentation on the retrieval path. It
is derived from **jieba**'s `extra_dict/dict.txt.small`.

- Upstream: <https://github.com/fxsjy/jieba> (`extra_dict/dict.txt.small`)
- Licence: MIT — Copyright (c) 2013 Sun Junyi
- What was changed: the frequency and part-of-speech columns were dropped, so the
  file holds one word per line; duplicate entries were removed. No words were
  added, removed, or edited.
- Size: 109,750 entries, ~920 KB
- Regenerate with: `node tools/fetch-jieba-dict.mjs` (add `--force` to refetch)

The file is a lookup table loaded once per process. It is never sent to a model
and adds nothing to prompt size or per-turn token cost.

### jieba's MIT licence

```
The MIT License (MIT)

Copyright (c) 2013 Sun Junyi

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Design influences, not code

Two third-party DSH plugins were read while designing the long-term memory
features. **No code was copied from either**, and neither is a dependency.

- [`dsh-fish-memory`](https://github.com/Yuuyuko-uu/dsh-fish-memory) — its licence
  is a custom, non-OSI "Yuuyuko-uu 插件许可 1.0" that permits use and
  modification but requires attribution on redistribution, so it is source for
  ideas only. The resident-memory-layer idea (durable facts get their own small
  quota instead of competing with question-matched entries) and the practice of
  telling the user *why* a memory was not recalled both come from reading it.
  The word-list segmentation approach it demonstrated is what motivated adopting
  jieba's MIT word list here.
- [`dsh-context`](https://github.com/bowenliang123/dsh-context) — Apache-2.0.
  Read to confirm the two plugins do not collide on any slot, tool, or route.

Coinage of the word list, the retrieval fusion, and every line of this bundle
are original to this project.
