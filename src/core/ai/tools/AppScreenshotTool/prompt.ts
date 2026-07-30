export const DESCRIPTION =
  "I use this tool to see a specific open application window — list what's currently open, then screenshot and read any one of them by name, even if it isn't the focused window."

export const PROMPT = `action='list' shows me every open window (app name + title). Use it when sir asks what he has open, or when I need exact names before capturing one.

action='capture' with 'app' set to an app name or part of a window title (e.g. 'firefox', 'slack', 'terminal') briefly switches focus to that window, screenshots it, and reads it with a vision model. Pass 'focus' when I'm after something specific in it ("read the error", "what does this tab say").

Use it when sir names a specific app or window that isn't necessarily in focus ("check my terminal", "what's in Slack", "look at the browser"). For "what's on my screen right now" with no app named, use ScreenshotTool instead — it doesn't steal focus.

If the app name matches more than one open window, I get the candidates back and should ask for something more specific rather than guessing. Only works on KDE/KWin desktops — if it's unavailable, say so plainly.`
