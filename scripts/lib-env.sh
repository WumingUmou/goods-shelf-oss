# shellcheck shell=bash
# Read selected KEY=VALUE pairs from a .env file without `source` (values such as URLs contain '&'
# and would otherwise run as shell). Supports the common subset of Docker Compose's .env syntax and
# refuses anything else, so a script never continues with a value that Compose would read differently:
#   • blank lines and lines starting with # are ignored; an optional leading `export ` is allowed
#   • KEY=value      unquoted: ends at the first # that follows whitespace; surrounding spaces trimmed
#                    (`pa#ss` stays `pa#ss`, `./data   # a # b` becomes `./data`)
#   • KEY='value'    single-quoted: taken literally (# and $ are kept)
#   • KEY="value"    double-quoted: \" \\ \$ \n \t \r escapes; `$` must be escaped as \$
#   • after a closing quote only whitespace and an optional # comment may follow
# Not supported (error): ${VAR} / $VAR interpolation in unquoted or double-quoted values, multi-line values.
# Usage: load_env FILE KEY1 KEY2 …   → exports the listed keys that are present; returns 1 on a bad line
load_env() {
  local file=$1; shift
  [ -f "$file" ] || return 0
  local line key val rest out c i n=0 want hit closed err
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"                      # ltrim
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == export[[:space:]]* ]]; then line="${line#export}"; line="${line#"${line%%[![:space:]]*}"}"; fi
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"; key="${key%"${key##*[![:space:]]}"}"
    hit=
    for want in "$@"; do [ "$key" = "$want" ] && hit=1; done
    [ -n "$hit" ] || continue

    val="${line#*=}"; val="${val#"${val%%[![:space:]]*}"}"
    out= rest= err=
    case "$val" in
      \'*)
        rest="${val:1}"
        if [[ "$rest" == *\'* ]]; then out="${rest%%\'*}"; rest="${rest#*\'}"
        else err="unterminated single quote (multi-line values are not supported)"; fi
        ;;
      \"*)
        closed=
        for ((i = 1; i < ${#val}; i++)); do
          c="${val:i:1}"
          if [ "$c" = "\\" ]; then
            i=$((i + 1)); c="${val:i:1}"
            case "$c" in
              n) out+=$'\n' ;; t) out+=$'\t' ;; r) out+=$'\r' ;;
              '"' | '\' | '$') out+="$c" ;;
              '') err="unterminated double quote (multi-line values are not supported)"; break ;;
              *) err="unsupported escape \\$c in a double-quoted value (only \\\" \\\\ \\\$ \\n \\t \\r; or use single quotes)"; break ;;
            esac
          elif [ "$c" = '"' ]; then closed=1; rest="${val:i+1}"; break
          elif [ "$c" = '$' ]; then err="unescaped \$ in a double-quoted value (write \\\$, or use single quotes)"; break
          else out+="$c"; fi
        done
        [ -n "$closed$err" ] || err="unterminated double quote (multi-line values are not supported)"
        ;;
      *)
        out="${val%%[[:space:]]#*}"                               # cut at the first whitespace-then-#
        out="${out%"${out##*[![:space:]]}"}"
        [[ "$out" == *'$'* ]] && err="\$ in an unquoted value (variable interpolation is not supported; use single quotes)"
        ;;
    esac
    if [ -z "$err" ] && [[ ! "$rest" =~ ^[[:space:]]*(#.*)?$ ]]; then err="unexpected text after the closing quote"; fi
    if [ -n "$err" ]; then
      echo "$file:$n: $key: $err" >&2
      return 1
    fi
    export "$key=$out"
  done < "$file"
}
