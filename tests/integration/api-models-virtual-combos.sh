#!/bin/bash
# Integration test: verify zero-config auto/* virtual combos appear in /v1/models.
# Run after deploy: bash tests/integration/api-models-virtual-combos.sh [port]
set -eu

PORT="${1:-20128}"
BASE="http://localhost:${PORT}/v1/models"
HEADERS=(-H "Authorization: Bearer test" -H "Content-Type: application/json")

# Default to LLM kind — virtual combos only surface in the LLM response.
RESP=$(curl -s "${HEADERS[@]}" "${BASE}" 2>/dev/null || echo '{"data":[]}')

EXPECTED=("auto/best-coding" "auto/best-reasoning" "auto/best-fast" "auto/best-vision" "auto/best-free" "auto/cheap")
MISSING=()

for m in "${EXPECTED[@]}"; do
  if ! printf '%s' "$RESP" | grep -q "\"id\":\"$m\""; then
    MISSING+=("$m")
  fi
done

if [ ${#MISSING[@]} -ne 0 ]; then
  echo "FAIL — virtual combos missing from /v1/models: ${MISSING[*]}"
  echo "---- response sample (first 2000 chars) ----"
  printf '%s' "$RESP" | head -c 2000
  echo
  exit 1
fi

# Verify each virtual entry has the expected metadata
for m in "${EXPECTED[@]}"; do
  ENTRY=$(printf '%s' "$RESP" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
      try{ const j=JSON.parse(d); const e=(j.data||[]).find(x=>x.id==='$m');
        if(!e){console.error('no entry');process.exit(1);}
        if(e.isCombo!==true){console.error('isCombo not true');process.exit(2);}
        if(e.owned_by!=='auto-combo'){console.error('owned_by wrong: '+e.owned_by);process.exit(3);}
        if(!Array.isArray(e.comboMembers)){console.error('comboMembers not array');process.exit(4);}
        if(typeof e.comboMemberCount!=='number'){console.error('comboMemberCount not number');process.exit(5);}
        console.log('ok');
      }catch(e){console.error('json: '+e.message);process.exit(99);}
    });")
  if [ "$ENTRY" != "ok" ]; then
    echo "FAIL — metadata wrong for $m: $ENTRY"
    exit 1
  fi
done

echo "PASS — all 6 auto/* virtual combos present with correct metadata in /v1/models"
