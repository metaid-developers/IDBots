#!/bin/bash
set -e

# IDBots metabot-post-buzz: Send SimpleBuzz to MetaWeb via local RPC gateway.
# Requires: jq, curl. Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).

CONTENT=''
CONTENT_TYPE='text/plain;utf-8'

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --content)
      CONTENT="$2"
      shift 2
      ;;
    --content-type)
      CONTENT_TYPE="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Parameter validation: --content must not be empty
if [[ -z "$CONTENT" ]]; then
  echo "Error: --content is required and must not be empty." >&2
  echo "Usage: bash post-buzz.sh --content \"<content>\" [--content-type \"<mime-type>\"]" >&2
  exit 1
fi

# Environment check: IDBOTS_METABOT_ID must exist
if [[ -z "${IDBOTS_METABOT_ID:-}" ]]; then
  echo "Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually." >&2
  exit 1
fi

METABOT_ID="${IDBOTS_METABOT_ID}"
if ! [[ "$METABOT_ID" =~ ^[0-9]+$ ]] || [[ "$METABOT_ID" -lt 1 ]]; then
  echo "Error: IDBOTS_METABOT_ID must be a positive integer." >&2
  exit 1
fi

RPC_URL="${IDBOTS_RPC_URL:-http://127.0.0.1:31200}"

# Step 2: Use jq to safely construct SimpleBuzz payload JSON (avoids Bash special-char issues)
PAYLOAD_JSON=$(jq -n \
  --arg content "$CONTENT" \
  --arg ctype "$CONTENT_TYPE" \
  '{content: $content, contentType: $ctype, attachments: [], quotePin: ""}')

# Step 3: Use jq to construct the full request body (MetaID 7-tuple + metabot_id)
BODY=$(jq -n \
  --argjson metabot_id "$METABOT_ID" \
  --arg payload "$PAYLOAD_JSON" \
  '{
    metabot_id: $metabot_id,
    metaidData: {
      operation: "create",
      path: "/protocols/simplebuzz",
      encryption: "0",
      version: "1.0",
      contentType: "application/json",
      payload: $payload
    }
  }')

# Send POST request
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${RPC_URL}/api/metaid/create-pin"
