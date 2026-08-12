# DEVAI security patch provenance

This is a locally vendored build of `image-size` for the DEVAI documentation
site. Upstream `2.0.2` is the base (`032c3347b86f09a2e16449e17537cf5e1009520c`).
The build includes these archived upstream pull-request commits:

- `bdbe560bfd98af6feab93b46aed67f2f0a77e4d5` — advance past zero-sized
  JXL/HEIF boxes.
- `0f6a6665a166c530ba126a8ab8608a0603cb49dc` — advance past zero-sized ICNS
  entries.

The source commits were cherry-picked onto the base and built with the
upstream Yarn 4.0.2 lockfile and `yarn build`. Only the published package
surface (`dist`, `bin`, README, and MIT license) is vendored here. The local
version is `2.0.3-devai.1`; it must be removed once upstream publishes an npm
release containing both fixes.
