---
"openfilm": patch
---

Exports: a video whose browser crashed or stopped answering is drawn once more in a new one, as an editing project's pages already were. A page or a file the browser could not load for want of the system's network buffers (`net::ERR_NO_BUFFER_SPACE`, seen on Windows) is drawn again too, instead of failing the export.
