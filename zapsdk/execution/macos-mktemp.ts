/** Apple's default/-t mode prefers confstr(_CS_DARWIN_USER_TEMP_DIR) over
 * TMPDIR. Supply -p only for implicit templates; explicit paths and user
 * supplied -p options retain their native meaning and sandbox checks. */
export const MACOS_MKTEMP_SHIM = `#!/bin/sh
uses_implicit_template() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --) shift; [ "$#" -eq 0 ]; return ;;
      --directory|--quiet|--dry-run) ;;
      --tmpdir|--tmpdir=*|-p*) return 1 ;;
      --*) return 1 ;;
      -?*)
        flags=\${1#-}
        while [ -n "$flags" ]; do
          flag=\${flags%"\${flags#?}"}
          flags=\${flags#?}
          case "$flag" in
            d|q|u) ;;
            p) return 1 ;;
            t)
              if [ -z "$flags" ]; then
                shift
                [ "$#" -gt 0 ] || return 1
              fi
              flags=
              ;;
            *) return 1 ;;
          esac
        done
        ;;
      *) return 1 ;;
    esac
    shift
  done
  return 0
}
if [ -n "\${TMPDIR:-}" ] && uses_implicit_template "$@"; then
  exec /usr/bin/mktemp -p "$TMPDIR" "$@"
fi
exec /usr/bin/mktemp "$@"
`;
