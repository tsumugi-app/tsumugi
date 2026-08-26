# Tsumugi Architecture

Version: 1.0

---

# Overview

Tsumugi is a **Local-First Personal Memory OS**.

Its architecture is designed around one central principle:

> AI is replaceable.  
> User memories are not.

The application is built so that the user's memories remain the primary asset, independent of any specific AI provider.

---

# Design Principles

1. Local First
2. User owns all data
3. AI is stateless
4. Memory is persistent
5. Everything is searchable
6. Simple UI over feature-rich UI

---

# System Architecture

```
                UI Layer
        (React + TypeScript)

                │
                ▼

        Conversation Layer
      (Chat / Personas / Input)

                │
                ▼

          Memory Engine
────────────────────────────────
Capture
Connect
Create
────────────────────────────────

        │              │

        ▼              ▼

 Markdown Storage     Metadata(JSON)

        │              │

        └──────┬───────┘
               ▼

          IndexedDB

               │

               ▼

       Retrieval Engine

               │

               ▼

        AI Provider Layer

   Claude
   Gemini
   OpenAI
   Local LLM
```

---

# Layer Responsibilities

## UI Layer

Responsibilities

- Chat interface
- Search
- Memory list
- Settings

Must never contain business logic.

---

## Conversation Layer

Responsible for

- Sending prompts
- Receiving responses
- Streaming text
- Persona selection

No memory processing occurs here.

---

## Memory Engine

The heart of Tsumugi.

Responsibilities

### Capture

Convert conversations into structured memories.

### Connect

Detect relationships between memories.

### Create

Generate insights using connected memories.

---

## Storage Layer

Human-readable format

Markdown

Machine-readable format

JSON

Both represent the same memory.

---

## Retrieval Engine

Never send the entire memory database to AI.

Instead:

User Question

↓

Local Search

↓

Relevant Memories

↓

AI Context

↓

Answer

---

# Memory Object

Each conversation becomes a Memory Object.

Contains:

- Date
- Conversation
- Summary
- Keywords
- Themes
- People
- Emotions
- Links
- Metadata

---

# Markdown Structure

Example

# 2026-07-25

Summary

Today I explored a new product idea.

Keywords

- AI
- Memory
- Startup

Related

[[AI]]
[[Startup]]

---

# JSON Structure

Used internally.

Example

{
  summary,
  keywords,
  themes,
  people,
  emotions,
  links
}

---

# Search Strategy

Priority

1. Exact keyword

2. Linked memories

3. Semantic similarity

4. AI reasoning

---

# AI Layer

The AI never owns memory.

Its role is only to

- summarize
- organize
- connect
- inspire

The memory remains inside Tsumugi.

---

# Scalability

Designed to support

- 100,000+ memories
- Multiple AI providers
- Offline-first operation
- Future cloud sync

without changing the core architecture.

---

# Guiding Rule

When architecture decisions are difficult,
protect the user's memories before adding new features.