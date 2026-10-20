# Third-party notices

The root CLI and SDK use MIT; `zapvm/` retains Apache-2.0 and its
[NOTICE](zapvm/NOTICE). Dependencies retain their respective licenses.

The exact JavaScript dependency versions are recorded in `bun.lock`; Go
dependencies are recorded in `zapvm/go.mod` and `zapvm/go.sum`. These manifests
are inventories, not substitutes for license texts. Standalone binaries bundle
Bun and JavaScript dependencies, including native components. Release maintainers
must inventory the actual shipped components and include required attribution,
license texts, and source offers before distributing them.

The npm source package includes its UI dependency closure and each dependency's
license text. `bundled-dependencies.json` in the candidate records package
versions, declared licenses, and hashes of the included notices. The upstream
`yoga-layout@3.2.1` npm tarball omitted its MIT license; the candidate supplies
the original [v3.2.1 license](https://github.com/facebook/yoga/blob/v3.2.1/LICENSE)
from [the retained notice](third_party/yoga-layout/LICENSE).

VM image distributions additionally follow
[zapvm/THIRD_PARTY_NOTICES.md](zapvm/THIRD_PARTY_NOTICES.md): inspect the image's
SPDX SBOM and satisfy corresponding-source requirements. Do not publish an image
with unknown licenses or missing required notices/source.

## Modified Ink component

`patches/ink@7.1.1.patch` modifies Ink's terminal cursor rendering. Ink is MIT
licensed. Its upstream copyright and permission notice are retained below.

MIT License

Copyright (c) Vadym Demedes <vadimdemedes@hey.com> (https://github.com/vadimdemedes)
Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Watch browser animation

The offline Watch page embeds Motion 14.3.0 (MIT), including Framer Motion,
motion-dom and motion-utils. Their copyright and full MIT notices, together
with tslib's 0BSD license, are retained in the generated `src/watch/client.html`
and therefore travel with both the npm source package and the standalone CLI.
Versions are pinned by `bun.lock`; `bun run build:watch` regenerates the asset.

The sandbox Node fetch proxy preload embeds Undici 7.30.1 (MIT), from
https://github.com/nodejs/undici. Its full license is retained inside
`zapsdk/execution/node-proxy-preload.generated.ts`, including in the standalone
CLI and npm source package. `bun run build:node-proxy` regenerates it from the
pinned development dependency; `bun run check:node-proxy` checks freshness.

## Retained notice for prior ISC-licensed source

The following copyright and permission notice is retained for source previously
distributed under ISC. The current root project license is [MIT](LICENSE); this
change does not remove the notices applicable to that source.

ISC License

Copyright (c) 2026 zapAgent contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
