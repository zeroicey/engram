# Architecture

> Single file by design. Frontend + backend + infra live here; split only when a reader needs
> fewer than ~200 lines to answer "where does X live?".

## 1. Purpose

<!-- One paragraph: what this system does, for whom, and what it deliberately does not do. -->

## 2. Stack

| Layer | Technology | Version | Why this one |
| --- | --- | --- | --- |
| Frontend |  |  |  |
| Backend |  |  |  |
| Data |  |  |  |
| Infra |  |  |  |

## 3. Repository map

<!-- Only directories that own a responsibility. One line each: path → responsibility → owner. -->

| Path | Responsibility | Touches |
| --- | --- | --- |
| `src/` | | |

## 4. Core topology

```text
entry → handler → service → repository → store
```

<!-- Describe the 2–4 critical flows and where they enter the system. -->

## 5. Invariants

<!-- Rules that must hold for the system to be correct. Each one testable. -->

1. …

## 6. Boundaries and known debts

<!-- What is deliberately not abstracted yet, and the trigger that would change that. -->
