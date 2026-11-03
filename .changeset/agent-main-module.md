---
"@openfilm/desktop": patch
---

Windows: DeepSeek Harness installed with npm starts in the chat. The app's own Node now starts an agent's program as the main module, as Node would, so a program that runs only when it is the main one (DeepSeek Harness's `dsh`) no longer exits at once without a word.
