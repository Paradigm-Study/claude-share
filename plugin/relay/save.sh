#!/bin/sh
# A room's file, saved in this project's own .shared-session/ and nowhere else.
#
#   save.sh <project> <folder> <name> [exclude]     (curl's settings on stdin)
#
# <folder> is a place inside <project>/.shared-session/ (`Sam`,
# `Sam/page-1a2b3c4d/img`). .shared-session and each part of the folder are
# made here when missing, one at a time, and each must be a folder, never a
# link: a name a room chose (`..`) or a link someone left there (a project's
# own, committed) takes the file nowhere else, and nothing is made outside.
# The file is downloaded beside its place and renamed over it, which replaces a
# link there instead of writing through it. `exclude` also keeps
# .shared-session/ out of the project's git.
#
# Exit 0 saved; 1 failed; 3 a folder or name that isn't one, or a link on the
# way; 4 a folder in the file's place.
root=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit 1
name=$3
case "$name" in '' | . | .. | */*) exit 3 ;; esac
d=$root/.shared-session
set -f
IFS=/
for part in '' $2; do
  case "$part" in . | ..) exit 3 ;; esac
  [ -n "$part" ] && d=$d/$part
  [ -L "$d" ] && exit 3
  [ -d "$d" ] || mkdir -- "$d" 2>/dev/null || exit 1
done
unset IFS
set +f
real=$(cd -P -- "$d" && pwd -P) || exit 1
case "$real/" in "$root/.shared-session/"*) ;; *) exit 3 ;; esac
if [ "$4" = exclude ]; then
  f=$(cd -- "$1" && git rev-parse --git-path info/exclude 2>/dev/null) && {
    case "$f" in /*) ;; *) f="$1/$f" ;; esac
    mkdir -p -- "$(dirname -- "$f")" && { grep -qxF '.shared-session/' "$f" 2>/dev/null || echo '.shared-session/' >> "$f"; }
  }
fi
t=$(mktemp "$real/.download.XXXXXX") || exit 1
trap 'rm -f "$t"' EXIT
curl -K - -f -o "$t" || exit 1
[ -d "$real/$name" ] && exit 4
mv -f -- "$t" "$real/$name"
