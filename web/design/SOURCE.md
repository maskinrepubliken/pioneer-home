# Designsystem: Maskinrepubliken

Källan är designsystemet på ett privat Claude-artifact (Artifact av typen Design System).
Filerna här är kopior av `project/tokens.json`, `project/README.md`, `project/10-perforering.md`, `project/20-eink.md`
och `project/components/bundle.css` (som referens för hur komponenterna är stilade där). Kopierade 2026-09-24.

`web/src/tokens.css` genereras ur `tokens.json` med `pnpm --filter web tokens` (skriptet `web/scripts/tokens.mjs`).
Ändra aldrig `tokens.css` för hand: uppdatera `tokens.json` (hämta en ny kopia från designsystemet) och kör skriptet igen.

Teman: `paper` (standard), `ink` (mörkt, via `prefers-color-scheme: dark` eller `data-theme="ink"`), `eink` (`data-theme="eink"`).
