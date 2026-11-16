#!/bin/sh
# Debug: check which REST endpoints Instagram web still answers. Requires a running server with INSTAGRAM_MCP_DEBUG=1.
# Usage: sh scripts/check-endpoints.sh <user_id> <media_pk>
UID_="${1:-71928311841}"
PK="${2:-}"
run() {
  printf '%s %s %s\n   ' "$1" "$2" "$3"
  node dist/index.js raw "$1" "$2" "$3" 400 | tr -s ' \n' ' ' | cut -c1-330
  echo
}
run GET "https://i.instagram.com/api/v1/users/web_profile_info/" '{"username":"natgeo"}'
run GET "/api/v1/web/search/topsearch/" '{"context":"blended","query":"coffee shop","include_reel":"false"}'
run GET "/api/v1/feed/user/$UID_/" '{"count":3}'
run GET "/api/v1/direct_v2/inbox/" '{"limit":5,"thread_message_limit":2}'
run GET "/api/v1/tags/web_info/" '{"tag_name":"travel"}'
run GET "/api/v1/friendships/$UID_/followers/" '{"count":12}'
run GET "/api/v1/news/inbox/" '{}'
run GET "/api/v1/feed/reels_media/" "{\"reel_ids\":\"$UID_\"}"
run GET "/api/v1/discover/chaining/" "{\"target_id\":\"$UID_\"}"
run GET "/api/v1/feed/saved/posts/" '{}'
if [ -n "$PK" ]; then
  run GET "/api/v1/media/$PK/info/" '{}'
  run GET "/api/v1/media/$PK/comments/" '{"can_support_threading":"true"}'
  run GET "/api/v1/media/$PK/likers/" '{}'
fi
