#!/usr/bin/env bash
# Regression test for lib-env.sh: accepted values must match `docker compose config`, unsupported ones must fail.
#   scripts/test-lib-env.sh        (needs docker compose and python3)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/ok.env" <<'EOF'
A=./data   # first # second
B="alpha\"beta"
C=pa#ss word!&x
D="x # not a comment" # real comment
E='~/.ssh/key#1'
F=  # leading-space comment
G='lit $HOME ${X}'
H="dollar \$ ok\\end"
export I=  spaced value
J=https://kuma.example/api/push/abc?status=up&msg=OK&ping=
K=#x
L=
N="tab\tnl\ncr\rend"
EOF
printf 'M=crlf\r\n' >> "$T/ok.env"
KEYS="A B C D E F G H I J K L M N"
{ printf 'services:\n  t:\n    image: alpine\n    environment:\n'; for k in $KEYS; do printf '      %s: ${%s}\n' "$k" "$k"; done; } > "$T/compose.yml"
docker compose --env-file "$T/ok.env" -f "$T/compose.yml" config --format json \
  | python3 -c "import json,sys; e=json.load(sys.stdin)['services']['t']['environment']
for k in sys.argv[1:]: print(k, repr(e[k].replace('\$\$', '\$')))" $KEYS > "$T/want"
( . "$HERE/lib-env.sh"; load_env "$T/ok.env" $KEYS
  for k in $KEYS; do python3 -c "import os,sys; print(sys.argv[1], repr(os.environ[sys.argv[1]]))" "$k"; done ) > "$T/got"
diff "$T/want" "$T/got" && echo "ok: $(wc -l < "$T/got") values match docker compose"

fails=0
for bad in 'P=$HOME/x' 'P=a${B}c' 'P="a$b"' 'P="unterminated' "P='unterminated" 'P="a"b' \
           'P="abc\qdef"' 'P="abc\adef"' 'P="abc\' 'P="abc\"'; do
  printf '%s\n' "$bad" > "$T/bad.env"
  if ( . "$HERE/lib-env.sh"; load_env "$T/bad.env" P ) 2>/dev/null; then echo "FAIL: accepted $bad"; fails=1; fi
done
[ "$fails" = 0 ] && echo "ok: unsupported syntax is rejected"
exit "$fails"
