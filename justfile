# pioneer-home task runner. `just` alone runs check + test.
set dotenv-load := true
set shell := ["zsh", "-cu"]

pi := env_var_or_default("PI_HOST", "pi@raspberrypi.local")
remote := env_var_or_default("PI_DIR", "/opt/pioneer-home")
# Your own house config lives in tables/ and scenarios/ (gitignored). Without it the example config is used.
config := if path_exists(justfile_directory() + "/tables") == "true" { justfile_directory() } else { justfile_directory() + "/example" }
tables := config + "/tables"
scenarios := config + "/scenarios"

default: check test

# Install JS dependencies
install:
    pnpm install

# Validate every table (tables/, or example/tables/ when you have none)
check:
    pnpm --filter engine exec tsx src/cli.ts check --tables {{tables}}

# Unit tests + every scenarios/*.tsv
test:
    pnpm --filter engine test

# Typecheck the engine
typecheck:
    pnpm --filter engine typecheck

# Run the engine against a fake clock: just simulate --at 2026-09-23T21:00 --set bedroom.climate.temperature=19 --advance 1m
simulate *ARGS:
    pnpm --filter engine exec tsx src/cli.ts simulate --tables {{tables}} {{ARGS}}

# Run scenario tables (all by default): just scenario scenarios/fan_curve.tsv -v
scenario *ARGS:
    pnpm --filter engine exec tsx src/cli.ts scenario --tables {{tables}} {{scenarios}} {{ARGS}}

# Evaluate a formula: just eval 'BETWEEN(TIME(), 19:30, 06:00)' --at 2026-09-23T21:00
eval *ARGS:
    pnpm --filter engine exec tsx src/cli.ts eval --tables {{tables}} {{ARGS}}

# Normalise TSV files (tabs, trimmed cells, LF)
fmt:
    pnpm --filter engine exec tsx src/cli.ts fmt --tables {{tables}}

# Print the dependency graph
graph:
    pnpm --filter engine exec tsx src/cli.ts graph --tables {{tables}}

# Build engine and web for deployment
build:
    pnpm --filter engine build
    if [ -f web/package.json ]; then pnpm --filter web build; fi

# Run the engine locally against the real broker on the Pi (needs an SSH tunnel or MQTT_URL)
dev:
    pnpm --filter engine dev

# --- Pi -------------------------------------------------------------------------------------

# Build a self-contained engine bundle (dist + production node_modules) into dist-deploy/engine
bundle:
    pnpm --filter engine build
    rm -rf dist-deploy/engine
    pnpm --filter engine deploy --prod --legacy dist-deploy/engine
    rm -rf dist-deploy/engine/src dist-deploy/engine/test

# Copy the engine bundle, tables, web and deploy files to the Pi and restart the engine
deploy: check test bundle
    test -d tables || { echo "no tables/ (only the example config): refusing to deploy"; exit 1; }
    if [ -f web/package.json ]; then pnpm --filter web build || echo "web build failed, deploying without UI"; fi
    ssh {{pi}} 'sudo mkdir -p {{remote}} && sudo chown pi:pi {{remote}}'
    rsync -az --delete dist-deploy/engine/ {{pi}}:{{remote}}/engine/
    rsync -az --delete --exclude .git tables/ {{pi}}:{{remote}}/tables/
    ssh {{pi}} 'cd {{remote}}/tables && git add -A && git -c user.name=deploy -c user.email=deploy@pioneer-home commit -qm "deploy from $(hostname -s)" || true'
    rsync -az --delete scenarios/ {{pi}}:{{remote}}/scenarios/
    rsync -az --delete deploy/ {{pi}}:{{remote}}/deploy/
    rsync -az --delete --exclude .venv gpio/ {{pi}}:{{remote}}/gpio/
    if [ -d web/dist ]; then ssh {{pi}} 'mkdir -p {{remote}}/web/dist' && rsync -az --delete web/dist/ {{pi}}:{{remote}}/web/dist/; fi
    rsync -az CLAUDE.md README.md justfile {{pi}}:{{remote}}/
    ssh {{pi}} 'sudo systemctl restart pioneer-engine && sleep 2 && systemctl is-active pioneer-engine'

# Fetch tables edited through the UI on the Pi into the working copy (then review with git diff and commit)
pull-tables:
    rsync -az --exclude .git --exclude '*.tmp' {{pi}}:{{remote}}/tables/ tables/
    if [ -d tables/.git ]; then git -C tables status --short; fi

# Tables only: hot reloaded by the running engine, no restart. Refuses when tables/ has uncommitted changes,
# because it first pulls UI edits from the Pi (which would overwrite them).
deploy-tables:
    test ! -d tables/.git || test -z "$(git -C tables status --porcelain)" || { echo "commit your table changes in tables/ first (deploy-tables pulls UI edits from the Pi)"; exit 1; }
    just pull-tables
    just check test
    rsync -az --delete --exclude .git tables/ {{pi}}:{{remote}}/tables/
    ssh {{pi}} 'cd {{remote}}/tables && git add -A && git -c user.name=deploy -c user.email=deploy@pioneer-home commit -qm "deploy from $(hostname -s)" || true'
    rsync -az --delete scenarios/ {{pi}}:{{remote}}/scenarios/

# Follow engine logs on the Pi
logs *ARGS:
    ssh {{pi}} 'journalctl -u pioneer-engine -f --no-pager {{ARGS}}'

# Live cell values from the engine on the Pi
state:
    ssh {{pi}} 'curl -s localhost:8000/api/state' | jq

# Dry-run report from the Pi: what the engine would have sent vs what the devices did
dryrun:
    ssh {{pi}} "curl -s 'localhost:8000/api/dryrun?format=text'"

# Open a shell on the Pi
ssh:
    ssh {{pi}}
