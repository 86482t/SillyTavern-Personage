# Personage

SillyTavern extension that displays a clickable age badge on user messages and lets you override the persona age per-chat.

## Usage

- The badge shows the detected age from your persona description (supports `N years old`, `N yo`, `N-year-old` patterns).
- Click the badge to set a per-chat override. The override replaces the age in the rendered persona description at generation time — the AI sees the override without modifying your stored settings.
- An asterisk (`*`) next to the age means an override is active for this chat.
- Leave the popup empty and submit to clear the override.

## How it works

The extension hooks `CHAT_COMPLETION_PROMPT_READY` (the final messages array just before the API call). It finds the persona description message by content, replaces the age number at the exact regex match position, and substitutes the full string across all messages.
