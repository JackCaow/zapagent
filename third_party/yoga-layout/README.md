# Yoga Layout 3.2.1 notice

The `yoga-layout@3.2.1` npm tarball declares MIT and its source headers refer to
the repository's root LICENSE, but that file is absent from the npm payload.
`LICENSE` here is copied verbatim from the matching upstream tag:

https://raw.githubusercontent.com/facebook/yoga/v3.2.1/LICENSE

The npm packer includes it alongside that exact bundled dependency version.
It does not change the root ISC license or the independent VM's Apache-2.0
license. New dependency versions require checking their own notices.
