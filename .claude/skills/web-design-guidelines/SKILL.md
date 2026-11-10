---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance (Vercel). Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel (vercel-labs/agent-skills), lokal angepasst
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Prüft Dateien gegen die Web Interface Guidelines von Vercel.

Die Regeln liegen lokal in `guidelines.md` (Stand: 2026-11-10, Quelle:
vercel-labs/web-interface-guidelines, command.md). Sie werden bewusst NICHT
bei jedem Aufruf aus dem Netz nachgeladen, damit sich der Inhalt nicht
ungeprüft ändern kann.

## Ablauf

1. `guidelines.md` in diesem Ordner lesen.
2. Angegebene Dateien lesen (sonst nachfragen, welche).
3. Alle Regeln anwenden.
4. Ergebnisse im dort beschriebenen Format `datei:zeile` ausgeben.
