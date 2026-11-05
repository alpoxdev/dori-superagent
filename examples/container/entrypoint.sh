#!/bin/sh
set -eu

# dori-superagent container entrypoint: start the herdr server, then run the
# container's command. Panes are hosted by the server, so they are reachable from any
# `docker exec -it` session. nohup keeps the server alive past the exec below.

# herdr learns omp's state (idle, working, blocked) from an omp extension. It lives in ~/.omp, a volume,
# so it is (re)installed on every start; the install is idempotent.
herdr integration install omp >/dev/null

nohup herdr server >/dev/null 2>&1 </dev/null &

exec "$@"
