# Tsumugi Requirements

Version: 0.1

---

# 1. Overview

Tsumugi is an AI-powered personal memory application.

The system allows users to have natural conversations with AI and transforms those conversations into structured personal knowledge.

The first version focuses on proving the core experience:

"Talking with AI creates valuable personal memories."

---

# 2. MVP Goal

The MVP goal is not feature quantity.

The goal is to validate one experience:

A user talks with AI,
the conversation is saved,
and later the user can rediscover value from past conversations.

---

# 3. Functional Requirements

## 3.1 AI Conversation

Priority: P0 (Essential)

Users can communicate with AI through a chat interface.

Requirements:

- Text input
- AI response display
- Conversation history display
- Timestamp recording

---

## 3.2 Local Data Storage

Priority: P0

All user data should be stored locally.

Requirements:

- IndexedDB storage
- Offline access support
- No mandatory account registration
- Data export capability planned

---

## 3.3 Memory Creation

Priority: P0

Every conversation should become a memory object.

A memory contains:

- Date
- Original conversation
- Summary
- Tags
- Keywords

---

## 3.4 Markdown Export

Priority: P1

Memory data should be convertible into Markdown format.

Example:



---

## 3.5 Memory Search

Priority: P1

Users can search previous memories.

Search types:

- Keyword search
- Date search
- Theme search

---

## 3.6 AI Reflection

Priority: P1

Users can ask AI questions about their memories.

Examples:

"Have I thought about this before?"

"What patterns appear in my ideas?"

"What themes repeat in my life?"

---

# 4. AI Processing Requirements

## 4.1 Memory Analysis

After conversation:

AI may extract:

- Summary
- Keywords
- Themes
- Important concepts

---

## 4.2 Retrieval System

The system should avoid sending all memories to AI.

Required approach:

User question

↓

Local search

↓

Relevant memories

↓

AI processing

↓

Answer

---

# 5. User Interface Requirements

## Main Screens

---

## 5.1 Chat Screen

Purpose:

Primary interaction.

Features:

- Conversation view
- Text input
- Persona selection

---

## 5.2 Memory List Screen

Purpose:

View accumulated memories.

Features:

- Timeline display
- Search
- Filtering

---

## 5.3 Memory Detail Screen

Purpose:

Review individual memories.

Features:

- Original conversation
- AI summary
- Tags
- Related memories

---

# 6. AI Persona Requirements

Initial personas:

## Companion

Purpose:

Emotional support.

Style:

- Warm
- Understanding
- Encouraging


---

## Coach

Purpose:

Growth support.

Style:

- Question-based
- Goal-oriented


---

## Analyst

Purpose:

Objective reflection.

Style:

- Logical
- Pattern-focused

---

# 7. Non-Functional Requirements

## Privacy

Priority: Highest

- Local-first
- Minimal external storage
- Clear user ownership

---

## Performance

The app should remain usable with:

- Hundreds of memories
- Thousands of chat messages

---

## Portability

The user should be able to export their data.

---

# 8. Out of Scope for MVP

Do not implement initially:

- Social features
- User profiles
- Public sharing
- Photo analysis
- Voice input
- Cloud synchronization
- Subscription system

---

# 9. Future Features

Possible extensions:

- Photo memories
- Voice journaling
- Life timeline
- AI-generated yearly review
- Goal tracking
- Multiple AI models
- Mobile native app

---

# 10. MVP Completion Criteria

MVP is complete when:

1. User can talk with AI.

2. Conversation is saved locally.

3. User can search past conversations.

4. AI can use past memories to answer questions.

5. User feels:

"This AI understands my journey."