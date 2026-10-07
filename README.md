# LSY NAT Track archive

A small scheduled job that keeps a **history of the North Atlantic Organised Track System (NAT OTS)
messages** as the FAA publishes them, so that the tracks of every day of a week can be drawn later.
The FAA page only ever shows the current track sets; this repository keeps each one.

> **Not for operational use.** This is an unofficial copy of public FAA data for analysis and briefing
> purposes. For flight planning use the official NAT track message (NOTAM) from the FAA or NAV CANADA /
> NATS and your approved sources.

## How it works

```
GitHub Actions, scheduled 05:30 and 17:00 UTC every day (and on demand)
  scripts/capture-nat.js ──GET──► https://nms.aim.faa.gov/datanat/nat.json
         │ writes only when the message changed
         ▼
  archive/YYYY/MM/DD-HHMM.json    one capture: the FAA records, unchanged
  archive/YYYY/MM/index.json      what each capture of that month holds (sets, validity)
  archive/state.json              the last capture, for the change check
```

| Set | Published by the FAA | Valid |
|---|---|---|
| Eastbound (Gander, CZQX) | around 13:20 UTC | the following night, about 01:00–08:00 UTC |
| Westbound (Shanwick, EGGX) | around 20:40 UTC | the next day, about 11:30–19:00 UTC |

Two runs a day see every set at least once. A capture is written **only when the content changed**
(the signature is the sorted list of NOTAM number, part and last-updated time of all records), so
quiet periods add no files.

GitHub starts scheduled runs late at busy times (minutes, sometimes hours) and very rarely skips one;
the capture time in the file name is the real time of the run. GitHub also disables scheduled
workflows in public repositories after 60 days without repository activity — re-enable it under
**Actions → NAT track capture** if that happens.

## File formats

**`archive/YYYY/MM/DD-HHMM.json`** — one capture

| Field | Content |
|---|---|
| `capturedAt` | time of the run (UTC, ISO 8601) |
| `source` | the FAA URL that was read |
| `signature` | change-check key (NOTAM number \| part \| last updated, per record) |
| `parts` | the FAA track-message records exactly as published (one record per NOTAM part) |

**`archive/YYYY/MM/index.json`** — one entry per capture of the month:
`{ file, capturedAt, sets: [{ icao, notam, from, to, parts, lastUpdated }] }` — `icao` is CZQX (eastbound)
or EGGX (westbound), `from`/`to` the validity of the set.

**`archive/state.json`** — `{ signature, file, checkedAt }` of the last capture written.

Reading a week: take the `index.json` of the month(s), pick the captures whose sets are valid on the
days you need, and read the track definitions from their `parts`.

## Run it yourself

```
node scripts/capture-nat.js                    # writes into ./archive
NAT_ARCHIVE_DIR=/some/dir node scripts/capture-nat.js
```

Node 20 or newer, no dependencies. A temporary error (network, HTTP 5xx, malformed JSON) is reported as a
GitHub Actions warning and the job still ends successfully, so a single bad run does not turn the
workflow red; the missing capture simply stays missing.

## Source and licence

The track messages are published by the **US Federal Aviation Administration** (NOTAM system,
`nms.aim.faa.gov`). As a work of the US Government they are in the **public domain**. The capture
requests carry a generic User-Agent and nothing about the person running them. This repository adds no
data of its own beyond the capture time and the change-check signature.
