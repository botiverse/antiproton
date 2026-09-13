# Whether a production deploy may ship this commit. Sourced, and kept apart from
# the git and network calls around it so a test can make it go red.
#
# The answer is "only origin/master itself", not "anything master contains".
# State in production moves one way: stored rows are rewritten forward by the
# code that reads them, so an older commit that is merged and green can still
# meet data it no longer understands. Rolling back is a revert merged to master,
# then a deploy of that. A preview deploy (--config wrangler.preview.jsonc) may
# ship any branch.
#
# deploy_refusal HEAD_SHA MASTER_SHA [deploy args...]
#   prints nothing when the deploy may go ahead, and the reason when it may not.
deploy_refusal() {
  local head="$1" master="$2"
  shift 2
  case " $* " in *wrangler.preview.jsonc*) return 0;; esac
  if [ "$head" != "$master" ]; then
    echo "refusing to deploy: HEAD ${head:0:7} is not origin/master (${master:0:7})."
    echo "Production ships the current master only; merge first, or use --config wrangler.preview.jsonc for a branch."
  fi
}
