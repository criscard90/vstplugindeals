# Aggiornamento esterno dei deal (cron esterno → `workflow_dispatch`)

## Perché

Lo trigger `schedule` della workflow *Aggiorna Deal VST* (`cron: '7 * * * *'`) è
**best-effort**: GitHub non lo esegue in modo affidabile. Costatato il 7/10/2026 —
dalla messa a orearie (29/9) erano previste ~179 run orarie, ne sono partite 33 (~18%),
tutte con ritardi da 1 a 8 ore (es. run #34 partita alle 03:24 invece delle 03:07,
poi 6 scatti consecutivi saltati).

La soluzione è un **cron esterno affidabile** che chiama la *stessa* workflow
tramite l'endpoint REST `workflow_dispatch`:

```
POST https://api.github.com/repos/criscard90/vstplugindeals/actions/workflows/369892153/dispatches
```

Lo `schedule` interno **resta attivo come backup**: il blocco `concurrency` della
workflow impedisce run parallele e una doppia esecuzione è innocua (se non ci sono
nuovi deal, nessun commit viene fatto).

## Passo 1 — Crea il token (PAT)

1. Su GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. *Repository access*: **Only select repositories** → `criscard90/vstplugindeals`.
3. *Permissions → Repository permissions*: **Actions → Read and write** (è il permesso richiesto dall'endpoint `.../dispatches`).
4. Scadenza: 90 giorni o 1 anno (al rinnovo basta aggiornare il token nel servizio cron).
5. Copia il token (`github_pat_...`). **Non committarlo e non scriverlo nel codice.**

Alternativa (PAT classica): token con scope `repo` — l'endpoint dichiede
"You must authenticate using an access token with the `repo` scope" (GitHub Apps: `actions:write`).

## Passo 2 — Crea il cron esterno (esempio con cron-job.org)

Servizi gratuiti compatibili: [cron-job.org](https://cron-job.org) (consigliato),
easy-cron, Hookrelay, oppure un Uptime Kuma in self-hosting. Impostazioni del job:

| Campo | Valore |
| --- | --- |
| URL | `https://api.github.com/repos/criscard90/vstplugindeals/actions/workflows/369892153/dispatches` |
| Method | `POST` |
| Payload (body JSON) | `{"ref":"main"}` |
| Header 1 | `Authorization: Bearer <IL-TUO-TOKEN>` |
| Header 2 | `Accept: application/vnd.github+json` |
| Header 3 | `Content-Type: application/json` |
| Schedule (cron) | `7 * * * *` (ogni ora al minuto :07) |

Note:

- `369892153` è l'ID della workflow, ma puoi usare anche il nome file: `.../workflows/update-deals.yml/dispatches`.
- Mantieni il minuto **:07** così il trigger esterno e quello interno coincidono:
  se GitHub dovesse partire col suo `schedule`, la coppia viene serializzata dal
  blocco `concurrency` e la seconda esecuzione non produce commit.
- Risposta attesa: **HTTP 204 No Content**. Imposta sul servizio cron la notifica
  per risposte non-2xx così ti avvisa se il token scade.

## Passo 3 — Verifica

1. Attendi il primo scatto (alle :07), poi apri la tab **Actions** di GitHub:
   deve comparire una run con evento `workflow_dispatch`.
2. Da terminale (il repo contiene già `.gh-api.ps1`):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\.gh-api.ps1 runs
   ```
3. Oppure prova l'endpoint a mano:
   ```bash
   curl -i -X POST \
     -H "Authorization: Bearer <IL-TUO-TOKEN>" \
     -H "Accept: application/vnd.github+json" \
     -d '{"ref":"main"}' \
     https://api.github.com/repos/criscard90/vstplugindeals/actions/workflows/369892153/dispatches
   ```

## Risoluzione problemi

| Sintomo | Causa probabile | Rimedio |
| --- | --- | --- |
| HTTP 401 | header `Authorization` mancante, malformato o token scaduto | usa esattamente `Bearer <token>`; rigenera il token |
| HTTP 403 | permessi insufficienti | fine-grained: **Actions → Read and write** sul repo; classica: scope `repo` |
| HTTP 404 | workflow ID errato o token senza accesso al repo | usa il nome file `update-deals.yml`; controlla *Repository access* del PAT |
| HTTP 422 | `ref` inesistente o workflow senza trigger `workflow_dispatch` | body `{"ref":"main"}`; il file deve essere sul branch di default |
| HTTP 204 ma nessuna run | ref su branch sbagliato o run in coda | verifica che `main` sia il branch di default, riprova tra qualche minuto |
| Doppie run (schedule + dispatch) | entrambi gli trigger hanno partito | OK: `concurrency` le serializza, la seconda non committa nulla |

## Sicurezza

- Il token vive **solo** nei header del servizio cron, mai nel repository.
- PAT fine-grained limitata a un solo repo + permesso `Actions write`: il danno
  potenziale in caso di fuga è minimo.
- Ruota il token alla scadenza e aggiorna il campo del servizio cron.
