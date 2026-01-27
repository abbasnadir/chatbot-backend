```mermaid
flowchart TD
    START["Start"]

    %% Design Flow
    START --> 1["Call API"]
    1 --> 2["Get response from Gemini"]
    2 --> END["End"]
```