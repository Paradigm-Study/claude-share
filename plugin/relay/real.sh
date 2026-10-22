#!/bin/sh
# Where each path really is, links followed, one a line, in order:
#
#   real.sh <path>...
#
# A path that doesn't exist yet is the real path of the nearest folder above
# it that does, and the rest as written. Exit 1 when one can't be told: a
# dangling link on the way, or no realpath here.
for p in "$@"; do
  rest=
  while [ ! -e "$p" ]; do
    [ -L "$p" ] && exit 1
    case "$p" in /) exit 1 ;; esac
    rest="/${p##*/}$rest"
    p=${p%/*}
    [ -n "$p" ] || p=/
  done
  q=$(realpath "$p" 2>/dev/null) || exit 1
  printf '%s%s\n' "${q%/}" "$rest"
done
